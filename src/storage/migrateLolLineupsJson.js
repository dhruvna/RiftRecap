import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChampionByRoleContextValue, buildLineupKey, normalizeContextValue } from './lineups.js';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const DEFAULT_LEGACY_LINEUPS_PATH = path.join(process.env.DATA_DIR ?? 'user_data', 'lol_lineups.json');
const DEFAULT_MIGRATION_NAME = 'lol_lineups_json_v4';
const LINEUP_DELIMITER = '|';
const CONTEXT_TYPES = Object.freeze({
    rolesByMember: 'role',
    championsByMember: 'champion',
});
const CHAMPION_BY_ROLE_CONTEXT_TYPE = 'champion_by_role';

function resolveLegacyLineupsPath(legacyPath = process.env.LOL_LINEUPS_DATA_PATH ?? DEFAULT_LEGACY_LINEUPS_PATH) {
    return path.resolve(legacyPath);
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        return fallback;
    }
    return Math.trunc(number);
}

function normalizeLineupKey(lineupKey) {
    if (typeof lineupKey !== 'string') {
        return null;
    }
    return buildLineupKey(lineupKey.split(LINEUP_DELIMITER)) || null;
}

function hasLineupStats(entry) {
    return isObject(entry) && (
        Object.hasOwn(entry, 'wins')
        || Object.hasOwn(entry, 'losses')
        || Object.hasOwn(entry, 'games')
    );
}

function hasLegacyContext(entry) {
    return isObject(entry) && (
        isObject(entry.rolesByMember)
        || isObject(entry.championsByMember)
        || isObject(entry.championsByRoleByMember)
    );
}

function getLineupStats(entry) {
    const wins = toNonNegativeInteger(entry?.wins);
    let losses = toNonNegativeInteger(entry?.losses);
    let games = toNonNegativeInteger(entry?.games, wins + losses);

    if (!Object.hasOwn(entry, 'losses') && games >= wins) {
        losses = games - wins;
    }
    games = Math.max(games, wins + losses);

    return { games, wins, losses };
}

function getCounterStats(counter) {
    if (typeof counter === 'number' || typeof counter === 'string') {
        return { games: toNonNegativeInteger(counter), wins: 0 };
    }
    if (!isObject(counter)) {
        return { games: 0, wins: 0 };
    }

    const wins = toNonNegativeInteger(counter.wins);
    const losses = toNonNegativeInteger(counter.losses);
    const count = counter.games ?? counter.count ?? counter.total;
    const games = Math.max(toNonNegativeInteger(count, wins + losses), wins + losses);
    return { games, wins };
}

