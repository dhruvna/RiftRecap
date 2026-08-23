import { getTftIdentity } from '../../storage.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';
import { buildTierChangeEmbed } from '../../utils/matchEmbedShared.js';
import { computeRankSnapshotDeltas } from '../../utils/rankSnapshot.js';
import {
    buildMatchResultEmbed,
    buildTftLiveGameEmbed,
    detectQueueMetaFromMatch,
    normalizePlacement,
} from '../../utils/tft.js';
import {
    GAME_TYPES,
    TFT_QUEUE_TYPES,
    isRankedQueue,
} from '../../constants/queues.js';
import { detectUnseenMatchIds } from './matchDiscovery.js';
import {
    getTftFinishedMatchDedupeKey,
    getTftInGameDedupeKey,
    probeSpectatorState,
} from './spectatorState.js';
import { refreshRankSnapshot, shouldRefreshRank } from './rankRefresh.js';
import {
    MATCH_BACKFILL_LIMIT,
    announceGameMatchToDiscord,
    buildRecapEvents,
    fetchMatch,
    fetchMatchIds,
    findLatestRankedIndex,
} from './shared.js';

async function pollTftAccountState({ riotLimiter, account, tftTracking, guildId, channel, channelIdForGuild, spectatorState = null, liveAnnouncementRegistry = null }) {
    const tftSpectatorState = spectatorState
        ?? await probeSpectatorState({ riotLimiter, account, tracking: tftTracking, game: GAME_TYPES.TFT });
    const nextTftTrackingPatch = {
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
        logger.info(`[match-poller] match started account=${account.key} game=${GAME_TYPES.TFT} activeQueueId=${nextTftTrackingPatch.activeQueueId ?? 'none'}`);
        const shouldAnnounceTftLiveGame = !(previousTftInGameKey && nextTftInGameKey && previousTftInGameKey === nextTftInGameKey);
        if (shouldAnnounceTftLiveGame && account?.notifications?.tftAnnouncements !== false) {
            if (liveAnnouncementRegistry && !liveAnnouncementRegistry.claim({
                guildId,
                game: GAME_TYPES.TFT,
                gameKey: nextTftInGameKey,
            })) {
                logger.debug(`[match-poller] skip live announce guild=${guildId} account=${account.key} reason=game_already_announced gameKey=${nextTftInGameKey ?? 'none'}`);
                nextTftTrackingPatch.lastAnnouncedInGameKey = nextTftInGameKey;
                nextTftTrackingPatch.lastAnnouncedActiveGameId = nextTftTrackingPatch.activeGameId ?? null;
                nextTftTrackingPatch.lastInGameAnnouncementAt = Date.now();
                return { tftSpectatorState, trackingPatch: nextTftTrackingPatch };
            }
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
        logger.info(`[match-poller] match ended  account=${account.key} game=${GAME_TYPES.TFT}`);
        nextTftTrackingPatch.lastAnnouncedInGameKey = null;
        nextTftTrackingPatch.lastAnnouncedActiveGameId = null;
    }

    return { tftSpectatorState, trackingPatch: nextTftTrackingPatch };
}

async function processUnseenTftMatches({
    riotLimiter,
    account,
    guildId,
    channelIdForGuild,
    channel,
    tftIdentity,
    tftTracking,
    tftSpectatorState,
    announceQueueLookup = null,
    refreshedRankSnapshotsByGame,
    rankSnapshotBeforeRefresh = null,
    seasonCutoffMs = null,
    hasSeasonCutoff = false,
}) {
    const unseenMatchIds = await detectUnseenMatchIds({
        tracking: tftTracking,
        matchBackfillLimit: MATCH_BACKFILL_LIMIT,
        fetchMatchIdsByAccount: ({ count, start }) =>
            fetchMatchIds({ riotLimiter, account, count, start, game: GAME_TYPES.TFT }),
    });

    if (unseenMatchIds.length === 0) {
        return { trackingPatch: null, rankSnapshot: refreshedRankSnapshotsByGame[GAME_TYPES.TFT] ?? null };
    }

    const orderedMatchIds = [...unseenMatchIds].reverse();
    const before = rankSnapshotBeforeRefresh ?? tftTracking.lastRankByQueue ?? {};
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

        lastProcessedMatchId = matchId;
        lastProcessedMatchAt = gameMs;
    }

    return {
        trackingPatch: {
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
        },
        rankSnapshot: after,
    };
}

export async function processTftAccountTick({
    riotLimiter,
    account,
    channel,
    channelIdForGuild,
    tracking,
    spectatorState = null,
    rankContext = {},
    announceQueueLookup,
    liveAnnouncementRegistry,
    seasonCutoff = {},
    guildId = null,
}) {
    const stagedPatches = [];
    const tftTracking = tracking ?? {};
    const tftIdentity = getTftIdentity(account);
    const now = rankContext.now ?? Date.now();
    const refreshedRankSnapshotsByGame = rankContext.refreshedRankSnapshotsByGame ?? { [GAME_TYPES.TFT]: null };

    if (shouldRefreshRank(account, now, rankContext.rankRefreshMs, GAME_TYPES.TFT)) {
        try {
            const refreshed = await refreshRankSnapshot({ riotLimiter, account });
            refreshedRankSnapshotsByGame[GAME_TYPES.TFT] = refreshed;
            stagedPatches.push({ gameKey: 'tft', trackingPatch: { lastRankByQueue: refreshed } });
        } catch (err) {
            logger.error('tft_rank_refresh_failed', {
                service: 'match-poller',
                event: 'tft_rank_refresh_failed',
                guildId,
                accountKey: account.key,
                error: err,
            });
        }
    }

    const stateResult = await pollTftAccountState({
        riotLimiter,
        account,
        tftTracking,
        guildId,
        channel,
        channelIdForGuild,
        liveAnnouncementRegistry,
        spectatorState,
    });
    stagedPatches.push({ gameKey: 'tft', trackingPatch: stateResult.trackingPatch });

    const matchResult = await processUnseenTftMatches({
        riotLimiter,
        account,
        guildId,
        channelIdForGuild,
        channel,
        tftIdentity,
        tftTracking,
        tftSpectatorState: stateResult.tftSpectatorState,
        announceQueueLookup,
        refreshedRankSnapshotsByGame,
        rankSnapshotBeforeRefresh: rankContext.rankSnapshotBeforeRefresh,
        seasonCutoffMs: seasonCutoff.seasonCutoffMs,
        hasSeasonCutoff: seasonCutoff.hasSeasonCutoff,
    });
    refreshedRankSnapshotsByGame[GAME_TYPES.TFT] = matchResult.rankSnapshot;
    if (matchResult.trackingPatch) {
        stagedPatches.push({ gameKey: 'tft', trackingPatch: matchResult.trackingPatch });
    }

    return stagedPatches;
}
