import path from 'node:path';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { createJsonStore } from './jsonStore.js';

const DEFAULT_LINEUPS_DATA_PATH = path.join(process.cwd(), 'user_data', 'lol_lineups.json');
const LINEUPS_DATA_PATH = process.env.LOL_LINEUPS_DATA_PATH
    ? path.resolve(process.env.LOL_LINEUPS_DATA_PATH)
    : path.join(process.env.DATA_DIR ?? path.dirname(DEFAULT_LINEUPS_DATA_PATH), 'lol_lineups.json');

const LINEUP_DELIMITER = '|';
const SEEN_MATCH_IDS_LIMIT = 1500;
const LINEUP_CONTEXT_COUNTER_LIMIT = 25;

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

function normalizeContextValue(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
    }
    if (Number.isInteger(value) && value > 0) {
        return String(value);
    }
    return null;
}

function getLineupMemberMetadata(lineupMemberMetadata, memberKey) {
    if (!lineupMemberMetadata || typeof lineupMemberMetadata !== 'object') {
        return null;
    }
    const metadata = lineupMemberMetadata[memberKey];
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
}

function incrementContextCounter({ aggregate, memberKey, value, didWin }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedValue = normalizeContextValue(value);
    if (!normalizedMemberKey || !normalizedValue) {
        return;
    }

    if (!aggregate[normalizedMemberKey] || typeof aggregate[normalizedMemberKey] !== 'object' || Array.isArray(aggregate[normalizedMemberKey])) {
        aggregate[normalizedMemberKey] = {};
    }

    const memberCounters = aggregate[normalizedMemberKey];
    const counter = memberCounters[normalizedValue];
    if (!counter || typeof counter !== 'object' || Array.isArray(counter)) {
        memberCounters[normalizedValue] = { games: 1, wins: didWin ? 1 : 0 };
    } else {
        counter.games = Number(counter.games ?? 0) + 1;
        counter.wins = Number(counter.wins ?? 0) + (didWin ? 1 : 0);
    }

    const counterEntries = Object.entries(memberCounters);
    if (counterEntries.length > LINEUP_CONTEXT_COUNTER_LIMIT) {
        counterEntries
            .sort(([, left], [, right]) => {
                const byGames = Number(right?.games ?? 0) - Number(left?.games ?? 0);
                if (byGames !== 0) return byGames;
                return Number(right?.wins ?? 0) - Number(left?.wins ?? 0);
            })
            .slice(LINEUP_CONTEXT_COUNTER_LIMIT)
            .forEach(([key]) => {
                delete memberCounters[key];
            });
    }
}

function updateLineupContextAggregates({ record, lineupMemberKeys, lineupMemberMetadata, didWin }) {
    if (!lineupMemberMetadata || typeof lineupMemberMetadata !== 'object') {
        return;
    }

    if (!record.rolesByMember || typeof record.rolesByMember !== 'object' || Array.isArray(record.rolesByMember)) {
        record.rolesByMember = {};
    }
    if (!record.championsByMember || typeof record.championsByMember !== 'object' || Array.isArray(record.championsByMember)) {
        record.championsByMember = {};
    }

    for (const memberKey of lineupMemberKeys) {
        const metadata = getLineupMemberMetadata(lineupMemberMetadata, memberKey);
        if (!metadata) continue;

        const memberDidWin = typeof metadata.didWin === 'boolean' ? metadata.didWin : didWin;
        incrementContextCounter({
            aggregate: record.rolesByMember,
            memberKey,
            value: metadata.role,
            didWin: memberDidWin,
        });
        incrementContextCounter({
            aggregate: record.championsByMember,
            memberKey,
            value: metadata.champion,
            didWin: memberDidWin,
        });
    }
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

export async function recordLolLineupResult({ guildId, queueType, lineupMemberKeys, lineupMemberMetadata = null, didWin, matchId, gameMs }) {
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
        
        updateLineupContextAggregates({
            record: existing,
            lineupMemberKeys: lineupKey.split(LINEUP_DELIMITER),
            lineupMemberMetadata,
            didWin,
        });

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
                rolesByMember: stats.rolesByMember,
                championsByMember: stats.championsByMember,
            },
        ])
    );
}
