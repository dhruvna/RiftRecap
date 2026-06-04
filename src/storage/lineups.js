import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const LINEUP_DELIMITER = '|';
const CONTEXT_TYPES = Object.freeze({
    CHAMPION_ROLE: 'champion_by_role',
});

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

function buildChampionRoleContextValue(champion, role) {
    const normalizedChampion = normalizeContextValue(champion);
    const normalizedRole = normalizeContextValue(role);
    if (!normalizedChampion || !normalizedRole) {
        return null;
    }
    return JSON.stringify([normalizedRole, normalizedChampion]);
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

export function getChampionRoleParts(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    try {
        const parsed = JSON.parse(value.trim());
        if (!Array.isArray(parsed) || parsed.length !== 2) {
            return null;
        }
        const [first, second] = parsed;
        const role = normalizeContextValue(first);
        const champion = normalizeContextValue(second);
        return role && champion ? { champion, role, value: buildChampionRoleContextValue(champion, role) } : null;
    } catch {
        return null;
    }
}

function upsertMemberContextCounter({ db, guildId, memberKey, contextType, value, didWin }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedValue = normalizeContextValue(value);
    if (!normalizedMemberKey || !normalizedValue) {
        return false;
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
    return true;
}

function recordMemberContextForMatch({ db, guildId, memberKey, metadata, didWin, matchId, seenAt }) {
    if (!metadata) {
        return false;
    }

    const normalizedRole = normalizeContextValue(metadata.role);
    const normalizedChampion = normalizeContextValue(metadata.champion);
    if (!normalizedRole || !normalizedChampion) {
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
    const didRecordCounter = upsertMemberContextCounter({
        db,
        guildId,
        memberKey,
        contextType: CONTEXT_TYPES.CHAMPION_ROLE,
        value: buildChampionRoleContextValue(normalizedChampion, normalizedRole),
        didWin: memberDidWin,
    });

    if (didRecordCounter && matchIdNormalized) {
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

    return didRecordCounter;
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

    const normalizedMemberKeys = normalizeMemberKeys(memberKeys);
    const candidateMemberKeys = normalizedMemberKeys.length > 0
        ? normalizedMemberKeys
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

function emptyContextStats() {
    return {
        roles: {},
        champions: {},
        championRoles: {},
    };
}

function addContextStats(target, row) {
    const games = Number(row.games ?? 0);
    const wins = Number(row.wins ?? 0);
    if (!row.contextValue || games <= 0) {
        return;
    }

    if (row.contextType !== CONTEXT_TYPES.CHAMPION_ROLE) {
        return;
    }

    const parsed = getChampionRoleParts(row.contextValue);
    if (!parsed) {
        return;
    }

    target.championRoles[parsed.value] = { games, wins };
    target.roles[parsed.role] = {
        games: Number(target.roles[parsed.role]?.games ?? 0) + games,
        wins: Number(target.roles[parsed.role]?.wins ?? 0) + wins,
    };
    target.champions[parsed.champion] = {
        games: Number(target.champions[parsed.champion]?.games ?? 0) + games,
        wins: Number(target.champions[parsed.champion]?.wins ?? 0) + wins,
    };
}

export async function getLolMemberContextStats(guildId, memberKey) {
    if (!guildId || typeof guildId !== 'string' || !memberKey || typeof memberKey !== 'string') {
        return emptyContextStats();
    }

    const normalizedMemberKey = memberKey.trim();
    if (!normalizedMemberKey) {
        return emptyContextStats();
    }

    const db = await getSqliteDb();
    const rows = db.prepare(`
        SELECT
            context_type AS contextType,
            context_value AS contextValue,
            SUM(games) AS games,
            SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion_by_role'
        GROUP BY context_type, context_value
        ORDER BY games DESC, wins DESC, context_value ASC
    `).all(guildId, normalizedMemberKey);

    const stats = emptyContextStats();
    for (const row of rows) {
        addContextStats(stats, row);
    }
    return stats;
}

export async function getGuildLineupStats(guildId, { includeMemberContextFor = null } = {}) {
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
            championsByRoleByMember: {},
        },
    ]));

    const normalizedMemberKey = typeof includeMemberContextFor === 'string' ? includeMemberContextFor.trim() : '';
    if (!normalizedMemberKey) {
        return lineups;
    }

    const memberContext = await getLolMemberContextStats(guildId, normalizedMemberKey);
    for (const [lineupKey, lineup] of Object.entries(lineups)) {
        const lineupMembers = lineupKey.split(LINEUP_DELIMITER).map((memberKey) => memberKey.trim());
        if (!lineupMembers.includes(normalizedMemberKey)) {
            continue;
        }
        lineup.rolesByMember[normalizedMemberKey] = memberContext.roles;
        lineup.championsByMember[normalizedMemberKey] = memberContext.champions;
        lineup.championsByRoleByMember[normalizedMemberKey] = {};
        for (const [contextValue, counter] of Object.entries(memberContext.championRoles)) {
            const parsed = getChampionRoleParts(contextValue);
            if (!parsed) {
                continue;
            }
            if (!lineup.championsByRoleByMember[normalizedMemberKey][parsed.role]) {
                lineup.championsByRoleByMember[normalizedMemberKey][parsed.role] = {};
            }
            lineup.championsByRoleByMember[normalizedMemberKey][parsed.role][parsed.champion] = counter;
        }
    }
    
    return lineups;
}
