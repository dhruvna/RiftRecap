import { getLolIdentity } from '../../storage.js';
import { getEligibleLineupMemberSets, recordLolLineupResult, recordLolMemberContextResult } from '../../storage/lineups.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';
import {
    buildLolLiveGameEmbed,
    buildLolMatchResultEmbed,
    detectLolQueueMetaFromMatch,
} from '../../utils/lol.js';
import { buildTierChangeEmbed } from '../../utils/matchEmbedShared.js';
import { computeRankSnapshotDeltas } from '../../utils/rankSnapshot.js';
import {
    GAME_TYPES,
    LOL_QUEUE_TYPES,
    resolveLolQueueContext,
    isRankedQueue,
} from '../../constants/queues.js';
import { detectUnseenMatchIds } from './matchDiscovery.js';
import {
    LIVE_ANNOUNCE_DEDUPE_WINDOW_MS,
    getLolFinishedMatchDedupeKey,
    getLolInGameDedupeKey,
    probeSpectatorState,
} from './spectatorState.js';
import { refreshLolRankSnapshot, shouldRefreshRank } from './rankRefresh.js';
import {
    MATCH_BACKFILL_LIMIT,
    announceGameMatchToDiscord,
    buildDiscordMessagePayload,
    buildRecapEvents,
    fetchMatch,
    fetchMatchIds,
    findLatestRankedIndex,
} from './shared.js';

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

function normalizeLolRole(participant = {}) {
    const rawRole = typeof participant?.teamPosition === 'string' && participant.teamPosition.trim()
        ? participant.teamPosition
        : participant?.lane;
    if (typeof rawRole !== 'string') return null;
    const normalized = rawRole.trim().toUpperCase();
    if (!normalized || normalized === 'NONE') return null;
    if (normalized === 'UTILITY') return 'SUPPORT';
    return normalized;
}

function getParticipantChampionContext(participant = {}) {
    if (typeof participant?.championName === 'string' && participant.championName.trim()) {
        return participant.championName.trim();
    }
    if (Number.isInteger(participant?.championId) && participant.championId > 0) {
        return String(participant.championId);
    }
    return null;
}

function buildLineupMemberMetadata({ participants = [], byPuuid, teamId }) {
    const metadataByMember = {};
    const lineupMemberKeys = [];

    for (const participant of participants) {
        if (Number(participant?.teamId) !== teamId) {
            continue;
        }
        const participantPuuid = typeof participant?.puuid === 'string' ? participant.puuid.trim() : '';
        const canonicalMemberKey = (participantPuuid && byPuuid.get(participantPuuid)) || null;
        if (!canonicalMemberKey) continue;

        lineupMemberKeys.push(canonicalMemberKey);
        metadataByMember[canonicalMemberKey] = {
            champion: getParticipantChampionContext(participant),
            role: normalizeLolRole(participant),
            didWin: typeof participant?.win === 'boolean' ? participant.win === true : null,
        };
    }

    return { lineupMemberKeys, metadataByMember };
}

