import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function createLegacyTrackingSchema(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE account_game_tracking (
            guild_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            game_key TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            last_match_id TEXT,
            last_match_at INTEGER,
            last_rank_by_queue TEXT NOT NULL DEFAULT '{}',
            recap_events TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (guild_id, account_key, game_key)
        );
    `);
    db.close();
}

test('SQLite migration adds and persists live announcement tracking state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftrecap-live-tracking-'));
    const dbPath = path.join(tempDir, 'riftrecap.sqlite');
    createLegacyTrackingSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.DATA_PATH = path.join(tempDir, 'registrations.json');

    const { listGuildAccounts, upsertGuildAccountInStore, TRACKED_GAMES } = await import('../storage.js');
    const guildId = '288456610366357505';
    const accountKey = 'krntiger#na1@na1';
    const liveTracking = {
        enabled: true,
        lastMatchId: 'NA1_5574686617',
        lastMatchAt: 1791098800000,
        lastRankByQueue: {},
        recapEvents: [],
        inGame: true,
        lastSpectatorCheckAt: 1791098838404,
        activeGameId: 5574686617,
        activeQueueId: 420,
        activeGameStartTime: 1791098700000,
        lastAnnouncedInGameKey: 'gid:5574686617',
        lastAnnouncedActiveGameId: 5574686617,
        lastInGameAnnouncementAt: 1791098838404,
        liveAnnouncementMessageId: '123456789012345678',
        liveAnnouncementChannelId: '234567890123456789',
        liveAnnouncementGameKey: 'gid:5574686617',
    };

    await upsertGuildAccountInStore(guildId, {
        key: accountKey,
        gameName: 'krntiger',
        tagLine: 'na1',
        platform: 'na1',
        identity: {
            [TRACKED_GAMES.LOL]: { puuid: 'lol-puuid' },
        },
        trackedGames: {
            [TRACKED_GAMES.LOL]: liveTracking,
        },
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const columnNames = db.prepare('PRAGMA table_info(account_game_tracking)').all().map((column) => column.name);
    db.close();
    assert.ok(columnNames.includes('last_announced_in_game_key'));
    assert.ok(columnNames.includes('live_announcement_game_key'));

    const [account] = await listGuildAccounts(guildId);
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].inGame, true);
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].activeGameId, '5574686617');
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].activeQueueId, '420');
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].lastAnnouncedInGameKey, 'gid:5574686617');
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].lastInGameAnnouncementAt, 1791098838404);
    assert.equal(account.trackedGames[TRACKED_GAMES.LOL].liveAnnouncementGameKey, 'gid:5574686617');
});
