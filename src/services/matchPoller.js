// === Imports ===
// This service orchestrates polling Riot for match updates and sending Discord updates.

import {
    getGuildTftConfig,
    getKnownGuildIds,
    getLolIdentity,
    getLolTracking,
    getTftIdentity,
    getTftTracking,
    loadDb,
    upsertGuildAccountInStore,
} from '../storage.js';

import {
    getLolRankByPuuid,
    getLolMatch,
    getLolMatchIdsByPuuid,
    getLolActiveGameByPuuid,
    getTftActiveGameByPuuid,
    getTFTMatch,
    getTFTMatchIdsByPuuid,
    getTFTRankByPuuid,
} from '../riot.js';

import {
    buildMatchResultEmbed,
    detectQueueMetaFromMatch,
    normalizePlacement,
 } from '../utils/tft.js';

import {
    buildLolLiveGameEmbed,
    buildLolMatchResultEmbed,
    detectLolQueueMetaFromMatch,
} from '../utils/lol.js';

import {
    computeRankSnapshotDeltas,
    toRankSnapshot,
} from '../utils/rankSnapshot.js';

import {
    DEFAULT_ANNOUNCE_QUEUES,
    GAME_TYPES,
    isRankedQueueForGame,
    LOL_QUEUE_TYPES,
    mapRiotLolQueueType, 
    RANKED_QUEUES_BY_GAME,
    TFT_QUEUE_TYPES,
} from '../constants/queues.js';

import { createRiotRateLimiter } from '../utils/rateLimiter.js';
import { sleep } from '../utils/utils.js';
import config from '../config.js';

// === Polling configuration ===
// Limit how far back we look for unseen matches to bound API usage.
const MATCH_BACKFILL_LIMIT = 10;

const SPECTATOR_CHECK_COOLDOWN_MS = 0.5 * 60 * 1000;
const LIVE_ANNOUNCE_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

function getLolInGameDedupeKey(tracking = {}) {
    if (tracking?.activeGameId != null) return `gid:${String(tracking.activeGameId)}`;
    const start = tracking?.activeGameStartTime;
    const queue = tracking?.activeQueueId;
    if (start != null && queue != null) return `start:${String(start)}:queue:${String(queue)}`;
    return null;
}

function buildInGameTransitionPatch({ tracking, nextTracking, game, guildId, accountKey }) {
    const wasInGame = tracking?.inGame === true;
    const isInGame = nextTracking?.inGame === true;

    if (!wasInGame && isInGame) {
        const now = Date.now();
        const previousDedupeKey = game === GAME_TYPES.LOL ? getLolInGameDedupeKey(tracking) : null;
        const nextDedupeKey = game === GAME_TYPES.LOL ? getLolInGameDedupeKey(nextTracking) : null;
        const sameLolGame = game === GAME_TYPES.LOL && Boolean(nextDedupeKey) && nextDedupeKey === previousDedupeKey;
        if (!sameLolGame) {
            console.log(`[match-poller] match started guild=${guildId} account=${accountKey} game=${game} dedupeKey=${nextDedupeKey ?? 'none'}`);
            return {
                lastAnnouncedActiveGameId: nextTracking?.activeGameId ?? null,
                lastInGameAnnouncementAt: now,
            };
        }
    }

    if (wasInGame && !isInGame) {
        console.log(`[match-poller] match ended guild=${guildId} account=${accountKey} game=${game}`);
    }

    return {};
}

