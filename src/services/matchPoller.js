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
    getLolMatch,
    getLolMatchIdsByPuuid,
    getTFTMatch,
    getTFTMatchIdsByPuuid,
} from '../riot.js';

import {
    buildMatchResultEmbed,
    buildTftLiveGameEmbed,
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
} from '../utils/rankSnapshot.js';

import {
    DEFAULT_ANNOUNCE_QUEUES,
    GAME_TYPES,
    LOL_QUEUE_TYPES,
    resolveLolQueueContext,
    TFT_QUEUE_TYPES,
    isRankedQueue,
} from '../constants/queues.js';

import { createRiotRateLimiter } from '../utils/rateLimiter.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { buildTierChangeEmbed } from '../utils/matchEmbedShared.js';

import {
    LIVE_ANNOUNCE_DEDUPE_WINDOW_MS,
    getTftFinishedMatchDedupeKey,
    getLolFinishedMatchDedupeKey,
    getLolInGameDedupeKey,
    getTftInGameDedupeKey,
    probeSpectatorState,
} from './matchPoller/spectatorState.js';
import { detectUnseenMatchIds } from './matchPoller/matchDiscovery.js';
import {
    refreshLolRankSnapshot,
    refreshRankSnapshot,
    shouldRefreshRank,
} from './matchPoller/rankRefresh.js';
import { getEligibleLineupMemberSets, recordLolLineupResult } from '../storage/lineups.js';

// === Polling configuration ===
// Limit how far back we look for unseen matches to bound API usage.
const MATCH_BACKFILL_LIMIT = 10;
const MATCH_POLLER_WORKER_COUNT = (() => {
    const configured = Number(process.env.MATCH_POLLER_WORKERS ?? 5);
    if (!Number.isFinite(configured)) return 5;
    return Math.min(10, Math.max(3, Math.floor(configured)));
})();

// Hot-path constants for long-running polling: reuse immutable queue/ranked lookups to reduce per-iteration allocations.
const DEFAULT_ANNOUNCE_QUEUES_SET = new Set(DEFAULT_ANNOUNCE_QUEUES);

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

// === Recap event buffer ===
// Track a rolling window of recent ranked matches for recap summaries.
function compareRecapEventsDesc(left, right) {
    const byTimestamp = Number(right?.at ?? 0) - Number(left?.at ?? 0);
    if (byTimestamp !== 0) return byTimestamp;
    return String(left?.matchId ?? '').localeCompare(String(right?.matchId ?? ''));
}

function findRecapInsertIndex(recapEvents = [], event = {}) {
    for (let i = 0; i < recapEvents.length; i += 1) {
        if (compareRecapEventsDesc(event, recapEvents[i]) < 0) return i;
    }
    return recapEvents.length;
}

function buildRecapEvents({ recapEvents, matchId, queueType, delta, placement, gameMs }) {
    const already = recapEvents.some((event) => event.matchId === matchId);
    if (already) return recapEvents;

    const nextEvent = {
        matchId,
        at: gameMs,
        queueType,
        delta: Number(delta ?? 0),
        placement: Number(placement ?? 0),
    };
    const nextEvents = [...recapEvents, nextEvent].sort(compareRecapEventsDesc);
    if (nextEvents.length > 250) nextEvents.length = 250;
    return nextEvents;
}

