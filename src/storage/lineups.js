import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const LINEUP_DELIMITER = '|';
const MEMBER_CONTEXT_COUNTER_LIMIT = 25;

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

function getLineupSeenAt(gameMs) {
    return Number.isFinite(gameMs) ? Math.trunc(gameMs) : Date.now();
}

function runStatement(statement, ...params) {
    return statement.run(...params);
}

function upsertMemberContextCounter({ db, guildId, memberKey, contextType, value, didWin }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedValue = normalizeContextValue(value);
    if (!normalizedMemberKey || !normalizedValue) {
        return;
    }

    runStatement(
        db.prepare(`
            INSERT INTO lol_member_context_counter (
                guild_id,
                member_key,
                context_type,
                context_value,
                games,
                wins
            ) VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(guild_id, member_key, context_type, context_value)
            DO UPDATE SET
                games = games + 1,
                wins = wins + excluded.wins
        `),
        guildId,
        normalizedMemberKey,
        contextType,
        normalizedValue,
        didWin ? 1 : 0
    );

    runStatement(
        db.prepare(`
            DELETE FROM lol_member_context_counter
            WHERE guild_id = ?
              AND member_key = ?
              AND context_type = ?
              AND context_value NOT IN (
                  SELECT context_value
                  FROM lol_member_context_counter
                  WHERE guild_id = ?
                    AND member_key = ?
                    AND context_type = ?
                  ORDER BY games DESC, wins DESC, context_value ASC
                  LIMIT ?
              )
        `),
        guildId,
        normalizedMemberKey,
        contextType,
        guildId,
        normalizedMemberKey,
        contextType,
        MEMBER_CONTEXT_COUNTER_LIMIT
    );
}

function normalizeMemberKeys(memberKeys) {
    if (!Array.isArray(memberKeys)) {
        return [];
    }
    return [...new Set(
        memberKeys
            .map((memberKey) => (typeof memberKey === 'string' ? memberKey.trim() : ''))
            .filter(Boolean)
    )];
}

function getMemberKeysFromMetadata(lineupMemberMetadata) {
    if (!lineupMemberMetadata || typeof lineupMemberMetadata !== 'object' || Array.isArray(lineupMemberMetadata)) {
        return [];
    }
    return normalizeMemberKeys(Object.keys(lineupMemberMetadata));
}

