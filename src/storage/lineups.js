import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const LINEUP_DELIMITER = '|';
const LINEUP_CONTEXT_COUNTER_LIMIT = 25;

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

function isEligibleLolLineupSize(queueType, size) {
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

function toDbQueueType(queueType) {
    return typeof queueType === 'string' && queueType.trim() ? queueType.trim() : null;
}

function getLineupSeenAt(gameMs) {
    return Number.isFinite(gameMs) ? Math.trunc(gameMs) : Date.now();
}

function runStatement(statement, ...params) {
    return statement.run(...params);
}

function upsertContextCounter({ db, guildId, queueType, lineupKey, memberKey, contextType, value, didWin }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedValue = normalizeContextValue(value);
    if (!normalizedMemberKey || !normalizedValue) {
        return;
    }

    runStatement(
        db.prepare(`
            INSERT INTO lineup_context_counter (
                guild_id,
                queue_type,
                lineup_key,
                member_key,
                context_type,
                context_value,
                games,
                wins
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(guild_id, queue_type, lineup_key, member_key, context_type, context_value)
            DO UPDATE SET
                games = games + 1,
                wins = wins + excluded.wins
        `),
        guildId,
        queueType,
        lineupKey,
        normalizedMemberKey,
        contextType,
        normalizedValue,
        didWin ? 1 : 0
    );

    runStatement(
        db.prepare(`
            DELETE FROM lineup_context_counter
            WHERE guild_id = ?
              AND queue_type = ?
              AND lineup_key = ?
              AND member_key = ?
              AND context_type = ?
              AND context_value NOT IN (
                  SELECT context_value
                  FROM lineup_context_counter
                  WHERE guild_id = ?
                    AND queue_type = ?
                    AND lineup_key = ?
                    AND member_key = ?
                    AND context_type = ?
                  ORDER BY games DESC, wins DESC, context_value ASC
                  LIMIT ?
              )
        `),
        guildId,
        queueType,
        lineupKey,
        normalizedMemberKey,
        contextType,
        guildId,
        queueType,
        lineupKey,
        normalizedMemberKey,
        contextType,
        LINEUP_CONTEXT_COUNTER_LIMIT
    );
}

function updateLineupContextAggregates({ db, guildId, queueType, lineupKey, lineupMemberKeys, lineupMemberMetadata, didWin }) {
    if (!lineupMemberMetadata || typeof lineupMemberMetadata !== 'object') {
        return;
    }

    for (const memberKey of lineupMemberKeys) {
        const metadata = getLineupMemberMetadata(lineupMemberMetadata, memberKey);
        if (!metadata) continue;

        const memberDidWin = typeof metadata.didWin === 'boolean' ? metadata.didWin : didWin;
        upsertContextCounter({
            db,
            guildId,
            queueType,
            lineupKey,
            memberKey,
            contextType: 'role',
            value: metadata.role,
            didWin: memberDidWin,
        });
        upsertContextCounter({
            db,
            guildId,
            queueType,
            lineupKey,
            memberKey,
            contextType: 'champion',
            value: metadata.champion,
            didWin: memberDidWin,
        });
    }
}

function addContextCounter(target, { memberKey, contextType, contextValue, games, wins }) {
    const groupKey = contextType === 'role' ? 'rolesByMember' : 'championsByMember';
    if (!target[groupKey]) {
        target[groupKey] = {};
    }
    if (!target[groupKey][memberKey]) {
        target[groupKey][memberKey] = {};
    }

    const memberCounters = target[groupKey][memberKey];
    const existing = memberCounters[contextValue];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        existing.games = Number(existing.games ?? 0) + Number(games ?? 0);
        existing.wins = Number(existing.wins ?? 0) + Number(wins ?? 0);
    } else {
        memberCounters[contextValue] = {
            games: Number(games ?? 0),
            wins: Number(wins ?? 0),
        };
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
    const lineupMembers = lineupKey ? lineupKey.split(LINEUP_DELIMITER) : [];
    const lineupSize = lineupMembers.length;
    const dbQueueType = toDbQueueType(queueType);

    if (!guildId || typeof guildId !== 'string') {
        return { recorded: false, reason: 'invalid_guild_id' };
    }
    if (!lineupKey) {
        return { recorded: false, reason: 'invalid_lineup' };
    }
    if (!isEligibleLolLineupSize(queueType, lineupSize)) {
        return { recorded: false, reason: 'ineligible_size' };
    }
    if (!dbQueueType) {
        return { recorded: false, reason: 'invalid_queue_type' };
    }

    return withSqliteTransaction((db) => {
        const matchIdNormalized = normalizeMatchId(matchId);
        const seenAt = getLineupSeenAt(gameMs);

        if (matchIdNormalized) {
            const existingMatch = db.prepare(`
                SELECT 1
                FROM lineup_match_seen
                WHERE guild_id = ?
                  AND queue_type = ?
                  AND lineup_key = ?
                  AND match_id = ?
            `).get(guildId, dbQueueType, lineupKey, matchIdNormalized);

            if (existingMatch) {
                return { recorded: false, reason: 'duplicate_match', didChange: false };
            }
        }
        
        runStatement(
            db.prepare(`
                INSERT INTO lineup_stats (
                    guild_id,
                    queue_type,
                    lineup_key,
                    lineup_size,
                    games,
                    wins,
                    losses,
                    first_seen_at,
                    last_seen_at
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT(guild_id, queue_type, lineup_key)
                DO UPDATE SET
                    lineup_size = excluded.lineup_size,
                    games = games + 1,
                    wins = wins + excluded.wins,
                    losses = losses + excluded.losses,
                    last_seen_at = excluded.last_seen_at
            `),
            guildId,
            dbQueueType,
            lineupKey,
            lineupSize,
            didWin ? 1 : 0,
            didWin ? 0 : 1,
            seenAt,
            seenAt
        );

        if (matchIdNormalized) {
            runStatement(
                db.prepare(`
                    INSERT INTO lineup_match_seen (
                        guild_id,
                        queue_type,
                        lineup_key,
                        match_id,
                        seen_at
                    ) VALUES (?, ?, ?, ?, ?)
                `),
                guildId,
                dbQueueType,
                lineupKey,
                matchIdNormalized,
                seenAt
            );
        }
        
        updateLineupContextAggregates({
            db,
            guildId,
            queueType: dbQueueType,
            lineupKey,
            lineupMemberKeys: lineupMembers,
            lineupMemberMetadata,
            didWin,
        });

        return { recorded: true, lineupKey };
    });
}

export async function getGuildLineupStats(guildId) {
    if (!guildId || typeof guildId !== 'string') {
        return {};
    }

    const db = await getSqliteDb();
    const statsRows = db.prepare(`
        SELECT
            lineup_key AS lineupKey,
            SUM(games) AS games,
            SUM(wins) AS wins,
            SUM(losses) AS losses,
            MIN(first_seen_at) AS firstSeenAt,
            MAX(last_seen_at) AS lastSeenAt
        FROM lineup_stats
        WHERE guild_id = ?
        GROUP BY lineup_key
    `).all(guildId);

    const lineups = Object.fromEntries(statsRows.map((row) => [
        row.lineupKey,
        {
            games: Number(row.games ?? 0),
            wins: Number(row.wins ?? 0),
            losses: Number(row.losses ?? 0),
            firstSeenAt: Number(row.firstSeenAt ?? 0),
            lastSeenAt: Number(row.lastSeenAt ?? 0),
            rolesByMember: {},
            championsByMember: {},
        },
    ]));

    const contextRows = db.prepare(`
        SELECT
            lineup_key AS lineupKey,
            member_key AS memberKey,
            context_type AS contextType,
            context_value AS contextValue,
            SUM(games) AS games,
            SUM(wins) AS wins
        FROM lineup_context_counter
        WHERE guild_id = ?
        GROUP BY lineup_key, member_key, context_type, context_value
        ORDER BY games DESC, wins DESC, context_value ASC
    `).all(guildId);

    for (const row of contextRows) {
        const target = lineups[row.lineupKey];
        if (!target || (row.contextType !== 'role' && row.contextType !== 'champion')) {
            continue;
        }
        addContextCounter(target, row);
    }

    return lineups;
}
