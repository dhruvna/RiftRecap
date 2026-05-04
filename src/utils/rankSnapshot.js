// === Imports ===
// Ranked queue constants ensure we only snapshot relevant queues.
import { GAME_TYPES, TFT_QUEUE_TYPES } from "../constants/queues.js";
import { getLolTracking, getTftTracking } from "../storage.js";

// === Rank normalization constants ===
// The goal is to turn a tier/division/LP tuple into a single comparable number.
const TIER_BASE = {
  IRON: 0,
  BRONZE: 400,
  SILVER: 800,
  GOLD: 1200,
  PLATINUM: 1600,
  EMERALD: 2000,
  DIAMOND: 2400,
};

// Keep monotonic above Diamond I by anchoring Master+ at a higher base.
const MASTER_PLUS_BASE = 2800;

// Division offsets represent 100 LP bands inside each tier.
const DIV_OFFSET = {
  IV: 0,
  III: 100,
  II: 200,
  I: 300,
};

// === Rank normalization ===
// Convert Riot rank data to a single LP-like number for delta computations.
export function standardizeRankLp(rank) {
    if (!rank) return null;

    const tier = typeof rank.tier === "string" ? rank.tier.toUpperCase() : null;
    const div = typeof rank.rank === "string" ? rank.rank.toUpperCase() : null;
    const lp = Number(rank.lp);

    if (!tier || !Number.isFinite(lp)) return null;

    // Handle Master, Grandmaster, Challenger
    if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(tier)) {
        return MASTER_PLUS_BASE + lp;
    }

    const base = TIER_BASE[tier];
    const offset = DIV_OFFSET[div];

    if (!Number.isFinite(base) || !Number.isFinite(offset)) return null;
    return base + offset + lp;  
}

// === Snapshot conversion ===
// Convert raw Riot entries into our internal snapshot structure.
export function toRankSnapshot(entries,
    {
        now = Date.now(),
        rankedQueues = new Set([
            TFT_QUEUE_TYPES.RANKED,
            TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
        ]),
    } = {},
) {

    const rows = Array.isArray(entries) ? entries : [];
    const normalizedRows = rows.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const queueType = normalizeQueueType(entry.queueType);
        return queueType === entry.queueType ? entry : { ...entry, queueType };
    });

    return Object.fromEntries(
        normalizedRows
            .filter((e) => rankedQueues.has(e.queueType))
            .map((e) => [
                e.queueType,
                { 
                    tier: e.tier ?? null,
                    rank: e.rank ?? null, // null for MASTER+ (and sometimes other cases)
                    lp: Number(e.leaguePoints ?? 0),
                    wins: Number(e.wins ?? 0),
                    losses: Number(e.losses ?? 0),
                    lastUpdatedAt: now,
                },
            ])
        );
    }

function normalizeQueueType(queueType) {
    if (typeof queueType !== "string") return queueType;
    return queueType.trim().toUpperCase();
}

// === Delta computation ===
// Compute rank movement by queue using normalized LP values.
export function computeRankSnapshotDeltas({ before = {}, after = {} }) {
    const deltas = {};
    
    for (const [queueType, afterRank] of Object.entries(after)) {
        const beforeRank = before?.[queueType];

        const beforeStd = standardizeRankLp(beforeRank);
        const afterStd = standardizeRankLp(afterRank);

        if (Number.isFinite(beforeStd) && Number.isFinite(afterStd)) {
            deltas[queueType] = afterStd - beforeStd;
        }
    }
    return deltas;
}

// === Lookup helper ===
// Convenience wrapper to fetch a stored snapshot from an account.
export function getRankSnapshotForQueue(account, queueType, game = GAME_TYPES.TFT) {
    const tracking = game === GAME_TYPES.LOL ? getLolTracking(account) : getTftTracking(account);
    return tracking?.lastRankByQueue?.[queueType] ?? null;
}
