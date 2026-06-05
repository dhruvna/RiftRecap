import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('SQLite current schema persists live announcement tracking state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftrecap-live-tracking-'));
    const dbPath = path.join(tempDir, 'riftrecap.sqlite');

    process.env.DATABASE_PATH = dbPath;

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

    const persistedTracking = account.trackedGames[TRACKED_GAMES.LOL];

    assert.equal(account.key, accountKey);
    assert.equal(persistedTracking.enabled, true);
    assert.equal(persistedTracking.lastMatchId, 'NA1_5574686617');
    assert.equal(persistedTracking.lastMatchAt, 1791098800000);
    assert.deepEqual(persistedTracking.lastRankByQueue, {});
    assert.deepEqual(persistedTracking.recapEvents, []);
    assert.equal(persistedTracking.inGame, true);
    assert.equal(persistedTracking.lastSpectatorCheckAt, 1791098838404);
    assert.equal(persistedTracking.activeGameId, '5574686617');
    assert.equal(persistedTracking.activeQueueId, '420');
    assert.equal(persistedTracking.activeGameStartTime, 1791098700000);
    assert.equal(persistedTracking.lastAnnouncedInGameKey, 'gid:5574686617');
    assert.equal(persistedTracking.lastAnnouncedActiveGameId, '5574686617');
    assert.equal(persistedTracking.lastInGameAnnouncementAt, 1791098838404);
    assert.equal(persistedTracking.liveAnnouncementMessageId, '123456789012345678');
    assert.equal(persistedTracking.liveAnnouncementChannelId, '234567890123456789');
    assert.equal(persistedTracking.liveAnnouncementGameKey, 'gid:5574686617');
});