function buildRegisteredLolLookup(guild = {}) {
    const byPuuid = new Map();
    const accounts = Array.isArray(guild?.accounts) ? guild.accounts : [];
    for (const registeredAccount of accounts) {
        const identity = getLolIdentity(registeredAccount);
        const canonicalMemberKey = registeredAccount?.key;
        if (!canonicalMemberKey) continue;
        const puuid = typeof identity?.puuid === 'string' ? identity.puuid.trim() : '';
        if (puuid) byPuuid.set(puuid, canonicalMemberKey);
    }
    return { byPuuid };
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
    seasonCutoffMs = null,
    hasSeasonCutoff = false,
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

    const latestLolRankedIndex = findLatestRankedIndex(preparedLolMatches, {
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
    const newestFinishedLolMatchIndex = preparedLolMatches.length - 1;
    for (const [index, prepared] of preparedLolMatches.entries()) {
        const { matchId, me, participants, queueType, isRanked, gameMs, match } = prepared;
        const isBeforeSeasonCutoff =
            hasSeasonCutoff &&
            Number.isFinite(gameMs) &&
            gameMs > 0 &&
            gameMs < seasonCutoffMs;

        if (isBeforeSeasonCutoff) {
            logger.info(
                `[match-poller] skipping stale pre-cutoff match guild=${guildId} account=${account.key} match=${matchId} game=${GAME_TYPES.LOL} gameMs=${gameMs} cutoffMs=${seasonCutoffMs}`
            );
            lastProcessedLolMatchId = matchId;
            lastProcessedLolMatchAt = gameMs;
            continue;
        }
        if (isRanked && me) {
            const { byPuuid } = registeredLolLookup;
            const myTeamId = Number.isFinite(me.teamId) ? Number(me.teamId) : null;
            const didWin = typeof me.win === 'boolean' ? me.win === true : null;
            if (myTeamId != null && typeof didWin === 'boolean') {
                const { lineupMemberKeys, metadataByMember } = buildLineupMemberMetadata({
                    participants,
                    byPuuid,
                    teamId: myTeamId,
                });
                await recordLolMemberContextResult({
                    guildId,
                    memberKeys: lineupMemberKeys,
                    lineupMemberMetadata: metadataByMember,
                    didWin,
                    matchId,
                    gameMs,
                });
                const eligibleLineupMemberSets = getEligibleLineupMemberSets(queueType, lineupMemberKeys);
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
        if (isRanked && me) {
            const placement = me.win ? 1 : 2;
            lolRecapEvents = buildRecapEvents({
                recapEvents: lolRecapEvents,
                matchId,
                queueType,
                delta,
                placement,
                gameMs,
                kills: me.kills,
                deaths: me.deaths,
                assists: me.assists,
            });
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
                    const payload = buildDiscordMessagePayload(await buildLolMatchResultEmbed({
                        ...resultAnnouncementContext,
                        channel: liveChannel,
                    }));
                    try {
                        const liveMessage = await liveChannel.messages.fetch(lolTracking.liveAnnouncementMessageId);
                        if (strategy === 'delete_and_send') {
                            await liveMessage.delete().catch(() => null);
                            await liveChannel.send(payload);
                        } else {
                            await liveMessage.edit(payload);
                        }
                        didAnnounceResult = true;
                        shouldClearLiveAnnouncementTracking = true;
                    } catch (err) {
                        const statusCode = Number(err?.status ?? err?.code ?? 0);
                        const isMissingMessage = statusCode === 404 || statusCode === 10008;
                        if (isMissingMessage) {
                            await liveChannel.send(payload);
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
            if (didAnnounceResult && isLatestRankedMatch && channel) {
                const tierChangeEmbed = buildTierChangeEmbed({
                    account,
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

export async function processLolAccountTick({
    riotLimiter,
    account,
    guild,
    channel,
    channelIdForGuild,
    tracking,
    rankContext = {},
    announceQueueLookup,
    seasonCutoff = {},
}) {
    const stagedPatches = [];
    const lolIdentity = getLolIdentity(account);
    const lolTracking = tracking ?? {};
    const now = rankContext.now ?? Date.now();
    const refreshedRankSnapshotsByGame = rankContext.refreshedRankSnapshotsByGame ?? { [GAME_TYPES.LOL]: null };

    if (shouldRefreshRank(account, now, rankContext.rankRefreshMs, GAME_TYPES.LOL)) {
        try {
            const refreshedLol = await refreshLolRankSnapshot({ riotLimiter, account });
            refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = refreshedLol;
            stagedPatches.push({ gameKey: 'lol', trackingPatch: { lastRankByQueue: refreshedLol } });
        } catch (err) {
            logger.error(
                `Error refreshing LoL rank for account ${account.key} (guild=${guild?.id ?? 'unknown'}):`,
                err
            );
        }
    }

    const liveStateResult = await pollLolAccountState({
        riotLimiter,
        account,
        lolTracking,
        guildId: guild?.id,
        channel,
        channelIdForGuild,
        announceQueueLookup,
    });
    stagedPatches.push({ gameKey: 'lol', trackingPatch: liveStateResult.trackingPatch });

    const matchResult = await processUnseenLolMatches({
        riotLimiter,
        account,
        guildId: guild?.id,
        channelIdForGuild,
        channel,
        lolIdentity,
        lolTracking,
        announceQueueLookup,
        refreshedRankSnapshotsByGame,
        rankSnapshotBeforeRefresh: rankContext.rankSnapshotBeforeRefresh,
        guild,
        seasonCutoffMs: seasonCutoff.seasonCutoffMs,
        hasSeasonCutoff: seasonCutoff.hasSeasonCutoff,
    });
    refreshedRankSnapshotsByGame[GAME_TYPES.LOL] = matchResult.rankSnapshot;
    if (matchResult.trackingPatch) {
        stagedPatches.push({ gameKey: 'lol', trackingPatch: matchResult.trackingPatch });
    }

    return stagedPatches;
}
