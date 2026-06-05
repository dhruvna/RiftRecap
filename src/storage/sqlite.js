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

function initializeCurrentSchema(db) {
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS guilds (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT
        );

        CREATE TABLE IF NOT EXISTS guild_announce_queues (
            guild_id TEXT NOT NULL,
            queue_type TEXT NOT NULL,
            PRIMARY KEY (guild_id, queue_type),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS guild_game_config (
            guild_id TEXT NOT NULL,
            game_key TEXT NOT NULL,
            season_cutoff_ms INTEGER,
            PRIMARY KEY (guild_id, game_key),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS guild_recap_configs (
            guild_id TEXT NOT NULL,
            config_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            mode TEXT NOT NULL DEFAULT 'DAILY',
            game TEXT NOT NULL DEFAULT 'TFT',
            queue TEXT NOT NULL DEFAULT 'RANKED_TFT',
            last_sent_ymd_by_mode TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (guild_id, config_id),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS accounts (
            guild_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            game_name TEXT,
            tag_line TEXT,
            region TEXT,
            platform TEXT,
            regional TEXT,
            PRIMARY KEY (guild_id, account_key),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS account_game_identity (
            guild_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            game_key TEXT NOT NULL,
            puuid TEXT,
            PRIMARY KEY (guild_id, account_key, game_key),
            FOREIGN KEY (guild_id, account_key) REFERENCES accounts(guild_id, account_key) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS account_game_tracking (
            guild_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            game_key TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            last_match_id TEXT,
            last_match_at INTEGER,
            last_rank_by_queue TEXT NOT NULL DEFAULT '{}',
            recap_events TEXT NOT NULL DEFAULT '[]',
            in_game INTEGER NOT NULL DEFAULT 0,
            last_spectator_check_at INTEGER,
            active_game_id TEXT,
            active_queue_id TEXT,
            active_game_start_time INTEGER,
            last_announced_in_game_key TEXT,
            last_announced_active_game_id TEXT,
            last_in_game_announcement_at INTEGER,
            live_announcement_message_id TEXT,
            live_announcement_channel_id TEXT,
            live_announcement_game_key TEXT,
            PRIMARY KEY (guild_id, account_key, game_key),
            FOREIGN KEY (guild_id, account_key) REFERENCES accounts(guild_id, account_key) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS account_notifications (
            guild_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            lol_announcements INTEGER NOT NULL DEFAULT 1,
            tft_announcements INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (guild_id, account_key),
            FOREIGN KEY (guild_id, account_key) REFERENCES accounts(guild_id, account_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_guild
            ON accounts (guild_id);
        CREATE INDEX IF NOT EXISTS idx_account_game_identity_guild_game
            ON account_game_identity (guild_id, game_key);
        CREATE INDEX IF NOT EXISTS idx_account_game_tracking_guild_game
            ON account_game_tracking (guild_id, game_key);

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

        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_size_games_wins
            ON lineup_stats (guild_id, lineup_size, games, wins);
        CREATE INDEX IF NOT EXISTS idx_lineup_stats_guild_games
            ON lineup_stats (guild_id, games);
        CREATE INDEX IF NOT EXISTS idx_lol_member_context_counter_query
            ON lol_member_context_counter (guild_id, member_key, context_type, games, wins);
        CREATE INDEX IF NOT EXISTS idx_lol_member_context_match_seen_match
            ON lol_member_context_match_seen (guild_id, match_id);
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
    initializeCurrentSchema(db);
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