async function probeSpectatorState({ riotLimiter, account, tracking, game }) {
    const now = Date.now();
    const lastCheckedAt = Number(tracking?.lastSpectatorCheckAt ?? 0);
    const wasInGame = tracking?.inGame === true;
    if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt < SPECTATOR_CHECK_COOLDOWN_MS) {
        console.log(`Skipping spectator check for account ${account.key} - cooldown in effect`);
        return { inGame: wasInGame, lastSpectatorCheckAt: lastCheckedAt, };
    }

    const identity = game === GAME_TYPES.LOL ? getLolIdentity(account) : getTftIdentity(account);
    if (!identity?.puuid) return { inGame: false, lastSpectatorCheckAt: now };

    const fetcher = game === GAME_TYPES.LOL ? getLolActiveGameByPuuid : getTftActiveGameByPuuid;
    try {
        const activeGame = await fetcher({ platform: account.platform, puuid: identity.puuid, limiter: riotLimiter });
        console.log(`Probed spectator state for account ${account.key}: inGame=${Boolean(activeGame)}`);
        return { 
            inGame: Boolean(activeGame), 
            lastSpectatorCheckAt: now,
            activeGameId: activeGame?.gameId ?? null,
            activeQueueId: activeGame?.gameQueueConfigId ?? null,
            activeGameStartTime: activeGame?.gameStartTime ?? null,
            activeGame,
        };
    } catch (err) {
        if (Number(err?.status) === 404) return { inGame: false, lastSpectatorCheckAt: now, activeGameId: null, activeQueueId: null, activeGameStartTime: null };
        console.log(`Error probing spectator state for account ${account.key}`, err);
        return { inGame: wasInGame, lastSpectatorCheckAt: now };
    }
}

// === Rank refresh logic ===
// Determine whether cached rank data is stale enough to refresh.
function shouldRefreshRank(account, now, maxAgeMs, gameType = GAME_TYPES.TFT) {
    const tracking = gameType === GAME_TYPES.LOL ? getLolTracking(account) : getTftTracking(account);
    if (!tracking?.lastRankByQueue) return true;
    const entries = Object.values(tracking.lastRankByQueue);
    if (entries.length === 0) return true;
    return entries.some((entry) => {
        const lastUpdatedAt = Number(entry?.lastUpdatedAt ?? 0);
        return !Number.isFinite(lastUpdatedAt) || now - lastUpdatedAt >= maxAgeMs;
    });
}

// === Riot fetch helpers ===
// Wrap Riot calls so we always respect the rate limiter.
async function fetchMatch({ riotLimiter, account, matchId, game }) {
    if (game === GAME_TYPES.TFT) {
        return getTFTMatch({ 
            regional: account.regional, 
            matchId,
            limiter: riotLimiter,
        });
    }
    if (game === GAME_TYPES.LOL) {
    return getLolMatch({
            regional: account.regional,
            matchId,
            limiter: riotLimiter,
        });
    }
    throw new Error(`[match-poller] Unsupported game type: ${String(game)}`);
}

async function fetchMatchIds({ riotLimiter, account, count, start = 0, game }) {
    const identity = game === GAME_TYPES.LOL ? getLolIdentity(account) : getTftIdentity(account);
    const fetchByGame = game === GAME_TYPES.LOL ? getLolMatchIdsByPuuid : getTFTMatchIdsByPuuid;
    return fetchByGame({
        regional: account.regional,
        puuid: identity.puuid,
        count,
        start,
        limiter: riotLimiter,
    });
}

// === Match discovery ===
// Build a list of match IDs that are newer than the last seen match.
function collectUnseenMatchIds({ ids, lastMatchId, unseenMatchIds, limit }) {
    let foundLast = false;

    for (const id of ids) {
        if (id === lastMatchId) {
            foundLast = true;
            break;
        }
        unseenMatchIds.push(id);
        if (unseenMatchIds.length >= limit) {
            break;
        }
    }

    return { unseenMatchIds, foundLast };
}

async function detectUnseenMatchIds({ tracking, matchBackfillLimit, fetchMatchIdsByAccount}) {
    // If we have never seen a match for this account, fetch just one ID to seed it.
    if (!tracking?.lastMatchId) {
        const ids = await fetchMatchIdsByAccount({ count: 1, start: 0 });
        return Array.isArray(ids) ? ids.slice(0, 1) : [];
    }

    let unseenMatchIds = [];
    let start = 0;
    let foundLast = false;

    while (unseenMatchIds.length < matchBackfillLimit && !foundLast) {
        const remaining = matchBackfillLimit - unseenMatchIds.length;
        const count = Math.min(20, remaining);
        const ids = await fetchMatchIdsByAccount({ count, start });
        if (!Array.isArray(ids) || ids.length === 0) {
            break;
        }

        ({ unseenMatchIds, foundLast } = collectUnseenMatchIds({
            ids,
            lastMatchId: tracking.lastMatchId,
            unseenMatchIds,
            limit: matchBackfillLimit,
        }));

        if (foundLast || ids.length < count) {
            break;
        }

        start += ids.length;
    }

    return unseenMatchIds;
}