function getTimestamp(entry, key, fallback) {
    const value = Number(entry?.[key]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeSeenMatchIds(entry) {
    if (!Array.isArray(entry?.seenMatchIds)) {
        return [];
    }

    return [...new Set(entry.seenMatchIds
        .map((matchId) => (typeof matchId === 'string' ? matchId.trim() : ''))
        .filter(Boolean))];
}

function getDedupedCounterStats({ existing, games, wins, seenMatchIds }) {
    if (!Array.isArray(seenMatchIds) || seenMatchIds.length === 0) {
        return { games, wins };
    }

    const existingSeenMatchIds = existing.seenMatchIds ?? new Set();
    const newSeenMatchIds = seenMatchIds.filter((matchId) => !existingSeenMatchIds.has(matchId));
    for (const matchId of newSeenMatchIds) {
        existingSeenMatchIds.add(matchId);
    }
    existing.seenMatchIds = existingSeenMatchIds;

    if (newSeenMatchIds.length === 0) {
        return { games: 0, wins: 0 };
    }

    const dedupedGames = Math.min(games, newSeenMatchIds.length);
    if (dedupedGames <= 0) {
        return { games: 0, wins: 0 };
    }

    const dedupedWins = games > 0
        ? Math.min(dedupedGames, Math.round((wins * dedupedGames) / games))
        : 0;
    return { games: dedupedGames, wins: dedupedWins };
}

function addContextAggregate(contextAggregates, { guildId, memberKey, contextType, contextValue, games, wins, seenMatchIds }) {
    if (!memberKey || !contextValue || games <= 0) {
        return false;
    }

    const aggregateKey = JSON.stringify([guildId, memberKey, contextType, contextValue]);
    const existing = contextAggregates.get(aggregateKey) ?? {
        guildId,
        memberKey,
        contextType,
        contextValue,
        games: 0,
        wins: 0,
        seenMatchIds: new Set(),
    };
    const dedupedStats = getDedupedCounterStats({ existing, games, wins, seenMatchIds });
    existing.games += dedupedStats.games;
    existing.wins += dedupedStats.wins;
    contextAggregates.set(aggregateKey, existing);
    return true;
}

function addContextMatchSeenRows(contextMatchSeenRows, { guildId, memberKey, seenMatchIds, seenAt }) {
    if (!contextMatchSeenRows || !memberKey || !Array.isArray(seenMatchIds) || seenMatchIds.length === 0) {
        return;
    }

    for (const matchId of seenMatchIds) {
        contextMatchSeenRows.set(JSON.stringify([guildId, memberKey, matchId]), {
            guildId,
            memberKey,
            matchId,
            seenAt,
        });
    }
}

function collectContextAggregates(contextAggregates, { guildId, entry, seenMatchIds, contextMatchSeenRows, seenAt }) {
    for (const [legacyKey, contextType] of Object.entries(CONTEXT_TYPES)) {
        const byMember = entry?.[legacyKey];
        if (!isObject(byMember)) {
            continue;
        }

        for (const [rawMemberKey, counters] of Object.entries(byMember)) {
            const memberKey = typeof rawMemberKey === 'string' ? rawMemberKey.trim() : '';
            if (!memberKey || !isObject(counters)) {
                continue;
            }

            for (const [rawContextValue, counter] of Object.entries(counters)) {
                const contextValue = normalizeContextValue(rawContextValue);
                const { games, wins } = getCounterStats(counter);
                const didAddContext = addContextAggregate(contextAggregates, {
                    guildId,
                    memberKey,
                    contextType,
                    contextValue,
                    games,
                    wins,
                    seenMatchIds,
                });
                if (didAddContext) {
                    addContextMatchSeenRows(contextMatchSeenRows, { guildId, memberKey, seenMatchIds, seenAt });
                }
            }
        }
    }
    const championsByRoleByMember = entry?.championsByRoleByMember;
    if (!isObject(championsByRoleByMember)) {
        return;
    }

    for (const [rawMemberKey, roles] of Object.entries(championsByRoleByMember)) {
        const memberKey = typeof rawMemberKey === 'string' ? rawMemberKey.trim() : '';
        if (!memberKey || !isObject(roles)) {
            continue;
        }

        for (const [rawRole, champions] of Object.entries(roles)) {
            if (!isObject(champions)) {
                continue;
            }

            for (const [rawChampion, counter] of Object.entries(champions)) {
                const contextValue = buildChampionByRoleContextValue(rawRole, rawChampion);
                const { games, wins } = getCounterStats(counter);
                const didAddContext = addContextAggregate(contextAggregates, {
                    guildId,
                    memberKey,
                    contextType: CHAMPION_BY_ROLE_CONTEXT_TYPE,
                    contextValue,
                    games,
                    wins,
                    seenMatchIds,
                });
                if (didAddContext) {
                    addContextMatchSeenRows(contextMatchSeenRows, { guildId, memberKey, seenMatchIds, seenAt });
                }
            }
        }
    }
}

function findGuildLineups(guildValue) {
    if (!isObject(guildValue)) {
        return {};
    }
    if (isObject(guildValue.lineups)) {
        return guildValue.lineups;
    }
    return guildValue;
}

function addLineupAggregate(lineupAggregates, { guildId, lineupKey, lineupSize, games, wins, losses, firstSeenAt, lastSeenAt, seenMatchIds }) {
    if (games <= 0 && wins <= 0 && losses <= 0) {
        return;
    }

    const aggregateKey = JSON.stringify([guildId, lineupKey]);
    const existing = lineupAggregates.get(aggregateKey) ?? {
        guildId,
        lineupKey,
        lineupSize,
        games: 0,
        wins: 0,
        losses: 0,
        firstSeenAt,
        lastSeenAt,
        seenMatchIds: new Set(),
    };

    existing.lineupSize = lineupSize;
    existing.games += games;
    existing.wins += wins;
    existing.losses += losses;
    existing.firstSeenAt = Math.min(existing.firstSeenAt, firstSeenAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt);
    for (const matchId of seenMatchIds ?? []) {
        existing.seenMatchIds.add(matchId);
    }
    lineupAggregates.set(aggregateKey, existing);
}

function buildImportPlan(parsed, now = Date.now()) {
    const lineupAggregates = new Map();
    const contextAggregates = new Map();
    const contextMatchSeenRows = new Map();

    if (!isObject(parsed)) {
        throw new Error('[migrateLolLineupsJson] Legacy lol_lineups.json root must be an object keyed by guildId.');
    }

    for (const [guildId, guildValue] of Object.entries(parsed)) {
        if (!guildId || !isObject(guildValue)) {
            continue;
        }

        const guildLineups = findGuildLineups(guildValue);
        for (const [rawLineupKey, rawEntry] of Object.entries(guildLineups)) {
            if (!isObject(rawEntry) || (!hasLineupStats(rawEntry) && !hasLegacyContext(rawEntry))) {
                continue;
            }

            const lineupKey = normalizeLineupKey(rawLineupKey);
            if (!lineupKey) {
                continue;
            }

            const lineupSize = lineupKey.split(LINEUP_DELIMITER).length;
            const stats = getLineupStats(rawEntry);
            const seenMatchIds = normalizeSeenMatchIds(rawEntry);
            const firstSeenAt = getTimestamp(rawEntry, 'firstSeenAt', now);
            const lastSeenAt = getTimestamp(rawEntry, 'lastSeenAt', firstSeenAt);

            addLineupAggregate(lineupAggregates, {
                guildId,
                lineupKey,
                lineupSize,
                ...stats,
                firstSeenAt,
                lastSeenAt,
                seenMatchIds,
            });
            collectContextAggregates(contextAggregates, {
                guildId,
                entry: rawEntry,
                seenMatchIds,
                contextMatchSeenRows,
                seenAt: lastSeenAt,
            });
        }
    }

    return {
        lineups: [...lineupAggregates.values()].map((lineup) => ({
            ...lineup,
            seenMatchIds: [...lineup.seenMatchIds],
        })),
        contextRows: [...contextAggregates.values()].map(({ seenMatchIds, ...row }) => row),
        contextMatchSeenRows: [...contextMatchSeenRows.values()],
    };
}

async function readLegacyJson(filePath) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    return JSON.parse(raw);
}

function getMigrationMarker(db, migrationName) {
    return db.prepare(`
        SELECT migration_name AS migrationName, applied_at AS appliedAt
        FROM storage_migrations
        WHERE migration_name = ?
    `).get(migrationName);
}

function insertMigrationMarker(db, migrationName, details, now) {
    db.prepare(`
        INSERT INTO storage_migrations (migration_name, applied_at, details)
        VALUES (?, ?, ?)
        ON CONFLICT(migration_name) DO NOTHING
    `).run(migrationName, now, JSON.stringify(details));
}

function applyImportPlan(db, { migrationName, legacyPath, plan, now }) {
    const existingMarker = getMigrationMarker(db, migrationName);
    if (existingMarker) {
        return {
            didRun: false,
            reason: 'already_applied',
            legacyPath,
            migrationName,
            importedLineups: 0,
            importedContextRows: 0,
            importedContextMatchSeenRows: 0,
        };
    }

    const insertLineup = db.prepare(`
        INSERT INTO lineup_stats (
            guild_id,
            lineup_key,
            lineup_size,
            games,
            wins,
            losses,
            first_seen_at,
            last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, lineup_key)
        DO UPDATE SET
            lineup_size = excluded.lineup_size,
            games = MAX(games, excluded.games),
            wins = MAX(wins, excluded.wins),
            losses = MAX(losses, excluded.losses),
            first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
            last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
    `);

    const insertLineupMatchSeen = db.prepare(`
        INSERT INTO lineup_match_seen (
            guild_id,
            lineup_key,
            match_id,
            seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, lineup_key, match_id) DO NOTHING
    `);

    for (const lineup of plan.lineups) {
        insertLineup.run(
            lineup.guildId,
            lineup.lineupKey,
            lineup.lineupSize,
            lineup.games,
            lineup.wins,
            lineup.losses,
            lineup.firstSeenAt,
            lineup.lastSeenAt
        );

        for (const matchId of lineup.seenMatchIds) {
            insertLineupMatchSeen.run(
                lineup.guildId,
                lineup.lineupKey,
                matchId,
                lineup.lastSeenAt
            );
        }
    }

    const insertContext = db.prepare(`
        INSERT INTO lol_member_context_counter (
            guild_id,
            member_key,
            context_type,
            context_value,
            games,
            wins
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, member_key, context_type, context_value)
        DO UPDATE SET
            games = excluded.games,
            wins = excluded.wins
    `);

    for (const row of plan.contextRows) {
        insertContext.run(
            row.guildId,
            row.memberKey,
            row.contextType,
            row.contextValue,
            row.games,
            row.wins
        );
    }

    const insertContextMatchSeen = db.prepare(`
        INSERT INTO lol_member_context_match_seen (
            guild_id,
            member_key,
            match_id,
            seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, member_key, match_id) DO NOTHING
    `);

    for (const row of plan.contextMatchSeenRows) {
        insertContextMatchSeen.run(
            row.guildId,
            row.memberKey,
            row.matchId,
            row.seenAt
        );
    }

    const details = {
        legacyPath,
        importedLineups: plan.lineups.length,
        importedContextRows: plan.contextRows.length,
        importedContextMatchSeenRows: plan.contextMatchSeenRows.length,
    };
    insertMigrationMarker(db, migrationName, details, now);

    return {
        didRun: true,
        reason: 'imported',
        migrationName,
        legacyPath,
        ...details,
    };
}

export async function migrateLegacyLolLineupsJson({
    legacyPath = process.env.LOL_LINEUPS_DATA_PATH ?? DEFAULT_LEGACY_LINEUPS_PATH,
    migrationName = DEFAULT_MIGRATION_NAME,
} = {}) {
    const resolvedLegacyPath = resolveLegacyLineupsPath(legacyPath);
    const parsed = await readLegacyJson(resolvedLegacyPath);
    if (!parsed) {
        return {
            didRun: false,
            reason: 'missing_legacy_file',
            migrationName,
            legacyPath: resolvedLegacyPath,
            importedLineups: 0,
            importedContextRows: 0,
            importedContextMatchSeenRows: 0,
        };
    }

    const now = Date.now();
    const plan = buildImportPlan(parsed, now);
    return withSqliteTransaction((db) => applyImportPlan(db, {
        migrationName,
        legacyPath: resolvedLegacyPath,
        plan,
        now,
    }));
}

async function main() {
    await getSqliteDb();
    const result = await migrateLegacyLolLineupsJson();
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
