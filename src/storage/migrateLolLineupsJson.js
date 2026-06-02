import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChampionRoleContextValue, buildLineupKey, normalizeContextValue } from './lineups.js';
import { getSqliteDb, withSqliteTransaction } from './sqlite.js';

const DEFAULT_LEGACY_LINEUPS_PATH = path.join(process.env.DATA_DIR ?? 'user_data', 'lol_lineups.json');
const DEFAULT_MIGRATION_NAME = 'lol_lineups_json_simple_v3';
const LINEUP_DELIMITER = '|';
const CONTEXT_TYPES = Object.freeze({
    ROLE: 'role',
    CHAMPION: 'champion',
    CHAMPION_ROLE: 'champion_by_role',
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
    return buildLineupKey(lineupKey.split(LINEUP_DELIMITER)) || null;
}

function getLineupStats(entry) {
    const wins = toNonNegativeInteger(entry?.wins);
    let losses = toNonNegativeInteger(entry?.losses);
    let games = toNonNegativeInteger(entry?.games, wins + losses);

    if (!Object.hasOwn(entry ?? {}, 'losses') && games >= wins) {
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
    return {
        games: Math.max(toNonNegativeInteger(count, wins + losses), wins + losses),
        wins,
    };
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

function findGuildLineups(guildValue) {
    if (!isObject(guildValue)) {
        return {};
    }

    if (isObject(guildValue.lineups)) {
        return guildValue.lineups;
    }
    return guildValue;
}

function addLineup(lineups, { guildId, lineupKey, games, wins, losses, firstSeenAt, lastSeenAt, seenMatchIds }) {
    if (games <= 0 && wins <= 0 && losses <= 0) {
        return;
    }
    const aggregateKey = JSON.stringify([guildId, lineupKey]);
    const existing = lineups.get(aggregateKey) ?? {
        guildId,
        lineupKey,
        lineupSize: lineupKey.split(LINEUP_DELIMITER).length,
        games: 0,
        wins: 0,
        losses: 0,
        firstSeenAt,
        lastSeenAt,
        seenMatchIds: new Set(),
    };
    existing.games += games;
    existing.wins += wins;
    existing.losses += losses;
    existing.firstSeenAt = Math.min(existing.firstSeenAt, firstSeenAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt);
    for (const matchId of seenMatchIds) {
        existing.seenMatchIds.add(matchId);
    }
    lineups.set(aggregateKey, existing);
}

function addContext(contextRows, { guildId, memberKey, contextType, contextValue, games, wins }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedContextValue = normalizeContextValue(contextValue);
    if (!normalizedMemberKey || !normalizedContextValue || games <= 0) {
        return;
    }

    const aggregateKey = JSON.stringify([guildId, normalizedMemberKey, contextType, normalizedContextValue]);
    const existing = contextRows.get(aggregateKey) ?? {
        guildId,
        memberKey: normalizedMemberKey,
        contextType,
        contextValue: normalizedContextValue,
        games: 0,
        wins: 0,
    };

    // Legacy JSON stored member champion/role context on each lineup permutation. A
    // five stack can therefore copy the same person-level match into many lineup
    // rows. Keep the strongest aggregate we see for a member/context instead of
    // summing across permutations, which would multiply that member's stats.
    if (games > existing.games || (games === existing.games && wins > existing.wins)) {
        existing.games = games;
        existing.wins = wins;
    }
    contextRows.set(aggregateKey, existing);
}

function addDerivedContext(derivedRows, { memberKey, contextType, contextValue, games, wins }) {
    const normalizedMemberKey = typeof memberKey === 'string' ? memberKey.trim() : '';
    const normalizedContextValue = normalizeContextValue(contextValue);
    if (!normalizedMemberKey || !normalizedContextValue || games <= 0) {
        return;
    }

    const aggregateKey = JSON.stringify([normalizedMemberKey, contextType, normalizedContextValue]);
    const existing = derivedRows.get(aggregateKey) ?? {
        memberKey: normalizedMemberKey,
        contextType,
        contextValue: normalizedContextValue,
        games: 0,
        wins: 0,
    };
    existing.games += games;
    existing.wins += wins;
    derivedRows.set(aggregateKey, existing);
}

function collectBasicContext(contextRows, { guildId, byMember, contextType }) {
    if (!isObject(byMember)) {
        return;
    }
    for (const [memberKey, counters] of Object.entries(byMember)) {
        if (!isObject(counters)) {
            continue;
        }

        for (const [contextValue, counter] of Object.entries(counters)) {
            addContext(contextRows, {
                guildId,
                memberKey,
                contextType,
                contextValue,
                ...getCounterStats(counter),
            });
        }
    }
}

function collectChampionRoleContext(contextRows, { guildId, championsByRoleByMember }) {
    if (!isObject(championsByRoleByMember)) {
        return;
    }
    const derivedRows = new Map();
    for (const [memberKey, roles] of Object.entries(championsByRoleByMember)) {
        if (!isObject(roles)) {
            continue;
        }

        for (const [role, champions] of Object.entries(roles)) {
            if (!isObject(champions)) {
                continue;
            }

            for (const [champion, counter] of Object.entries(champions)) {
                const stats = getCounterStats(counter);
                addDerivedContext(derivedRows, {
                    memberKey,
                    contextType: CONTEXT_TYPES.ROLE,
                    contextValue: role,
                    ...stats,
                });
                addDerivedContext(derivedRows, {
                    memberKey,
                    contextType: CONTEXT_TYPES.CHAMPION,
                    contextValue: champion,
                    ...stats,
                });
                addContext(contextRows, {
                    guildId,
                    memberKey,
                    contextType: CONTEXT_TYPES.CHAMPION_ROLE,
                    contextValue: buildChampionRoleContextValue(champion, role),
                    ...stats,
                });
            }
        }
    }
    for (const row of derivedRows.values()) {
        addContext(contextRows, { guildId, ...row });
    }

}

export function buildImportPlan(parsed, now = Date.now()) {
    if (!isObject(parsed)) {
        throw new Error('[migrateLolLineupsJson] Legacy lol_lineups.json root must be an object keyed by guildId.');
    }

    const lineups = new Map();
    const contextRows = new Map();

    for (const [guildId, guildValue] of Object.entries(parsed)) {
        if (!guildId || !isObject(guildValue)) {
            continue;
        }

        for (const [rawLineupKey, rawEntry] of Object.entries(findGuildLineups(guildValue))) {
            if (!isObject(rawEntry)) {
                continue;
            }

            const lineupKey = normalizeLineupKey(rawLineupKey);
            if (!lineupKey) {
                continue;
            }

            addLineup(lineups, {
                guildId,
                lineupKey,
                ...getLineupStats(rawEntry),
                firstSeenAt: getTimestamp(rawEntry, 'firstSeenAt', now),
                lastSeenAt: getTimestamp(rawEntry, 'lastSeenAt', now),
                seenMatchIds: normalizeSeenMatchIds(rawEntry),
            });
            collectBasicContext(contextRows, {
                guildId,
                byMember: rawEntry.rolesByMember,
                contextType: CONTEXT_TYPES.ROLE,
            });
            collectBasicContext(contextRows, {
                guildId,
                byMember: rawEntry.championsByMember,
                contextType: CONTEXT_TYPES.CHAMPION,
            });
            collectChampionRoleContext(contextRows, {
                guildId,
                championsByRoleByMember: rawEntry.championsByRoleByMember,
            });
        }
    }

    return {
        lineups: [...lineups.values()].map((lineup) => ({
            ...lineup,
            seenMatchIds: [...lineup.seenMatchIds],
        })),
        contextRows: [...contextRows.values()],
    };
}

async function readLegacyJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
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
    if (getMigrationMarker(db, migrationName)) {
        return {
            didRun: false,
            reason: 'already_applied',
            legacyPath,
            migrationName,
            importedLineups: 0,
            importedContextRows: 0,
            importedMemberContextSeenRows: 0,
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
            insertLineupMatchSeen.run(lineup.guildId, lineup.lineupKey, matchId, lineup.lastSeenAt);
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
        insertContext.run(row.guildId, row.memberKey, row.contextType, row.contextValue, row.games, row.wins);
    }

    const insertMemberContextMatchSeen = db.prepare(`
        INSERT INTO lol_member_context_match_seen (
            guild_id,
            member_key,
            match_id,
            seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, member_key, match_id) DO NOTHING
    `);
    const contextMembersByGuild = new Map();
    for (const row of plan.contextRows) {
        const members = contextMembersByGuild.get(row.guildId) ?? new Set();
        members.add(row.memberKey);
        contextMembersByGuild.set(row.guildId, members);
    }

    let importedMemberContextSeenRows = 0;
    for (const lineup of plan.lineups) {
        if (lineup.seenMatchIds.length === 0) {
            continue;
        }
        const contextMembers = contextMembersByGuild.get(lineup.guildId);
        if (!contextMembers) {
            continue;
        }
        const lineupMembers = new Set(lineup.lineupKey.split(LINEUP_DELIMITER).filter(Boolean));
        for (const memberKey of lineupMembers) {
            if (!contextMembers.has(memberKey)) {
                continue;
            }
            for (const matchId of lineup.seenMatchIds) {
                const result = insertMemberContextMatchSeen.run(lineup.guildId, memberKey, matchId, lineup.lastSeenAt);
                importedMemberContextSeenRows += Number(result?.changes ?? 0);
            }
        }
    }

    const details = {
        legacyPath,
        importedLineups: plan.lineups.length,
        importedContextRows: plan.contextRows.length,
        importedMemberContextSeenRows,
    };
    insertMigrationMarker(db, migrationName, details, now);

    return {
        didRun: true,
        reason: 'imported',
        migrationName,
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
            importedMemberContextSeenRows: 0,
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
