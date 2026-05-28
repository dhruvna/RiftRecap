import fs from 'node:fs/promises';
import path from 'node:path';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';

const DEFAULT_LINEUPS_DATA_PATH = path.join(process.cwd(), 'user_data', 'lol_lineups.json');
const LINEUPS_DATA_PATH = process.env.LOL_LINEUPS_DATA_PATH
    ? path.resolve(process.env.LOL_LINEUPS_DATA_PATH)
    : path.join(process.env.DATA_DIR ?? path.dirname(DEFAULT_LINEUPS_DATA_PATH), 'lol_lineups.json');

const LINEUP_DELIMITER = '|';
const RECENT_MATCH_IDS_LIMIT = 25;
const SEEN_MATCH_IDS_LIMIT = 1500;

let writeQueue = Promise.resolve();
let dbCache = null;
let dbCacheFileMeta = null;

async function getDbFileMeta() {
    await ensureDataFile();
    const stats = await fs.stat(LINEUPS_DATA_PATH);
    return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
    };
}

function isSameDbFileMeta(left, right) {
    if (!left || !right) {
        return false;
    }
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function enqueueWrite(operation) {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
}

async function ensureDataFile() {
    const dir = path.dirname(LINEUPS_DATA_PATH);
    await fs.mkdir(dir, { recursive: true });

    try {
        await fs.access(LINEUPS_DATA_PATH);
    } catch {
        await fs.writeFile(LINEUPS_DATA_PATH, '{}', 'utf8');
    }
}

async function writeDbAtomically(db) {
    await ensureDataFile();
    const tmp = `${LINEUPS_DATA_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, LINEUPS_DATA_PATH);
}

async function loadDbFromDisk() {
    await ensureDataFile();
    const raw = await fs.readFile(LINEUPS_DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[lineups] lol_lineups.json root must be an object.');
    }
    return parsed;
}

async function loadDb({ forceReload = false } = {}) {
    if (!forceReload && dbCache) {
        const currentMeta = await getDbFileMeta();
        if (isSameDbFileMeta(dbCacheFileMeta, currentMeta)) {
            return dbCache;
        }
    }
    dbCache = await loadDbFromDisk();
    dbCacheFileMeta = await getDbFileMeta();
    return dbCache;
}

async function mutateDb(mutator) {
    return enqueueWrite(async () => {
        const db = await loadDb();
        const result = await mutator(db);
        const didChange = result?.didChange ?? true;
        if (didChange) {
            dbCache = db;
            await writeDbAtomically(db);
            dbCacheFileMeta = await getDbFileMeta();
        }
        return result;
    });
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

function normalizeMatchIdList(matchIds, limit) {
    if (!Array.isArray(matchIds) || limit <= 0) {
        return [];
    }

    const normalized = [];
    const seen = new Set();
    for (const value of matchIds) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        normalized.push(trimmed);
        if (normalized.length >= limit) {
            break;
        }
    }

    return normalized;
}

function normalizeLineupRecordForStorage(stats) {
    const normalized = stats && typeof stats === 'object' ? { ...stats } : {};
    normalized.games = Number.isFinite(normalized.games) ? normalized.games : 0;
    normalized.wins = Number.isFinite(normalized.wins) ? normalized.wins : 0;
    normalized.losses = Number.isFinite(normalized.losses) ? normalized.losses : 0;
    normalized.firstSeenAt = Number.isFinite(normalized.firstSeenAt) ? normalized.firstSeenAt : null;
    normalized.lastSeenAt = Number.isFinite(normalized.lastSeenAt) ? normalized.lastSeenAt : null;
    // Canonical purpose: lineup records retain one bounded match-id structure for dedupe only.
    // If we reintroduce user-facing match history later, it should live under a separate field
    // with independent retention and lifecycle semantics.
    const legacyRecent = normalizeMatchIdList(normalized.recentMatchIds, RECENT_MATCH_IDS_LIMIT);
    normalized.seenMatchIds = normalizeMatchIdList(
        Array.isArray(normalized.seenMatchIds) ? normalized.seenMatchIds : legacyRecent,
        SEEN_MATCH_IDS_LIMIT
    );
    delete normalized.recentMatchIds;
    return normalized;
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
        const existing = normalizeLineupRecordForStorage(lineups[lineupKey] ?? {
            games: 0,
            wins: 0,
            losses: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            recentMatchIds: [],
            seenMatchIds: [],
        });

        const now = Number.isFinite(gameMs) ? Math.trunc(gameMs) : Date.now();
        const matchIdNormalized = typeof matchId === 'string' && matchId.trim() ? matchId.trim() : null;
        const seen = normalizeMatchIdList(existing.seenMatchIds, SEEN_MATCH_IDS_LIMIT);
        
        const seenSet = new Set(seen);
        if (matchIdNormalized && seenSet.has(matchIdNormalized)) {
            return { recorded: false, reason: 'duplicate_match', didChange: false };
        }

        existing.games += 1;
        if (didWin) {
            existing.wins += 1;
        } else {
            existing.losses += 1;
        }

        existing.firstSeenAt = existing.firstSeenAt ?? now;
        existing.lastSeenAt = now;

        if (matchIdNormalized) {
            seenSet.delete(matchIdNormalized);
            seenSet.add(matchIdNormalized);
            existing.seenMatchIds = [matchIdNormalized, ...Array.from(seenSet).filter((id) => id !== matchIdNormalized)];
        } else {
            existing.seenMatchIds = Array.from(seenSet).slice(0, SEEN_MATCH_IDS_LIMIT);
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
        Object.entries(lineups).map(([lineupKey, stats]) => {
            const normalizedStats = normalizeLineupRecordForStorage(stats);
            return [
                lineupKey,
                {
                    games: normalizedStats.games,
                    wins: normalizedStats.wins,
                    losses: normalizedStats.losses,
                    firstSeenAt: normalizedStats.firstSeenAt,
                    lastSeenAt: normalizedStats.lastSeenAt,
                },
            ];
        })
    );
}
