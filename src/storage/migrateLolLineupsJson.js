import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const DEFAULT_LEGACY_LINEUPS_PATH = path.join(process.env.DATA_DIR ?? 'user_data', 'lol_lineups.json');
const DEFAULT_MIGRATION_NAME = 'lol_lineups_json_v1';
const LINEUP_DELIMITER = '|';
const CONTEXT_TYPES = Object.freeze({
    rolesByMember: 'role',
    championsByMember: 'champion',
});

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
    const members = lineupKey
        .split(LINEUP_DELIMITER)
        .map((memberKey) => memberKey.trim())
        .filter(Boolean);
    return members.length > 0 ? members.join(LINEUP_DELIMITER) : null;
}


function hasLineupStats(entry) {
    return isObject(entry) && (
        Object.hasOwn(entry, 'wins')
        || Object.hasOwn(entry, 'losses')
        || Object.hasOwn(entry, 'games')
    );
}

function hasLegacyContext(entry) {
    return isObject(entry) && (isObject(entry.rolesByMember) || isObject(entry.championsByMember));
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

function addContextAggregate(contextAggregates, { guildId, memberKey, contextType, contextValue, games, wins }) {
    if (!memberKey || !contextValue || games <= 0) {
        return;
    }

    const aggregateKey = JSON.stringify([guildId, memberKey, contextType, contextValue]);
    const existing = contextAggregates.get(aggregateKey) ?? {
        guildId,
        memberKey,
        contextType,
        contextValue,
        games: 0,
        wins: 0,
    };
    existing.games += games;
    existing.wins += wins;
    contextAggregates.set(aggregateKey, existing);
}

function collectContextAggregates(contextAggregates, { guildId, entry }) {
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
                const contextValue = typeof rawContextValue === 'string' ? rawContextValue.trim() : '';
                const { games, wins } = getCounterStats(counter);
                addContextAggregate(contextAggregates, {
                    guildId,
                    memberKey,
                    contextType,
                    contextValue,
                    games,
                    wins,
                });
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

function buildImportPlan(parsed, now = Date.now()) {
    const lineups = [];
    const contextAggregates = new Map();

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
            const firstSeenAt = getTimestamp(rawEntry, 'firstSeenAt', now);
            const lastSeenAt = getTimestamp(rawEntry, 'lastSeenAt', firstSeenAt);

            if (stats.games > 0 || stats.wins > 0 || stats.losses > 0) {
                lineups.push({
                    guildId,
                    lineupKey,
                    lineupSize,
                    ...stats,
                    firstSeenAt,
                    lastSeenAt,
                });
            }

            collectContextAggregates(contextAggregates, { guildId, entry: rawEntry });
        }
    }

    return {
        lineups,
        contextRows: [...contextAggregates.values()],
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
            games = MAX(games, excluded.games),
            wins = MAX(wins, excluded.wins)
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

    const details = {
        legacyPath,
        importedLineups: plan.lineups.length,
        importedContextRows: plan.contextRows.length,
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