// === Discord announcement ===
// Build an embed and post it in the configured channel (if any).
async function announceGameMatchToDiscord({ buildEmbed, ...context }) {
    const { channel, guildId, channelId } = context;
    if (!channel) {
        logger.info(
            `[match-poller] no channel for guild=${guildId} (channelId=${channelId ?? 'null'})`
        );
        return null;
    }
    const { embed, files } = await buildEmbed(context);
    const sentMessage = await channel.send({ embeds: [embed], files });
    return sentMessage ?? null;
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

function reduceLolLiveState({
    previousTracking = {},
    spectatorState = {},
    dedupeWindowMs = LIVE_ANNOUNCE_DEDUPE_WINDOW_MS,
    now = Date.now(),
    guildId,
    accountKey,
}) {
    const nextTrackingPatch = {
        inGame: spectatorState?.inGame ?? previousTracking?.inGame ?? false,
        lastSpectatorCheckAt: spectatorState?.lastSpectatorCheckAt ?? now,
        activeGameId: spectatorState?.activeGameId ?? previousTracking?.activeGameId ?? null,
        activeQueueId: spectatorState?.activeQueueId ?? previousTracking?.activeQueueId ?? null,
        activeGameStartTime: spectatorState?.activeGameStartTime ?? previousTracking?.activeGameStartTime ?? null,
    };
    const nextTracking = {
        ...previousTracking,
        ...nextTrackingPatch,
    };

    const wasLolInGame = previousTracking?.inGame === true;
    const isLolInGame = nextTrackingPatch.inGame === true;
    if (!wasLolInGame && isLolInGame) {
        const previousDedupeKey = getLolInGameDedupeKey(previousTracking);
        const nextDedupeKey = getLolInGameDedupeKey(nextTracking);
        const sameLolGame = Boolean(nextDedupeKey) && nextDedupeKey === previousDedupeKey;
        if (!sameLolGame) {
            logger.info(`[match-poller] match started guild=${guildId} account=${accountKey} game=${GAME_TYPES.LOL} dedupeKey=${nextDedupeKey ?? 'none'}`);
        }
    }
    if (wasLolInGame && !isLolInGame) {
        logger.info(`[match-poller] match ended guild=${guildId} account=${accountKey} game=${GAME_TYPES.LOL}`);
    }

    if (wasLolInGame || !isLolInGame) {
        return { nextTrackingPatch, shouldAnnounceLive: false, debugReason: 'no_live_transition' };
    }

    const previousAnnouncedInGameKey = previousTracking?.lastAnnouncedInGameKey
        ?? getLolInGameDedupeKey({ activeGameId: previousTracking?.lastAnnouncedActiveGameId })
        ?? null;
    const nextInGameKey = getLolInGameDedupeKey(nextTrackingPatch);
    const announcedThisGame = previousAnnouncedInGameKey != null
        && nextInGameKey != null
        && previousAnnouncedInGameKey === nextInGameKey;
    if (announcedThisGame) {
        return { nextTrackingPatch, shouldAnnounceLive: false, debugReason: 'already_announced' };
    }

    const lastInGameAnnouncementAt = Number(previousTracking?.lastInGameAnnouncementAt ?? 0);
    const announcedRecently = Number.isFinite(lastInGameAnnouncementAt)
        && lastInGameAnnouncementAt > 0
        && (now - lastInGameAnnouncementAt) < dedupeWindowMs;
    const cannotDisambiguateGames = previousAnnouncedInGameKey == null || nextInGameKey == null;
    const sameDedupeKey = previousAnnouncedInGameKey != null
        && nextInGameKey != null
        && previousAnnouncedInGameKey === nextInGameKey;
    if (announcedRecently && (cannotDisambiguateGames || sameDedupeKey)) {
        return { nextTrackingPatch, shouldAnnounceLive: false, debugReason: 'recently_announced' };
    }
    Object.assign(nextTrackingPatch, {
        lastAnnouncedInGameKey: nextInGameKey,
        lastAnnouncedActiveGameId: nextTrackingPatch.activeGameId ?? null,
        lastInGameAnnouncementAt: now,
    });

    return { nextTrackingPatch, shouldAnnounceLive: true, debugReason: 'announce_live' };
}

export { buildRecapEvents, compareRecapEventsDesc, findRecapInsertIndex, reduceLolLiveState };

function normalizeRiotId(gameName, tagLine) {
    const game = typeof gameName === 'string' ? gameName.trim().toLowerCase() : '';
    const tag = typeof tagLine === 'string' ? tagLine.trim().toLowerCase() : '';
    if (!game || !tag) return null;
    return `${game}#${tag}`;
}

function buildRegisteredLolLookup(guild = {}) {
    const byPuuid = new Map();
    const byRiotId = new Map();
    const accounts = Array.isArray(guild?.accounts) ? guild.accounts : [];
    for (const registeredAccount of accounts) {
        const identity = getLolIdentity(registeredAccount);
        const canonicalMemberKey = registeredAccount?.key;
        if (!canonicalMemberKey) continue;
        const puuid = typeof identity?.puuid === 'string' ? identity.puuid.trim() : '';
        if (puuid) byPuuid.set(puuid, canonicalMemberKey);
        const normalizedId = normalizeRiotId(identity?.gameName, identity?.tagLine);
        if (normalizedId) byRiotId.set(normalizedId, canonicalMemberKey);
    }
    return { byPuuid, byRiotId };
}

async function pollLolAccountState({ riotLimiter, account, lolTracking, guildId, channel, channelIdForGuild, announceQueueLookup = null }) {
    const areLolAnnouncementsEnabledForAccount = account?.notifications?.lolAnnouncements !== false;
    const lolSpectatorState = await probeSpectatorState({ riotLimiter, account, tracking: lolTracking, game: GAME_TYPES.LOL });
    const liveTransitionDecision = reduceLolLiveState({
        previousTracking: lolTracking,
        spectatorState: lolSpectatorState,
        dedupeWindowMs: LIVE_ANNOUNCE_DEDUPE_WINDOW_MS,
        now: Date.now(),
        guildId,
        accountKey: account.key,
    });
    const shouldAnnounceLolLiveGame = liveTransitionDecision.shouldAnnounceLive === true;

    if (shouldAnnounceLolLiveGame && lolSpectatorState.activeGame) {
        if (!areLolAnnouncementsEnabledForAccount) {
            return {
                lolSpectatorState,
                trackingPatch: liveTransitionDecision.nextTrackingPatch,
            };
        }
        const queueContext = resolveLolQueueContext({
            queueId: lolSpectatorState?.activeGame?.gameQueueConfigId ?? lolSpectatorState?.activeQueueId ?? null,
        });
        const queueType = queueContext?.queueType ?? LOL_QUEUE_TYPES.UNKNOWN;
        const isRankedLiveQueue = isRankedQueue(GAME_TYPES.LOL, queueType);
        const isAllowedByGuildQueueConfig = !announceQueueLookup || announceQueueLookup.has(queueType);
        const shouldAnnounceBasedOnQueue = (!config.liveAnnounceRankedOnly || isRankedLiveQueue) && isAllowedByGuildQueueConfig;

        if (!shouldAnnounceBasedOnQueue) {
            logger.debug(`[match-poller] skip live announce guild=${guildId} account=${account.key} reason=queue_gated queue=${queueType} rankedOnly=${config.liveAnnounceRankedOnly} ranked=${isRankedLiveQueue} allowed=${isAllowedByGuildQueueConfig}`);
            return {
                lolSpectatorState,
                trackingPatch: liveTransitionDecision.nextTrackingPatch,
            };
        }
        const liveAnnouncementGameKey = getLolInGameDedupeKey({
            activeGameId: lolSpectatorState?.activeGame?.gameId ?? lolSpectatorState?.activeGameId ?? null,
            activeGameStartTime: lolSpectatorState?.activeGame?.gameStartTime ?? lolSpectatorState?.activeGameStartTime ?? null,
            activeQueueId: lolSpectatorState?.activeGame?.gameQueueConfigId ?? lolSpectatorState?.activeQueueId ?? null,
        });
        const sentMessage = await announceGameMatchToDiscord({
            buildEmbed: buildLolLiveGameEmbed,
            channel,
            guildId,
            channelId: channelIdForGuild,
            account,
            activeGame: lolSpectatorState.activeGame,
        });
        if (sentMessage) {
            liveTransitionDecision.nextTrackingPatch.liveAnnouncementMessageId = sentMessage.id ?? null;
            liveTransitionDecision.nextTrackingPatch.liveAnnouncementChannelId = sentMessage.channelId ?? channelIdForGuild ?? null;
            liveTransitionDecision.nextTrackingPatch.liveAnnouncementGameKey = liveAnnouncementGameKey ?? null;
        }
    } else if (liveTransitionDecision.debugReason) {
        logger.debug(
            `[match-poller] skip live announce guild=${guildId} account=${account.key} reason=${liveTransitionDecision.debugReason}`
        );
    }

    return {
        lolSpectatorState,
        trackingPatch: liveTransitionDecision.nextTrackingPatch,
    };
}

async function processUnseenLolMatches({
    riotLimiter,
    account,
    guildId,
    channelIdForGuild,
    channel,
    lolIdentity,
    lolTracking,
    announceQueueLookup = null,
    refreshedRankSnapshotsByGame,
    rankSnapshotBeforeRefresh = null,
    guild = null,
}) {
    let shouldClearLiveAnnouncementTracking = false;
    const unseenLolMatchIds = await detectUnseenMatchIds({
        tracking: lolTracking,
        matchBackfillLimit: MATCH_BACKFILL_LIMIT,
        fetchMatchIdsByAccount: ({ count, start }) =>
            fetchMatchIds({ riotLimiter, account, count, start, game: GAME_TYPES.LOL }),
    });

    if (unseenLolMatchIds.length === 0) {
        return { trackingPatch: null, rankSnapshot: refreshedRankSnapshotsByGame[GAME_TYPES.LOL] ?? null };
    }

    const orderedLolMatchIds = [...unseenLolMatchIds].reverse();
    const registeredLolLookup = buildRegisteredLolLookup(guild);
    const beforeLol = rankSnapshotBeforeRefresh ?? lolTracking.lastRankByQueue ?? {};
    let afterLol = beforeLol;
    let lolRecapEvents = Array.isArray(lolTracking.recapEvents) ? lolTracking.recapEvents : [];
    let lastProcessedLolMatchId = lolTracking.lastMatchId;
    let lastProcessedLolMatchAt = Number(lolTracking.lastMatchAt ?? 0) || null;
    /** @type {Array<preparedLolMatch>} */
    const preparedLolMatches = [];

    for (const matchId of orderedLolMatchIds) {
        const match = await fetchMatch({ riotLimiter, account, matchId, game: GAME_TYPES.LOL });
        const participants = match?.info?.participants ?? [];
        const me = participants.find((p) => p.puuid === lolIdentity.puuid);
        const meta = detectLolQueueMetaFromMatch(match);
        const rawQueueType = meta.queueType || LOL_QUEUE_TYPES.UNKNOWN;
        const { queueType, isRanked } = resolveLolQueueContext({ match, rawQueueType });
        const gameMs = Number(match?.info?.gameEndTimestamp ?? 0) || Number(match?.info?.gameCreation ?? 0) || Date.now();
        preparedLolMatches.push({ matchId, me, participants, queueType, isRanked, gameMs, match });
    }

    const latestLolRankedIndex = findLatestRankedIndex(preparedLolMatches);
    const newestFinishedLolMatchIndex = preparedLolMatches.length - 1;
    for (const [index, prepared] of preparedLolMatches.entries()) {
        const { matchId, me, participants, queueType, isRanked, gameMs, match } = prepared;
        if (isRanked) {
            const { byPuuid, byRiotId } = registeredLolLookup;
            const myTeamId = Number.isFinite(me?.teamId) ? Number(me.teamId) : null;
            const lineupMemberKeys = [];
            let didWin = null;
            for (const participant of participants) {
                if (myTeamId != null && Number(participant?.teamId) !== myTeamId) {
                    continue;
                }
                const participantPuuid = typeof participant?.puuid === 'string' ? participant.puuid.trim() : '';
                const participantRiotId = normalizeRiotId(
                    participant?.riotIdGameName ?? participant?.gameName,
                    participant?.riotIdTagline ?? participant?.tagLine
                );
                const canonicalMemberKey = (participantPuuid && byPuuid.get(participantPuuid))
                    || (participantRiotId && byRiotId.get(participantRiotId))
                    || null;
                if (!canonicalMemberKey) continue;
                lineupMemberKeys.push(canonicalMemberKey);
                if (didWin == null && typeof participant?.win === 'boolean') {
                    didWin = participant.win === true;
                }
            }
            const eligibleLineupMemberSets = getEligibleLineupMemberSets(queueType, lineupMemberKeys);
            const shouldRecordAnyLineups = eligibleLineupMemberSets.length > 0;
            if (shouldRecordAnyLineups && myTeamId != null) {
                const teammateWithOutcome = participants.find(
                    (participant) => Number(participant?.teamId) === myTeamId && typeof participant?.win === 'boolean'
                );
                if (teammateWithOutcome) {
                    didWin = teammateWithOutcome.win === true;
                }
            }
            if (shouldRecordAnyLineups && typeof didWin === 'boolean') {
                for (const lineupMemberSet of eligibleLineupMemberSets) {
                    await recordLolLineupResult({
                        guildId,
                        queueType,
                        lineupMemberKeys: lineupMemberSet,
                        didWin,
                        matchId,
                        gameMs,
                    });
                }
            }
        }
        const isLatestRankedMatch = index === latestLolRankedIndex;
        const isNewestFinishedLolMatch = index === newestFinishedLolMatchIndex;
        if (isLatestRankedMatch) {
            const memoizedRankSnapshot = refreshedRankSnapshotsByGame[GAME_TYPES.LOL];
            if (memoizedRankSnapshot) {
                afterLol = memoizedRankSnapshot;
            } else {
                try {
                    afterLol = await refreshLolRankSnapshot({ riotLimiter, account });
                    refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = afterLol;
                } catch {}
            }
        }
        const deltas = computeRankSnapshotDeltas({ before: beforeLol, after: afterLol });
        const beforeRank = isLatestRankedMatch ? (beforeLol?.[queueType] ?? null) : null;
        const afterRank = isLatestRankedMatch ? (afterLol?.[queueType] ?? null) : null;
        const delta = isLatestRankedMatch ? (deltas?.[queueType] ?? 0) : 0;
        if (isRanked) {
            const placement = me?.win ? 1 : 2;
            lolRecapEvents = buildRecapEvents({ recapEvents: lolRecapEvents, matchId, queueType, delta, placement, gameMs });
        }
        const shouldAnnounce = account?.notifications?.lolAnnouncements !== false
            && (!announceQueueLookup || announceQueueLookup.has(queueType));
        if (!shouldAnnounce) {
            if (account?.notifications?.lolAnnouncements === false) {
                logger.info(`[match-poller] skipping LoL announcement for guild=${guildId} account=${account.key} match=${matchId} queue=${queueType} (announcements disabled)`);
            } else {
                logger.info(`[match-poller] skipping LoL announcement for guild=${guildId} account=${account.key} match=${matchId} queue=${queueType} (not in announceQueues)`);
            }
            lastProcessedLolMatchId = matchId;
            lastProcessedLolMatchAt = gameMs;
            continue;
        }
        if (me) {
            const resultAnnouncementContext = {
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
            };
            const strategy = config.lolPostMatchAnnouncementStrategy ?? 'edit';
            const finishedMatchDedupeKey = getLolFinishedMatchDedupeKey({ match, queueType });
            const trackedLiveKey = lolTracking?.liveAnnouncementGameKey ?? null;
            const shouldReconcileLiveMessage = isNewestFinishedLolMatch
                && trackedLiveKey != null
                && finishedMatchDedupeKey != null
                && trackedLiveKey === finishedMatchDedupeKey
                && lolTracking?.liveAnnouncementMessageId
                && (lolTracking?.liveAnnouncementChannelId || channelIdForGuild);
            let didAnnounceResult = false;
            if (shouldReconcileLiveMessage) {
                const liveChannelId = lolTracking?.liveAnnouncementChannelId ?? channelIdForGuild;
                const liveChannel = liveChannelId
                    ? (channel?.id === liveChannelId ? channel : await channel?.client?.channels?.fetch(liveChannelId).catch(() => null))
                    : null;
                if (liveChannel) {
                    const { embed, files } = await buildLolMatchResultEmbed(resultAnnouncementContext);
                    try {
                        const liveMessage = await liveChannel.messages.fetch(lolTracking.liveAnnouncementMessageId);
                        if (strategy === 'delete_and_send') {
                            await liveMessage.delete().catch(() => null);
                            await liveChannel.send({ embeds: [embed], files });
                        } else {
                            await liveMessage.edit({ embeds: [embed], files });
                        }
                        didAnnounceResult = true;
                        shouldClearLiveAnnouncementTracking = true;
                    } catch (err) {
                        const statusCode = Number(err?.status ?? err?.code ?? 0);
                        const isMissingMessage = statusCode === 404 || statusCode === 10008;
                        if (isMissingMessage) {
                            await liveChannel.send({ embeds: [embed], files });
                            didAnnounceResult = true;
                            shouldClearLiveAnnouncementTracking = true;
                        } else {
                            throw err;
                        }
                    }
                }
            }
            if (!didAnnounceResult) {
                const sentMessage = await announceGameMatchToDiscord(resultAnnouncementContext);
                didAnnounceResult = Boolean(sentMessage);
            }
            if (didAnnounceResult && isLatestRankedMatch) {
                const tierChangeEmbed = buildTierChangeEmbed({
                    channel,
                    account,
                    game: GAME_TYPES.LOL,
                    queueType,
                    beforeRank,
                    afterRank,
                });
                if (tierChangeEmbed) await channel.send({ embeds: [tierChangeEmbed] });
            }
        }
        lastProcessedLolMatchId = matchId;
        lastProcessedLolMatchAt = gameMs;
    }
    return {
        trackingPatch: {
            lastMatchId: lastProcessedLolMatchId,
            lastMatchAt: lastProcessedLolMatchAt,
            lastRankByQueue: afterLol,
            recapEvents: lolRecapEvents,
            ...(shouldClearLiveAnnouncementTracking
                ? {
                    liveAnnouncementMessageId: null,
                    liveAnnouncementChannelId: null,
                    liveAnnouncementGameKey: null,
                }
                : {}),
        },
        rankSnapshot: afterLol,
    };
}

// === Service entry point ===
// Polls periodically for new matches and sends announcements.
export async function startMatchPoller(client) {
    const intervalSeconds = config.matchPollIntervalSeconds;
    const riotLimiter = createRiotRateLimiter({ perSecond: 20, perTwoMinutes: 100 });
    const rankRefreshMinutes = config.rankRefreshIntervalMinutes;
    const rankRefreshMs = rankRefreshMinutes * 60 * 1000;
    let isTickRunning = false;
    let tickStartedAtMs = 0;
    let lastScheduledAccounts = 0;

    // One polling iteration. Split out to make the setInterval handler simple.
    const tick = async () => {
        if (isTickRunning) {
            logger.warn(`[match-poller] tick skipped reason=in_progress elapsedMs=${Date.now() - tickStartedAtMs} scheduledAccounts=${lastScheduledAccounts}`);
            return;
        }

        isTickRunning = true;
        tickStartedAtMs = Date.now();
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

            lastScheduledAccounts = totalAccounts;
            let completedAccounts = 0;
            logger.debug(`[match-poller] tick start accountsScheduled=${totalAccounts} workers=${MATCH_POLLER_WORKER_COUNT}`);
            const workItems = [];

            for (const guildId of guildIds) {
                const guild = Object.freeze(db[guildId] ?? {});
                const accounts = guild?.accounts ?? [];
                const channelIdForGuild = guild?.channelId ;
                const guildTftConfig = getGuildTftConfig(db, guildId);
                const seasonCutoffMs = Number(guildTftConfig?.seasonCutoffMs ?? 0);
                const hasSeasonCutoff = Number.isFinite(seasonCutoffMs) && seasonCutoffMs > 0;
                for (const account of accounts) {
                    workItems.push({ guildId, guild, account, channelIdForGuild, seasonCutoffMs, hasSeasonCutoff });
                }
            }

            const processAccountTick = async ({ guildId, guild, account, channelIdForGuild, seasonCutoffMs, hasSeasonCutoff }) => {
                let channel = null;
                if (channelIdForGuild) {
                    if (channelCache.has(channelIdForGuild)) channel = channelCache.get(channelIdForGuild);
                    else {
                        try { channel = await client.channels.fetch(channelIdForGuild); }
                        catch (err) {
                            logger.error('fetch_channel_failed', { service: 'match-poller', event: 'fetch_channel_failed', guildId, channelId: channelIdForGuild, error: err });
                            channel = null;
                        }
                        channelCache.set(channelIdForGuild, channel);
                    }
                }

                const stagedPatches = [];
                const stagePatch = (gameKey, trackingPatch) => stagedPatches.push({ guildId, account, gameKey, trackingPatch });
                try {
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
                    const lolRankSnapshotBeforeRefresh = { ...(lolTracking?.lastRankByQueue ?? {}) };
                    const tftRankSnapshotBeforeRefresh = { ...(tftTracking?.lastRankByQueue ?? {}) };
                    if (!account?.regional || !account?.platform || !account?.key) {
                        return stagedPatches;
                    }
                    
                    const now = Date.now();
                        if (canPollLol && shouldRefreshRank(account, now, rankRefreshMs, GAME_TYPES.LOL)) {
                            try {
                                const refreshedLol = await refreshLolRankSnapshot({ riotLimiter, account });
                                refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = refreshedLol;

                                stagePatch('lol', { lastRankByQueue: refreshedLol });

                                lolTracking.lastRankByQueue = refreshedLol;
                            } catch (err) {
                                logger.error(
                                    `Error refreshing LoL rank for account ${account.key} (guild=${guildId}):`,
                                    err
                                );
                            }
                        }

                        if (canPollTft && shouldRefreshRank(account, now, rankRefreshMs, GAME_TYPES.TFT)) {
                            try {
                                const refreshed = await refreshRankSnapshot({ riotLimiter, account });
                                refreshedRankSnapshotsByGame[GAME_TYPES.TFT] = refreshed;

                                stagePatch('tft', { lastRankByQueue: refreshed });
                                tftTracking.lastRankByQueue = refreshed;
                            } catch (err) {
                                logger.error(
                                    `Error refreshing rank for account ${account.key} (guild=${guildId}):`,
                                    err
                                );
                            }
                        }
                    
                    const tftSpectatorState = canPollTft
                        ? await probeSpectatorState({ riotLimiter, account, tracking: tftTracking, game: GAME_TYPES.TFT })
                        : null;

                    const announceQueues = guild?.announceQueues ?? DEFAULT_ANNOUNCE_QUEUES;
                    
                    const announceQueueLookup = Array.isArray(announceQueues)
                        ? (announceQueues === DEFAULT_ANNOUNCE_QUEUES ? DEFAULT_ANNOUNCE_QUEUES_SET : new Set(announceQueues))
                        : null;

                    if (canPollLol) {
                        const lolStateResult = await pollLolAccountState({
                            riotLimiter,
                            account,
                            lolTracking,
                            guildId,
                            channel,
                            channelIdForGuild,
                            announceQueueLookup,
                        });
                        
                        stagePatch('lol', lolStateResult.trackingPatch);
                    }
                    if (canPollTft && tftSpectatorState) {
                        const nextTftTrackingPatch = {
                            ...tftTracking,
                            inGame: tftSpectatorState.inGame ?? false,
                            lastSpectatorCheckAt: tftSpectatorState.lastSpectatorCheckAt ?? Date.now(),
                            activeGameId: tftSpectatorState.activeGameId ?? tftTracking?.activeGameId ?? null,
                            activeQueueId: tftSpectatorState.activeQueueId ?? tftTracking?.activeQueueId ?? null,
                            activeGameStartTime: tftSpectatorState.activeGameStartTime ?? tftTracking?.activeGameStartTime ?? null,
                        };
                        const nextTftTracking = { ...tftTracking, ...nextTftTrackingPatch };
                        const wasTftInGame = tftTracking?.inGame === true;
                        const isTftInGame = nextTftTracking.inGame === true;
                        const previousTftInGameKey = tftTracking?.lastAnnouncedInGameKey ?? getTftInGameDedupeKey(tftTracking);
                        const nextTftInGameKey = getTftInGameDedupeKey(nextTftTracking);

                        if (!wasTftInGame && isTftInGame) {
                            logger.info(`[match-poller] match started guild=${guildId} account=${account.key} game=${GAME_TYPES.TFT} dedupeKey=${nextTftInGameKey ?? 'none'}`);
                            const shouldAnnounceTftLiveGame = !(previousTftInGameKey && nextTftInGameKey && previousTftInGameKey === nextTftInGameKey);
                            if (shouldAnnounceTftLiveGame && account?.notifications?.tftAnnouncements !== false) {
                                try {
                                    const sentMessage = await announceGameMatchToDiscord({
                                        buildEmbed: buildTftLiveGameEmbed,
                                        channel,
                                        guildId,
                                        channelId: channelIdForGuild,
                                        account,
                                        activeGame: tftSpectatorState.activeGame,
                                    });
                                    const computedTftLiveKey = getTftInGameDedupeKey({
                                        activeGameId: tftSpectatorState?.activeGameId ?? null,
                                        activeGameStartTime: tftSpectatorState?.activeGameStartTime ?? null,
                                        activeQueueId: tftSpectatorState?.activeQueueId ?? null,
                                    });
                                    if (sentMessage) {
                                        nextTftTrackingPatch.liveAnnouncementMessageId = sentMessage.id;
                                        nextTftTrackingPatch.liveAnnouncementChannelId = sentMessage.channelId ?? channelIdForGuild;
                                        nextTftTrackingPatch.liveAnnouncementGameKey = computedTftLiveKey;
                                    }
                                    nextTftTrackingPatch.lastAnnouncedInGameKey = nextTftInGameKey;
                                    nextTftTrackingPatch.lastAnnouncedActiveGameId = nextTftTrackingPatch.activeGameId ?? null;
                                    nextTftTrackingPatch.lastInGameAnnouncementAt = Date.now();
                                } catch (err) {
                                    logger.warn(`[match-poller] TFT live announce failed guild=${guildId} account=${account.key}: ${err?.message ?? err}`);
                                }
                            }
                        }
                        if (wasTftInGame && !isTftInGame) {
                            logger.info(`[match-poller] match ended guild=${guildId} account=${account.key} game=${GAME_TYPES.TFT}`);
                            nextTftTrackingPatch.lastAnnouncedInGameKey = null;
                            nextTftTrackingPatch.lastAnnouncedActiveGameId = null;
                        }
                        stagePatch('tft', nextTftTrackingPatch);
                    }

                    if (canPollLol) {
                        /** @type {lolPollResult} */
                        const lolMatchResult = await processUnseenLolMatches({
                            riotLimiter,
                            account,
                            guildId,
                            channelIdForGuild,
                            channel,
                            lolIdentity,
                            lolTracking,
                            announceQueueLookup,
                            refreshedRankSnapshotsByGame,
                            rankSnapshotBeforeRefresh: lolRankSnapshotBeforeRefresh,
                            guild,
                        });
                        refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = lolMatchResult.rankSnapshot;
                        if (lolMatchResult.trackingPatch) {
                            stagePatch('lol', lolMatchResult.trackingPatch);
                        }
                    }

                    if (!canPollTft) {
                        return stagedPatches;
                    }

                    // Fetch unseen match IDs, respecting the backfill limit.
                    const unseenMatchIds = await detectUnseenMatchIds({
                        tracking: tftTracking,
                        matchBackfillLimit: MATCH_BACKFILL_LIMIT,
                        fetchMatchIdsByAccount: ({ count, start }) =>
                            fetchMatchIds({ riotLimiter, account, count, start, game: GAME_TYPES.TFT }),
                    });
                    
                    if (unseenMatchIds.length === 0) {
                        return stagedPatches;
                    }

                    // Process matches from oldest to newest so deltas line up.
                    const orderedMatchIds = [...unseenMatchIds].reverse();
                    const before = tftRankSnapshotBeforeRefresh ?? tftTracking.lastRankByQueue ?? {};
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
                        const isRanked = isRankedQueue(GAME_TYPES.TFT, queueType);
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
                    const newestFinishedMatchIndex = preparedMatches.length - 1;
                    let shouldClearTftLiveAnnouncementTracking = false;

                    for (const [index, prepared] of preparedMatches.entries()) {
                        const {
                            match,
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
                            logger.info(
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
                        const beforeRank = isLatestRankedMatch ? (before?.[queueType] ?? null) : null;

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
                        const shouldAnnounce = account?.notifications?.tftAnnouncements !== false
                            && (!announceQueueLookup || announceQueueLookup.has(queueType));
                        if (!shouldAnnounce) {
                            logger.info(
                                `[match-poller] skipping announcement for guild=${guildId} account=${account.key} match=${matchId} queue=${queueType} (not in announceQueues)`
                            );
                            lastProcessedMatchId = matchId;
                            lastProcessedMatchAt = gameMs;
                            continue;
                        }
                    
                        logger.info(
                            `[match-poller] NEW match guild=${guildId} ${account.key} match=${matchId} queue=${queueType} place=${normPlacement} delta=${delta}`
                        );

                        const resultAnnouncementContext = {
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
                        };
                        const strategy = config.tftPostMatchAnnouncementStrategy ?? 'edit';
                        const finishedMatchDedupeKey = getTftFinishedMatchDedupeKey({ match, queueType });
                        const trackedLiveKey = tftTracking?.liveAnnouncementGameKey ?? null;
                        const shouldReconcileLiveMessage = index === newestFinishedMatchIndex
                            && trackedLiveKey != null
                            && finishedMatchDedupeKey != null
                            && trackedLiveKey === finishedMatchDedupeKey
                            && tftTracking?.liveAnnouncementMessageId
                            && (tftTracking?.liveAnnouncementChannelId || channelIdForGuild);
                        let didAnnounceResult = false;
                        if (shouldReconcileLiveMessage) {
                            const liveChannelId = tftTracking?.liveAnnouncementChannelId ?? channelIdForGuild;
                            const liveChannel = liveChannelId
                                ? (channel?.id === liveChannelId ? channel : await channel?.client?.channels?.fetch(liveChannelId).catch(() => null))
                                : null;
                            if (liveChannel) {
                                const { embed, files } = await buildMatchResultEmbed(resultAnnouncementContext);
                                try {
                                    const liveMessage = await liveChannel.messages.fetch(tftTracking.liveAnnouncementMessageId);
                                    if (strategy === 'delete_and_send') {
                                        await liveMessage.delete().catch(() => null);
                                        await liveChannel.send({ embeds: [embed], files });
                                    } else {
                                        await liveMessage.edit({ embeds: [embed], files });
                                    }
                                    didAnnounceResult = true;
                                    shouldClearTftLiveAnnouncementTracking = true;
                                } catch (err) {
                                    const statusCode = Number(err?.status ?? err?.code ?? 0);
                                    const isMissingMessage = statusCode === 404 || statusCode === 10008;
                                    if (isMissingMessage) {
                                        await liveChannel.send({ embeds: [embed], files });
                                        didAnnounceResult = true;
                                        shouldClearTftLiveAnnouncementTracking = true;
                                    } else {
                                        throw err;
                                    }
                                }
                            }
                        }
                        if (!didAnnounceResult) {
                            await announceGameMatchToDiscord(resultAnnouncementContext);
                            didAnnounceResult = true;
                        }
                        if (didAnnounceResult && isLatestRankedMatch) {
                            const tierChangeEmbed = buildTierChangeEmbed({
                                channel,
                                account,
                                game: GAME_TYPES.TFT,
                                queueType,
                                beforeRank,
                                afterRank,
                            });
                            if (tierChangeEmbed) await channel.send({ embeds: [tierChangeEmbed] });
                        }

                        lastProcessedMatchId = matchId;
                        lastProcessedMatchAt = gameMs;
                    }

                    stagePatch('tft', {
                            // Persist lastMatchId so we only announce new games.
                            lastMatchId: lastProcessedMatchId,
                            lastMatchAt: lastProcessedMatchAt,
                            lastRankByQueue: after,
                            recapEvents,
                            inGame: tftSpectatorState?.inGame ?? false,
                            lastSpectatorCheckAt: tftSpectatorState?.lastSpectatorCheckAt ?? Date.now(),
                            activeGameId: tftSpectatorState?.activeGameId ?? tftTracking?.activeGameId ?? null,
                            activeQueueId: tftSpectatorState?.activeQueueId ?? tftTracking?.activeQueueId ?? null,
                            activeGameStartTime: tftSpectatorState?.activeGameStartTime ?? tftTracking?.activeGameStartTime ?? null,
                            ...(shouldClearTftLiveAnnouncementTracking
                                ? {
                                    liveAnnouncementMessageId: null,
                                    liveAnnouncementChannelId: null,
                                    liveAnnouncementGameKey: null,
                                }
                                : {}),
                    });
                } catch (err) {
                logger.error(
                    `Error polling matches for account ${account.key} (guild=${guildId}):`,
                    err
                );
                }
                return stagedPatches;
            };

            let cursor = 0;
            const workerCount = Math.min(MATCH_POLLER_WORKER_COUNT, workItems.length || 1);
            await Promise.all(Array.from({ length: workerCount }, async () => {
                while (cursor < workItems.length) {
                    const index = cursor++;
                    const resultPatches = await processAccountTick(workItems[index]);
                    for (const patch of resultPatches) {
                        stageTrackingUpsert(patch);
                    }
                    completedAccounts += 1;
                }
            }));
            for (const [compoundKey, nextAccount] of pendingUpsertsByGuild.entries()) {
                const [guildId] = compoundKey.split(':');
                await upsertGuildAccountInStore(guildId, nextAccount);
            }
            logger.debug(`[match-poller] tick end accountsScheduled=${totalAccounts} accountsCompleted=${completedAccounts} durationMs=${Date.now() - tickStartedAtMs}`);
        } finally {
            isTickRunning = false;
        }        
    };

    // Run immediately, then schedule future ticks.
    await tick();
    setInterval(() => {
        tick().catch((error) => logger.error('match_poll_tick_failed', { service: 'match-poller', event: 'tick_failed', error }));
    }, Math.max(10, intervalSeconds) * 1000);
}
