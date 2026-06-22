// === Imports ===
// This service orchestrates polling Riot for match updates and sending Discord updates.

import {
    getGuildLolConfig,
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
    DEFAULT_ANNOUNCE_QUEUES,
    GAME_TYPES,
} from '../constants/queues.js';

import { createRiotRateLimiter } from '../utils/rateLimiter.js';
import config from '../config.js';
import logger from '../utils/logger.js';

import { processLolAccountTick } from './matchPoller/lolProcessor.js';
import { processTftAccountTick } from './matchPoller/tftProcessor.js';
import { buildRecapEvents } from './matchPoller/shared.js';

// === Polling configuration ===
const MATCH_POLLER_WORKER_COUNT = (() => {
    const configured = Number(process.env.MATCH_POLLER_WORKERS ?? 5);
    if (!Number.isFinite(configured)) return 5;
    return Math.min(10, Math.max(3, Math.floor(configured)));
})();

// Hot-path constants for long-running polling: reuse immutable queue/ranked lookups to reduce per-iteration allocations.
const DEFAULT_ANNOUNCE_QUEUES_SET = new Set(DEFAULT_ANNOUNCE_QUEUES);

export { buildRecapEvents };

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
                if (!trackingPatch) return;
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
                const guild = Object.freeze({ ...(db[guildId] ?? {}), id: guildId });
                const accounts = guild?.accounts ?? [];
                const channelIdForGuild = guild?.channelId;
                const guildTftConfig = getGuildTftConfig(db, guildId);
                const guildLolConfig = getGuildLolConfig(db, guildId);
                const tftSeasonCutoffMs = Number(guildTftConfig?.seasonCutoffMs ?? 0);
                const lolSeasonCutoffMs = Number(guildLolConfig?.seasonCutoffMs ?? 0);
                const hasTftSeasonCutoff = Number.isFinite(tftSeasonCutoffMs) && tftSeasonCutoffMs > 0;
                const hasLolSeasonCutoff = Number.isFinite(lolSeasonCutoffMs) && lolSeasonCutoffMs > 0;

                for (const account of accounts) {
                    workItems.push({
                        guildId,
                        guild,
                        account,
                        channelIdForGuild,
                        tftSeasonCutoffMs,
                        hasTftSeasonCutoff,
                        lolSeasonCutoffMs,
                        hasLolSeasonCutoff,
                    });
                }
            }

            const processAccountTick = async ({
                guildId,
                guild,
                account,
                channelIdForGuild,
                tftSeasonCutoffMs,
                hasTftSeasonCutoff,
                lolSeasonCutoffMs,
                hasLolSeasonCutoff,
            }) => {
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
                const appendPatches = (patches) => {
                    for (const patch of patches) {
                        stagedPatches.push({ guildId, account, ...patch });
                    }
                };
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
                    const announceQueues = guild?.announceQueues ?? DEFAULT_ANNOUNCE_QUEUES;
                    const announceQueueLookup = Array.isArray(announceQueues)
                        ? (announceQueues === DEFAULT_ANNOUNCE_QUEUES ? DEFAULT_ANNOUNCE_QUEUES_SET : new Set(announceQueues))
                        : null;

                    if (canPollLol) {
                        appendPatches(await processLolAccountTick({
                            riotLimiter,
                            account,
                            guild,
                            channel,
                            channelIdForGuild,
                            tracking: lolTracking,
                            rankContext: {
                                now,
                                rankRefreshMs,
                                refreshedRankSnapshotsByGame,
                                rankSnapshotBeforeRefresh: lolRankSnapshotBeforeRefresh,
                            },
                            announceQueueLookup,
                            seasonCutoff: {
                                seasonCutoffMs: lolSeasonCutoffMs,
                                hasSeasonCutoff: hasLolSeasonCutoff,
                            },
                        }));
                    }
                    if (canPollTft) {
                        appendPatches(await processTftAccountTick({
                            riotLimiter,
                            account,
                            channel,
                            channelIdForGuild,
                            tracking: tftTracking,
                            rankContext: {
                                now,
                                rankRefreshMs,
                                refreshedRankSnapshotsByGame,
                                rankSnapshotBeforeRefresh: tftRankSnapshotBeforeRefresh,
                            },
                            announceQueueLookup,
                            seasonCutoff: {
                                seasonCutoffMs: tftSeasonCutoffMs,
                                hasSeasonCutoff: hasTftSeasonCutoff,
                            },
                            guildId,
                        }));
                    }
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
