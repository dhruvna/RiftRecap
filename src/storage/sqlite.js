import fs from 'node:fs';
import path from 'node:path';
const DEFAULT_DATABASE_PATH = path.join(process.env.DATA_DIR ?? 'user_data', 'riftrecap.sqlite');
const DATABASE_PATH = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

const betterSqlitePromise = import('better-sqlite3').catch(() => null);
const nodeSqlitePromise = import('node:sqlite').catch(() => null);

let dbPromise = null;

function openNodeDatabase(DatabaseSync, filePath) {
    return new DatabaseSync(filePath);
}

function openBetterSqliteDatabase(Database, filePath) {
    return new Database(filePath);
}

function ensureDatabaseDirectory(filePath) {
    if (filePath === ':memory:') {
        return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function backfillMemberContextMatchSeenFromLineups(db) {
    const lineupSeenRows = db.prepare(`
        SELECT
            guild_id AS guildId,
            lineup_key AS lineupKey,
            match_id AS matchId,
            seen_at AS seenAt
        FROM lineup_match_seen
    `).all();
    if (lineupSeenRows.length === 0) {
        return;
    }

    const insertMemberSeen = db.prepare(`
        INSERT INTO lol_member_context_match_seen (
            guild_id,
            member_key,
            match_id,
            seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, member_key, match_id) DO NOTHING
    `);

    for (const row of lineupSeenRows) {
        const memberKeys = String(row.lineupKey ?? '')
            .split('|')
            .map((memberKey) => memberKey.trim())
            .filter(Boolean);
        for (const memberKey of memberKeys) {
            insertMemberSeen.run(row.guildId, memberKey, row.matchId, row.seenAt);
        }
    }
}

function runMigrations(db) {
    const legacyContextCounterExists = db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'lineup_context_counter'
    `).get();

    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS lineup_stats (
            guild_id TEXT NOT NULL,
            lineup_key TEXT NOT NULL,
            lineup_size INTEGER NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, lineup_key)
        );

        CREATE TABLE IF NOT EXISTS lineup_match_seen (
            guild_id TEXT NOT NULL,
            lineup_key TEXT NOT NULL,
            match_id TEXT NOT NULL,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, lineup_key, match_id)
        );

        CREATE TABLE IF NOT EXISTS lol_member_context_counter (
            guild_id TEXT NOT NULL,
            member_key TEXT NOT NULL,
            context_type TEXT NOT NULL,
            context_value TEXT NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, member_key, context_type, context_value)
        );

        CREATE TABLE IF NOT EXISTS lol_member_context_match_seen (
            guild_id TEXT NOT NULL,
            member_key TEXT NOT NULL,
            match_id TEXT NOT NULL,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, member_key, match_id)
        );

        CREATE TABLE IF NOT EXISTS storage_migrations (
            migration_name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            details TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_size_games_wins
            ON lineup_stats (guild_id, lineup_size, games, wins);
        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_games
            ON lineup_stats (guild_id, games);
        CREATE INDEX IF NOT EXISTS idx_lol_member_context_counter_query
            ON lol_member_context_counter (guild_id, member_key, context_type, games, wins);
        CREATE INDEX IF NOT EXISTS idx_lol_member_context_match_seen_match
            ON lol_member_context_match_seen (guild_id, match_id);
    `);

    backfillMemberContextMatchSeenFromLineups(db);
    
    if (legacyContextCounterExists) {
        db.exec(`
            INSERT INTO lol_member_context_counter (
                guild_id,
                member_key,
                context_type,
                context_value,
                games,
                wins
            )
            SELECT
                guild_id,
                member_key,
                context_type,
                context_value,
                SUM(games),
                SUM(wins)
            FROM lineup_context_counter
            GROUP BY guild_id, member_key, context_type, context_value
            ON CONFLICT(guild_id, member_key, context_type, context_value)
            DO UPDATE SET
                games = MAX(games, excluded.games),
                wins = MAX(wins, excluded.wins);
        `);
    }
}

async function openDatabase() {
    const betterSqliteModule = await betterSqlitePromise;
    const Database = betterSqliteModule?.default;
    const databasePath = DATABASE_PATH === ':memory:' ? DATABASE_PATH : path.resolve(DATABASE_PATH);

    ensureDatabaseDirectory(databasePath);
    let db;
    if (Database) {
        db = openBetterSqliteDatabase(Database, databasePath);
    } else {
        const nodeSqliteModule = await nodeSqlitePromise;
        const DatabaseSync = nodeSqliteModule?.DatabaseSync;
        if (!DatabaseSync) {
            throw new Error('[sqlite] Install better-sqlite3 or run on a Node.js version with node:sqlite support.');
        }
        db = openNodeDatabase(DatabaseSync, databasePath);
    }
    runMigrations(db);
    return db;
}

export async function getSqliteDb() {
    if (!dbPromise) {
        dbPromise = openDatabase();
    }
    return dbPromise;
}

export async function withSqliteTransaction(callback) {
    const db = await getSqliteDb();
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = callback(db);
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