// === Rank snapshot refresh ===
// Convert Riot's raw league entries into our normalized snapshot format.
async function refreshRankSnapshot({ riotLimiter, account }) {
    const tftIdentity = getTftIdentity(account);
    const entries = await getTFTRankByPuuid({
        platform: account.platform,
        puuid: tftIdentity.puuid,
        limiter: riotLimiter,
    });
    return toRankSnapshot(entries);
}

async function refreshLolRankSnapshot({ riotLimiter, account }) {
    const lolIdentity = getLolIdentity(account);
    const entries = await getLolRankByPuuid({
        platform: account.platform,
        puuid: lolIdentity.puuid,
        limiter: riotLimiter,
    });
    const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => {
        const mappedQueueType = mapRiotLolQueueType(entry?.queueType);
        return mappedQueueType ? { ...entry, queueType: mappedQueueType } : entry;
    });

    return toRankSnapshot(normalizedEntries, {
        rankedQueues: new Set(RANKED_QUEUES_BY_GAME[GAME_TYPES.LOL]),
    });
}

// === Recap event buffer ===
// Track a rolling window of recent ranked matches for recap summaries.
function buildRecapEvents({ recapEvents, matchId, queueType, delta, placement, gameMs }) {
    const already = recapEvents.some((event) => event.matchId === matchId);
    if (already) return recapEvents;

    const nextEvents = [
        ...recapEvents,
        {
            matchId,
            at: gameMs,
            queueType,
            delta: Number(delta ?? 0),
            placement: Number(placement ?? 0),
        },
    ];
    return nextEvents.sort((a, b) => b.at - a.at).slice(0, 250);
}

// === Discord announcement ===
// Build an embed and post it in the configured channel (if any).
async function announceGameMatchToDiscord({ buildEmbed, ...context }) {
    const { channel, guildId, channelId } = context;
    if (!channel) {
        console.log(
            `[match-poller] no channel for guild=${guildId} (channelId=${channelId ?? "null"})`
        );
        return;
    }
    const { embed, files } = await buildEmbed(context);
    await channel.send({ embeds: [embed], files });
}

function findLatestRankedIndex(matches, { shouldInclude = () => true } = {}) {
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const candidate = matches[i];
        if (candidate?.isRanked && shouldInclude(candidate)) {
            return i;
        }
    }
    return -1;
}

