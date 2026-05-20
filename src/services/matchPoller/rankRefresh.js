import { GAME_TYPES, mapRiotLolQueueType, RANKED_QUEUES_BY_GAME } from '../../constants/queues.js';
import { getLolIdentity, getLolTracking, getTftIdentity, getTftTracking } from '../../storage.js';
import { getLolRankByPuuid, getTFTRankByPuuid } from '../../riot.js';
import { toRankSnapshot } from '../../utils/rankSnapshot.js';

// Hot-path constants for long-running polling: avoid rebuilding ranked queue lookup sets per account refresh.
const LOL_RANKED_QUEUE_LOOKUP = new Set(RANKED_QUEUES_BY_GAME[GAME_TYPES.LOL]);

export function shouldRefreshRank(account, now, maxAgeMs, gameType = GAME_TYPES.TFT) {
    const tracking = gameType === GAME_TYPES.LOL ? getLolTracking(account) : getTftTracking(account);
    if (!tracking?.lastRankByQueue) return true;
    const entries = Object.values(tracking.lastRankByQueue);
    if (entries.length === 0) return true;
    return entries.some((entry) => {
        const lastUpdatedAt = Number(entry?.lastUpdatedAt ?? 0);
        return !Number.isFinite(lastUpdatedAt) || now - lastUpdatedAt >= maxAgeMs;
    });
}

export async function refreshRankSnapshot({ riotLimiter, account }) {
    const tftIdentity = getTftIdentity(account);
    const entries = await getTFTRankByPuuid({
        platform: account.platform,
        puuid: tftIdentity.puuid,
        limiter: riotLimiter,
    });
    return toRankSnapshot(entries);
}

export async function refreshLolRankSnapshot({ riotLimiter, account }) {
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
        rankedQueues: LOL_RANKED_QUEUE_LOOKUP,
    });
}