function recordMemberContextForMatch({ db, guildId, memberKey, metadata, didWin, matchId, seenAt }) {
    if (!metadata) {
        return false;
    }

    const matchIdNormalized = normalizeMatchId(matchId);
    if (matchIdNormalized) {
        const existingMemberMatch = db.prepare(`
            SELECT 1
            FROM lol_member_context_match_seen
            WHERE guild_id = ?
              AND member_key = ?
              AND match_id = ?
        `).get(guildId, memberKey, matchIdNormalized);

        if (existingMemberMatch) {
            return false;
        }
    }

    const memberDidWin = typeof metadata.didWin === 'boolean' ? metadata.didWin : didWin;
    upsertMemberContextCounter({
        db,
        guildId,
        memberKey,
        contextType: 'role',
        value: metadata.role,
        didWin: memberDidWin,
    });
    upsertMemberContextCounter({
        db,
        guildId,
        memberKey,
        contextType: 'champion',
        value: metadata.champion,
        didWin: memberDidWin,
    });

    if (matchIdNormalized) {
        runStatement(
            db.prepare(`
                INSERT INTO lol_member_context_match_seen (
                    guild_id,
                    member_key,
                    match_id,
                    seen_at
                ) VALUES (?, ?, ?, ?)
            `),
            guildId,
            memberKey,
            matchIdNormalized,
            seenAt
        );
    }

    return true;
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

export async function recordLolLineupResult({ guildId, queueType, lineupMemberKeys, didWin, matchId, gameMs }) {
    const lineupKey = buildLineupKey(lineupMemberKeys);
    const lineupMembers = lineupKey ? lineupKey.split(LINEUP_DELIMITER) : [];
    const lineupSize = lineupMembers.length;

    if (!guildId || typeof guildId !== 'string') {
        return { recorded: false, reason: 'invalid_guild_id' };
    }
    if (!lineupKey) {
        return { recorded: false, reason: 'invalid_lineup' };
    }
    if (!isEligibleLolLineupSize(queueType, lineupSize)) {
        return { recorded: false, reason: 'ineligible_size' };
    }

    return withSqliteTransaction((db) => {
        const matchIdNormalized = normalizeMatchId(matchId);
        const seenAt = getLineupSeenAt(gameMs);

        if (matchIdNormalized) {
            const existingMatch = db.prepare(`
                SELECT 1
                FROM lineup_match_seen
                WHERE guild_id = ?
                  AND lineup_key = ?
                  AND match_id = ?
             `).get(guildId, lineupKey, matchIdNormalized);

            if (existingMatch) {
                return { recorded: false, reason: 'duplicate_match', didChange: false };
            }
        }
        
        runStatement(
            db.prepare(`
                INSERT INTO lineup_stats (
                    guild_id,
                    lineup_key,
                    lineup_size,
                    games,
                    wins,
                    losses,
                    first_seen_at,
                    last_seen_at
                ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT(guild_id, lineup_key)
                DO UPDATE SET
                    lineup_size = excluded.lineup_size,
                    games = games + 1,
                    wins = wins + excluded.wins,
                    losses = losses + excluded.losses,
                    last_seen_at = excluded.last_seen_at
            `),
            guildId,
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
                        lineup_key,
                        match_id,
                        seen_at
                    ) VALUES (?, ?, ?, ?)
                `),
                guildId,
                lineupKey,
                matchIdNormalized,
                seenAt
            );
        }

        return { recorded: true, lineupKey };
    });
}

export async function recordLolMemberContextResult({ guildId, memberKeys = null, lineupMemberMetadata = null, didWin, matchId, gameMs }) {
    if (!guildId || typeof guildId !== 'string') {
        return { recorded: false, reason: 'invalid_guild_id' };
    }
    if (!lineupMemberMetadata || typeof lineupMemberMetadata !== 'object' || Array.isArray(lineupMemberMetadata)) {
        return { recorded: false, reason: 'invalid_metadata' };
    }

    const candidateMemberKeys = normalizeMemberKeys(memberKeys).length > 0
        ? normalizeMemberKeys(memberKeys)
        : getMemberKeysFromMetadata(lineupMemberMetadata);

    if (candidateMemberKeys.length === 0) {
        return { recorded: false, reason: 'invalid_members' };
    }

    return withSqliteTransaction((db) => {
        const seenAt = getLineupSeenAt(gameMs);
        let recordedMembers = 0;

        for (const memberKey of candidateMemberKeys) {
            const metadata = getLineupMemberMetadata(lineupMemberMetadata, memberKey);
            if (!metadata) continue;

            const didRecordMember = recordMemberContextForMatch({
                db,
                guildId,
                memberKey,
                metadata,
                didWin,
                matchId,
                seenAt,
            });

            if (didRecordMember) {
                recordedMembers += 1;
            }
        }

        return { recorded: recordedMembers > 0, recordedMembers };
    });
}

export async function getGuildLineupStats(guildId, { includeMemberContextFor = null } = {}) {
    if (!guildId || typeof guildId !== 'string') {
        return {};
    }

    const db = await getSqliteDb();
    const normalizedContextMemberKey = typeof includeMemberContextFor === 'string' ? includeMemberContextFor.trim() : '';
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

    if (!normalizedContextMemberKey) {
        return lineups;
    }

    const contextRows = db.prepare(`
        SELECT
            member_key AS memberKey,
            context_type AS contextType,
            context_value AS contextValue,
            SUM(games) AS games,
            SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
            AND member_key = ?
        GROUP BY member_key, context_type, context_value
        ORDER BY games DESC, wins DESC, context_value ASC
    `).all(guildId, normalizedContextMemberKey);
    
    const contextByMember = new Map();
    for (const row of contextRows) {
        if (row.contextType !== 'role' && row.contextType !== 'champion') {
            continue;
        }
        const memberContext = contextByMember.get(row.memberKey) ?? [];
        memberContext.push(row);
        contextByMember.set(row.memberKey, memberContext);
    }

    for (const [lineupKey, target] of Object.entries(lineups)) {
        const memberKeys = lineupKey.split(LINEUP_DELIMITER).map((memberKey) => memberKey.trim()).filter(Boolean);
        if (!memberKeys.includes(normalizedContextMemberKey)) {
            continue;
        }
        const memberContextRows = contextByMember.get(normalizedContextMemberKey) ?? [];
        for (const row of memberContextRows) {
            addContextCounter(target, row);
        }
    }
    return lineups;
}