// === Service entry point ===
// Polls periodically for new matches and sends announcements.
export async function startMatchPoller(client) {
    const intervalSeconds = config.matchPollIntervalSeconds;
    const basePerAccountDelayMs = config.matchPollPerAccountDelayMs;
    const riotLimiter = createRiotRateLimiter({ perSecond: 20, perTwoMinutes: 100 });
    const rankRefreshMinutes = config.rankRefreshIntervalMinutes;
    const rankRefreshMs = rankRefreshMinutes * 60 * 1000;
    let isTickRunning = false;

    // One polling iteration. Split out to make the setInterval handler simple.
    const tick = async () => {
        if (isTickRunning) return;

        isTickRunning = true;
        try {
            const channelCache = new Map(); // channelId -> channel (cache per tick)
            const pendingUpsertsByGuild = new Map();

            const stageTrackingUpsert = ({ guildId, account, gameKey, trackingPatch }) => {
                const accountKey = `${guildId}:${account.key}`;
                const current = pendingUpsertsByGuild.get(accountKey) ?? account;
                const currentTracking = gameKey === 'lol' ? getLolTracking(current) : getTftTracking(current);
                pendingUpsertsByGuild.set(accountKey, {
                    ...current,
                    trackedGames: {
                        ...(current.trackedGames ?? {}),
                        [gameKey]: {
                            ...currentTracking,
                            ...trackingPatch,
                        },
                    },
                });
            };

            const db = await loadDb();
            const guildIds = getKnownGuildIds(db);
            if (guildIds.length === 0) return;
        
            const totalAccounts = guildIds.reduce((sum, guildId) => {
                const accounts = db[guildId]?.accounts ?? [];
                return sum + accounts.length;
            }, 0);

            const intervalMs = intervalSeconds * 1000;
            const spreadDelayMs = totalAccounts > 0 ? Math.ceil(intervalMs / totalAccounts) : 0;
            const perAccountDelayMs = Math.max(basePerAccountDelayMs, spreadDelayMs);

            for (const guildId of guildIds) {
                const guild = Object.freeze(db[guildId] ?? {});
                const accounts = guild?.accounts ?? [];
                const channelIdForGuild = guild?.channelId ;
                const guildTftConfig = getGuildTftConfig(db, guildId);
                const seasonCutoffMs = Number(guildTftConfig?.seasonCutoffMs ?? 0);
                const hasSeasonCutoff = Number.isFinite(seasonCutoffMs) && seasonCutoffMs > 0;

                let channel = null;
                if (channelIdForGuild) {
                    if (channelCache.has(channelIdForGuild)) {
                        channel = channelCache.get(channelIdForGuild);
                    } else {
                        // Cache the channel per tick to avoid repeated fetch calls.
                        try {
                            channel = await client.channels.fetch(channelIdForGuild);
                        } catch (err) {
                            console.error(`Error fetching channel ${channelIdForGuild} for guild ${guildId}:`, err);
                            channel = null;
                        }
                        channelCache.set(channelIdForGuild, channel);
                    }
                }

                for (const account of accounts) {
                    const lolIdentity = getLolIdentity(account);
                    const tftIdentity = getTftIdentity(account);
                    const lolTracking = getLolTracking(account);
                    const tftTracking = getTftTracking(account);
                    const canPollLol = Boolean(lolIdentity?.puuid) && lolTracking?.enabled === true;
                    const canPollTft = Boolean(tftIdentity?.puuid) && tftTracking?.enabled === true;
                    const refreshedRankSnapshotsByGame = {
                        [GAME_TYPES.LOL]: null,
                        [GAME_TYPES.TFT]: null,
                    };
                    if (!account?.regional || !account?.platform || !account?.key) {
                        await sleep(perAccountDelayMs);
                        continue;
                    }
                    
                    try {
                        const now = Date.now();
                        if (canPollLol && shouldRefreshRank(account, now, rankRefreshMs, GAME_TYPES.LOL)) {
                            try {
                                const refreshedLol = await refreshLolRankSnapshot({ riotLimiter, account });
                                refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = refreshedLol;

                                stageTrackingUpsert({
                                    guildId,
                                    account,
                                    gameKey: 'lol',
                                    trackingPatch: { lastRankByQueue: refreshedLol },
                                });

                                lolTracking.lastRankByQueue = refreshedLol;
                            } catch (err) {
                                console.error(
                                    `Error refreshing LoL rank for account ${account.key} (guild=${guildId}):`,
                                    err
                                );
                            }
                        }

                        if (canPollTft && shouldRefreshRank(account, now, rankRefreshMs, GAME_TYPES.TFT)) {
                            try {
                                const refreshed = await refreshRankSnapshot({ riotLimiter, account });
                                refreshedRankSnapshotsByGame[GAME_TYPES.TFT] = refreshed;

                                stageTrackingUpsert({
                                    guildId,
                                    account,
                                    gameKey: 'tft',
                                    trackingPatch: { lastRankByQueue: refreshed },
                                });
                                tftTracking.lastRankByQueue = refreshed;
                            } catch (err) {
                                console.error(
                                    `Error refreshing rank for account ${account.key} (guild=${guildId}):`,
                                    err
                                );
                            }
                        }
                    
                    const lolSpectatorState = canPollLol
                        ? await probeSpectatorState({ riotLimiter, account, tracking: lolTracking, game: GAME_TYPES.LOL })
                        : null;
                    const tftSpectatorState = canPollTft
                        ? await probeSpectatorState({ riotLimiter, account, tracking: tftTracking, game: GAME_TYPES.TFT })
                        : null;

                    const announceQueues = guild?.announceQueues ?? DEFAULT_ANNOUNCE_QUEUES;
                    
                    if (canPollLol && lolSpectatorState) {
                        const nextLolTracking = {
                            ...lolTracking,
                            inGame: lolSpectatorState.inGame ?? false,
                            activeGameId: lolSpectatorState.activeGameId ?? null,
                            activeQueueId: lolSpectatorState.activeQueueId ?? null,
                            activeGameStartTime: lolSpectatorState.activeGameStartTime ?? null,
                        };
                        const lolTransitionPatch = buildInGameTransitionPatch({
                            tracking: lolTracking,
                            nextTracking: nextLolTracking,
                            game: GAME_TYPES.LOL,
                            guildId,
                            accountKey: account.key,
                        });

                        const wasLolInGame = lolTracking?.inGame === true;
                        const isLolInGame = lolSpectatorState.inGame === true;
                        const previousAnnouncedGameId = lolTracking?.lastAnnouncedActiveGameId ?? null;
                        const nextActiveGameId = lolSpectatorState.activeGameId ?? null;
                        const announcedThisGame = previousAnnouncedGameId != null
                            && nextActiveGameId != null
                            && String(previousAnnouncedGameId) === String(nextActiveGameId);
                        const lastInGameAnnouncementAt = Number(lolTracking?.lastInGameAnnouncementAt ?? 0);
                        const announcedRecently = Number.isFinite(lastInGameAnnouncementAt)
                            && lastInGameAnnouncementAt > 0
                            && (Date.now() - lastInGameAnnouncementAt) < LIVE_ANNOUNCE_DEDUPE_WINDOW_MS;
                        const shouldAnnounceLolLiveGame = !wasLolInGame
                            && isLolInGame
                            && !announcedThisGame
                            && !announcedRecently;

                        if (shouldAnnounceLolLiveGame && lolSpectatorState.activeGame) {
                            await announceGameMatchToDiscord({
                                buildEmbed: buildLolLiveGameEmbed,
                                channel,
                                guildId,
                                channelId: channelIdForGuild,
                                account,
                                activeGame: lolSpectatorState.activeGame,
                            });
                        }
                        
                        stageTrackingUpsert({
                            guildId,
                            account,
                            gameKey: 'lol',
                            trackingPatch: {
                                inGame: lolSpectatorState.inGame ?? false,
                                lastSpectatorCheckAt: lolSpectatorState.lastSpectatorCheckAt ?? Date.now(),
                                activeGameId: lolSpectatorState.activeGameId ?? null,
                                activeQueueId: lolSpectatorState.activeQueueId ?? null,
                                activeGameStartTime: lolSpectatorState.activeGameStartTime ?? null,
                                ...lolTransitionPatch,
                            },
                        });
                    }
                    if (canPollTft && tftSpectatorState) {
                        const nextTftTracking = {
                            ...tftTracking,
                            inGame: tftSpectatorState.inGame ?? false,
                            activeGameId: tftSpectatorState.activeGameId ?? null,
                            activeQueueId: tftSpectatorState.activeQueueId ?? null,
                            activeGameStartTime: tftSpectatorState.activeGameStartTime ?? null,
                        };
                        const tftTransitionPatch = buildInGameTransitionPatch({
                            tracking: tftTracking,
                            nextTracking: nextTftTracking,
                            game: GAME_TYPES.TFT,
                            guildId,
                            accountKey: account.key,
                        });
                        stageTrackingUpsert({
                            guildId,
                            account,
                            gameKey: 'tft',
                            trackingPatch: {
                                inGame: tftSpectatorState.inGame ?? false,
                                lastSpectatorCheckAt: tftSpectatorState.lastSpectatorCheckAt ?? Date.now(),
                                activeGameId: tftSpectatorState.activeGameId ?? null,
                                activeQueueId: tftSpectatorState.activeQueueId ?? null,
                                activeGameStartTime: tftSpectatorState.activeGameStartTime ?? null,
                                ...tftTransitionPatch,
                            },
                        });
                    }

                    if (canPollLol) {
                        const unseenLolMatchIds = await detectUnseenMatchIds({
                            tracking: lolTracking,
                            matchBackfillLimit: MATCH_BACKFILL_LIMIT,
                            fetchMatchIdsByAccount: ({ count, start }) =>
                                fetchMatchIds({ riotLimiter, account, count, start, game: GAME_TYPES.LOL }),
                        });

                        if (unseenLolMatchIds.length > 0) {
                            const orderedLolMatchIds = [...unseenLolMatchIds].reverse();
                            const beforeLol = lolTracking.lastRankByQueue ?? {};
                            let afterLol = beforeLol;
                            let lolRecapEvents = Array.isArray(lolTracking.recapEvents)
                                ? lolTracking.recapEvents
                                : [];
                            let lastProcessedLolMatchId = lolTracking.lastMatchId;
                            let lastProcessedLolMatchAt = Number(lolTracking.lastMatchAt ?? 0) || null;
                            const preparedLolMatches = [];

                            for (const matchId of orderedLolMatchIds) {
                                const match = await fetchMatch({
                                    riotLimiter,
                                    account,
                                    matchId,
                                    game: GAME_TYPES.LOL,
                                });
                                const participants = match?.info?.participants ?? [];
                                const me = participants.find((p) => p.puuid === lolIdentity.puuid);

                                const meta = detectLolQueueMetaFromMatch(match);
                                const rawQueueType = meta.queueType || LOL_QUEUE_TYPES.UNKNOWN;
                                const queueType = mapRiotLolQueueType(rawQueueType) ?? rawQueueType;
                                const isRanked = isRankedQueueForGame(GAME_TYPES.LOL, queueType);
                                const gameMs = Number(match?.info?.gameEndTimestamp ?? 0)
                                    || Number(match?.info?.gameCreation ?? 0)
                                    || Date.now();

                                preparedLolMatches.push({
                                    matchId,
                                    me,
                                    participants,
                                    queueType,
                                    isRanked,
                                    gameMs,
                                });
                            }

                            const latestLolRankedIndex = findLatestRankedIndex(preparedLolMatches);

                            for (const [index, prepared] of preparedLolMatches.entries()) {
                                const { matchId, me, participants, queueType, isRanked, gameMs } = prepared;
                                const isLatestRankedMatch = index === latestLolRankedIndex;
                                if (isLatestRankedMatch) {
                                    const memoizedRankSnapshot = refreshedRankSnapshotsByGame[GAME_TYPES.LOL];
                                    if (memoizedRankSnapshot) {
                                        afterLol = memoizedRankSnapshot;
                                    } else {
                                        try {
                                            afterLol = await refreshLolRankSnapshot({ riotLimiter, account });
                                            refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = afterLol;
                                        } catch {
                                            // ignore refresh failure for delta calc
                                        }
                                    }
                                }

                                const deltas = computeRankSnapshotDeltas({ before: beforeLol, after: afterLol });
                                const afterRank = isLatestRankedMatch ? (afterLol?.[queueType] ?? null) : null;
                                const delta = isLatestRankedMatch ? (deltas?.[queueType] ?? 0) : 0;
                                
                                if (isRanked) {
                                    const placement = me?.win ? 1 : 2;
                                    lolRecapEvents = buildRecapEvents({
                                        recapEvents: lolRecapEvents,
                                        matchId,
                                        queueType,
                                        delta,
                                        placement,
                                        gameMs,
                                    });
                                }

                                const shouldAnnounce = !announceQueues || announceQueues.includes(queueType);
                                if (!shouldAnnounce) {
                                    console.log(
                                        `[match-poller] skipping LoL announcement for guild=${guildId} account=${account.key} match=${matchId} queue=${queueType} (not in announceQueues)`
                                    );
                                    lastProcessedLolMatchId = matchId;
                                    lastProcessedLolMatchAt = gameMs;
                                    continue;
                                }

                                if (me) {
                                    await announceGameMatchToDiscord({
                                        buildEmbed: buildLolMatchResultEmbed,
                                        channel,
                                        account,
                                        matchId,
                                        queueType,
                                        delta,
                                        afterRank,
                                        participant: me,
                                        participants,
                                        gameMs,
                                        guildId,
                                        channelId: channelIdForGuild,
                                    });
                                }

                                if (isRanked) {
                                    console.log(
                                        `[match-poller] NEW LoL match guild=${guildId} ${account.key} match=${matchId} queue=${queueType} delta=${delta}`
                                    );
                                }
                                lastProcessedLolMatchId = matchId;
                                lastProcessedLolMatchAt = gameMs;
                            }

                            stageTrackingUpsert({
                                guildId,
                                account,
                                gameKey: 'lol',
                                trackingPatch: {
                                    lastMatchId: lastProcessedLolMatchId,
                                    lastMatchAt: lastProcessedLolMatchAt,
                                    lastRankByQueue: afterLol,
                                    recapEvents: lolRecapEvents,
                                    inGame: lolSpectatorState?.inGame ?? false,
                                    lastSpectatorCheckAt: lolSpectatorState?.lastSpectatorCheckAt ?? Date.now(),
                                    activeGameId: lolSpectatorState?.activeGameId ?? null,
                                    activeQueueId: lolSpectatorState?.activeQueueId ?? null,
                                    activeGameStartTime: lolSpectatorState?.activeGameStartTime ?? null,
                                },
                            });
                        }
                    }

                    if (!canPollTft) {
                        await sleep(perAccountDelayMs);
                        continue;
                    }

                    // Fetch unseen match IDs, respecting the backfill limit.
                    const unseenMatchIds = await detectUnseenMatchIds({
                        tracking: tftTracking,
                        matchBackfillLimit: MATCH_BACKFILL_LIMIT,
                        fetchMatchIdsByAccount: ({ count, start }) =>
                            fetchMatchIds({ riotLimiter, account, count, start, game: GAME_TYPES.TFT }),
                    });
                    
                    if (unseenMatchIds.length === 0) {
                        await sleep(perAccountDelayMs);
                        continue;
                    }

                    // Process matches from oldest to newest so deltas line up.
                    const orderedMatchIds = [...unseenMatchIds].reverse();
                    const before = tftTracking.lastRankByQueue ?? {};
                    let after = before;
                    let recapEvents = Array.isArray(tftTracking.recapEvents) ? tftTracking.recapEvents : [];
                    let lastProcessedMatchId = tftTracking.lastMatchId;
                    let lastProcessedMatchAt = Number(tftTracking.lastMatchAt ?? 0) || null;

                    const preparedMatches = [];
                    for (const matchId of orderedMatchIds) {
                        const match = await fetchMatch({
                            riotLimiter,
                            account,
                            matchId,
                            game: GAME_TYPES.TFT,
                        });
                        const participants = match?.info?.participants ?? [];
                        const me = participants.find((p) => p.puuid === tftIdentity.puuid);
                        const placement = me?.placement ?? null;
                        
                        const meta = detectQueueMetaFromMatch(match);
                        const queueType = meta.queueType || TFT_QUEUE_TYPES.RANKED;
                        const isRanked = isRankedQueueForGame(GAME_TYPES.TFT, queueType);
                        const normPlacement = normalizePlacement({ placement, queueType }); 
                        const gameMs = Number(match?.info?.game_datetime ?? 0) || Date.now();

                        preparedMatches.push({
                            match,
                            matchId,
                            me,
                            normPlacement,
                            queueType,
                            isRanked,
                            gameMs,
                        });
                    }

                    const latestRankedIndex = findLatestRankedIndex(preparedMatches, {
                        shouldInclude: (preparedMatch) => {
                            const gameMs = Number(preparedMatch?.gameMs ?? 0);
                            return !(
                                hasSeasonCutoff &&
                                Number.isFinite(gameMs) &&
                                gameMs > 0 &&
                                gameMs < seasonCutoffMs
                            );
                        },
                    });

                    for (const [index, prepared] of preparedMatches.entries()) {
                        const {
                            matchId,
                            me,
                            normPlacement,
                            queueType,
                            isRanked,
                            gameMs,
                        } = prepared;
                        const isBeforeSeasonCutoff =
                            hasSeasonCutoff &&
                            Number.isFinite(gameMs) &&
                            gameMs > 0 &&
                            gameMs < seasonCutoffMs;

                        if (isBeforeSeasonCutoff) {
                            console.log(
                                `[match-poller] skipping stale pre-cutoff match guild=${guildId} account=${account.key} match=${matchId} gameMs=${gameMs} cutoffMs=${seasonCutoffMs}`
                            );
                            lastProcessedMatchId = matchId;
                            lastProcessedMatchAt = gameMs;
                            continue;
                        }

                        const isLatestRankedMatch = index === latestRankedIndex;
                        if (isLatestRankedMatch) {
                            const memoizedRankSnapshot = refreshedRankSnapshotsByGame[GAME_TYPES.TFT];
                            if (memoizedRankSnapshot) {
                                after = memoizedRankSnapshot;
                            } else {
                                try {
                                    after = await refreshRankSnapshot({ riotLimiter, account });
                                    refreshedRankSnapshotsByGame[GAME_TYPES.TFT] = after;
                                } catch {
                                    // ignore refresh failure for delta calc
                                }
                            }
                        }

                        const deltas = computeRankSnapshotDeltas({ before, after });
                        
                        const afterRank = isLatestRankedMatch ? (after?.[queueType] ?? null) : null;
                        const delta = isLatestRankedMatch ? (deltas?.[queueType] ?? 0) : 0;
                    
                        // Capture recap data independently of announcement filtering.
                        if (isRanked) {
                            recapEvents = buildRecapEvents({
                                recapEvents,
                                matchId,
                                queueType,
                                delta,
                                placement: normPlacement,
                                gameMs,
                            });
                        }

                        const shouldAnnounce = !announceQueues || announceQueues.includes(queueType);
                        if (!shouldAnnounce) {
                            console.log(
                                `[match-poller] skipping announcement for guild=${guildId} account=${account.key} match=${matchId} queue=${queueType} (not in announceQueues)`
                            );
                            lastProcessedMatchId = matchId;
                            lastProcessedMatchAt = gameMs;
                            continue;
                        }
                    
                        console.log(
                            `[match-poller] NEW match guild=${guildId} ${account.key} match=${matchId} queue=${queueType} place=${normPlacement} delta=${delta}`
                        );

                        await announceGameMatchToDiscord({
                            buildEmbed: buildMatchResultEmbed,
                            channel,
                            account,
                            placement: normPlacement,
                            matchId,
                            queueType,
                            delta,
                            afterRank,
                            participant: me,
                            gameMs,
                            guildId,
                            channelId: channelIdForGuild,
                        });

                        lastProcessedMatchId = matchId;
                        lastProcessedMatchAt = gameMs;
                    }

                    stageTrackingUpsert({
                        guildId,
                        account,
                        gameKey: 'tft',
                        trackingPatch: {
                            // Persist lastMatchId so we only announce new games.
                            lastMatchId: lastProcessedMatchId,
                            lastMatchAt: lastProcessedMatchAt,
                            lastRankByQueue: after,
                            recapEvents,
                            inGame: tftSpectatorState?.inGame ?? false,
                            lastSpectatorCheckAt: tftSpectatorState?.lastSpectatorCheckAt ?? Date.now(),
                            activeGameId: tftSpectatorState?.activeGameId ?? null,
                            activeQueueId: tftSpectatorState?.activeQueueId ?? null,
                            activeGameStartTime: tftSpectatorState?.activeGameStartTime ?? null,
                        },
                    });
            } catch (err) {
                console.error(
                    `Error polling matches for account ${account.key} (guild=${guildId}):`,
                    err
                );
            }
            await sleep(perAccountDelayMs);
            }
            }
            for (const [compoundKey, nextAccount] of pendingUpsertsByGuild.entries()) {
                const [guildId] = compoundKey.split(':');
                await upsertGuildAccountInStore(guildId, nextAccount);
            }
        } finally {
            isTickRunning = false;
        }        
    };

    // Run immediately, then schedule future ticks.
    await tick();
    setInterval(() => {
        tick().catch((error) => console.error('Match poll tick failed: ', error));
    }, Math.max(10, intervalSeconds) * 1000);
}
