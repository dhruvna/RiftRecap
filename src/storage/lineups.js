import path from 'node:path';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { createJsonStore } from './jsonStore.js';

const DEFAULT_LINEUPS_DATA_PATH = path.join(process.cwd(), 'user_data', 'lol_lineups.json');
const LINEUPS_DATA_PATH = process.env.LOL_LINEUPS_DATA_PATH
    ? path.resolve(process.env.LOL_LINEUPS_DATA_PATH)
    : path.join(process.env.DATA_DIR ?? path.dirname(DEFAULT_LINEUPS_DATA_PATH), 'lol_lineups.json');

const LINEUP_DELIMITER = '|';
const SEEN_MATCH_IDS_LIMIT = 1500;

const store = createJsonStore({
    filePath: LINEUPS_DATA_PATH,
    initialData: {},
    revalidateCache: true,
    validateData: (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('[lineups] lol_lineups.json root must be an object.');
        }
    },
});

async function loadDb({ forceReload = false } = {}) {
    return store.load({ forceReload });
}

async function mutateDb(mutator) {
    return store.mutate(mutator);
}

function getGuildStoreMutable(db, guildId) {
    if (!db[guildId]) {
        db[guildId] = { lineups: {} };
    }
    if (!db[guildId].lineups || typeof db[guildId].lineups !== 'object' || Array.isArray(db[guildId].lineups)) {
        db[guildId].lineups = {};
    }
    return db[guildId].lineups;
}

export function buildLineupKey(lineupMemberKeys) {
    if (!Array.isArray(lineupMemberKeys)) {
        return '';
    }

    const normalized = [...new Set(
        lineupMemberKeys
            .map((key) => (typeof key === 'string' ? key.trim() : ''))
            .filter(Boolean)
    )].sort();

    return normalized.join(LINEUP_DELIMITER);
}

export function isEligibleLolLineupSize(queueType, size) {
    if (!Number.isInteger(size) || size <= 0) {
        return false;
    }

    if (queueType === LOL_QUEUE_TYPES.RANKED_SOLO_DUO) {
        return size === 2;
    }

    if (queueType === LOL_QUEUE_TYPES.RANKED_FLEX) {
        return size === 2 || size === 3 || size === 5;
    }

    return false;
}
function createLineupRecord({ gameMs } = {}) {
    const now = Number.isFinite(gameMs) ? Math.trunc(gameMs) : Date.now();
    return {
        games: 0,
        wins: 0,
        losses: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        seenMatchIds: [],
    };
}

function normalizeMatchId(matchId) {
    return typeof matchId === 'string' && matchId.trim() ? matchId.trim() : null;
}

function buildCombinations(values, targetSize, startIndex = 0, current = [], result = []) {
    if (current.length === targetSize) {
        result.push([...current]);
        return result;
    }

    for (let index = startIndex; index < values.length; index += 1) {
        current.push(values[index]);
        buildCombinations(values, targetSize, index + 1, current, result);
        current.pop();
    }

    return result;
}

export function getEligibleLineupMemberSets(queueType, lineupMemberKeys) {
    const lineupKey = buildLineupKey(lineupMemberKeys);
    if (!lineupKey) {
        return [];
    }

    const canonicalMembers = lineupKey.split(LINEUP_DELIMITER);
    const eligibleSizes = [];
    for (const size of [2, 3, 5]) {
        if (isEligibleLolLineupSize(queueType, size) && canonicalMembers.length >= size) {
            eligibleSizes.push(size);
        }
    }

    const allMemberSets = [];
    for (const size of eligibleSizes) {
        const combos = buildCombinations(canonicalMembers, size);
        allMemberSets.push(...combos);
    }
    return allMemberSets;
}

export async function recordLolLineupResult({ guildId, queueType, lineupMemberKeys, didWin, matchId, gameMs }) {
    const lineupKey = buildLineupKey(lineupMemberKeys);
    const lineupSize = lineupKey ? lineupKey.split(LINEUP_DELIMITER).length : 0;

    if (!guildId || typeof guildId !== 'string') {
        return { recorded: false, reason: 'invalid_guild_id' };
    }
    if (!lineupKey) {
        return { recorded: false, reason: 'invalid_lineup' };
    }
    if (!isEligibleLolLineupSize(queueType, lineupSize)) {
        return { recorded: false, reason: 'ineligible_size' };
    }

    return mutateDb((db) => {
        const lineups = getGuildStoreMutable(db, guildId);
        const existing = lineups[lineupKey] ?? createLineupRecord({ gameMs });
        const matchIdNormalized = normalizeMatchId(matchId);

        if (matchIdNormalized && existing.seenMatchIds.includes(matchIdNormalized)) {
            return { recorded: false, reason: 'duplicate_match', didChange: false };
        }

        existing.games += 1;
        if (didWin) {
            existing.wins += 1;
        } else {
            existing.losses += 1;
        }

        existing.lastSeenAt = Number.isFinite(gameMs) ? Math.trunc(gameMs) : Date.now();

        if (matchIdNormalized) {
            existing.seenMatchIds = [matchIdNormalized, ...existing.seenMatchIds].slice(0, SEEN_MATCH_IDS_LIMIT);
        }

        lineups[lineupKey] = existing;

        return { recorded: true, lineupKey };
    });
}

export async function getGuildLineupStats(guildId, { forceReload = false } = {}) {
    if (!guildId || typeof guildId !== 'string') {
        return {};
    }

    const db = await loadDb({ forceReload });
    const lineups = db?.[guildId]?.lineups;
    if (!lineups || typeof lineups !== 'object' || Array.isArray(lineups)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(lineups).map(([lineupKey, stats]) => [
            lineupKey,
            {
                games: stats.games,
                wins: stats.wins,
                losses: stats.losses,
                firstSeenAt: stats.firstSeenAt,
                lastSeenAt: stats.lastSeenAt,
            },
        ])
    );
}
