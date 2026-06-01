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

function runMigrations(db) {
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS lineup_stats (
            guild_id TEXT NOT NULL,
            queue_type TEXT NOT NULL,
            lineup_key TEXT NOT NULL,
            lineup_size INTEGER NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, queue_type, lineup_key)
        );

        CREATE TABLE IF NOT EXISTS lineup_match_seen (
            guild_id TEXT NOT NULL,
            queue_type TEXT NOT NULL,
            lineup_key TEXT NOT NULL,
            match_id TEXT NOT NULL,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, queue_type, lineup_key, match_id)
        );

        CREATE TABLE IF NOT EXISTS lineup_context_counter (
            guild_id TEXT NOT NULL,
            queue_type TEXT NOT NULL,
            lineup_key TEXT NOT NULL,
            member_key TEXT NOT NULL,
            context_type TEXT NOT NULL,
            context_value TEXT NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, queue_type, lineup_key, member_key, context_type, context_value)
        );

        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_size_games_wins
            ON lineup_stats (guild_id, lineup_size, games, wins);
        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_games
            ON lineup_stats (guild_id, games);
        CREATE INDEX IF NOT EXISTS idx_lineup_context_counter_query
            ON lineup_context_counter (guild_id, lineup_key, member_key, context_type, games, wins);
    `);
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
