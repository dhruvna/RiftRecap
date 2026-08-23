import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNormalizedTeamBans, buildNormalizedTeamRosters } from '../utils/lol/participants.js';
import { buildLolLiveMatchCardBuffer } from '../utils/liveDraftImage.js';

test('buildNormalizedTeamBans puts each ban in its team draft order', () => {
    const bans = buildNormalizedTeamBans([
        { championId: 17, teamId: 100, pickTurn: 10 },
        { championId: 22, teamId: 200, pickTurn: 6 },
        { championId: 33, teamId: 100, pickTurn: 1 },
        { championId: 44, teamId: 200, pickTurn: 2 },
        { championId: 55, teamId: 100, pickTurn: 8 },
        { championId: 66, teamId: 200, pickTurn: 9 },
    ]);

    assert.deepEqual(bans.BLUE.map((ban) => ban.championId), [33, 55, 17]);
    assert.deepEqual(bans.RED.map((ban) => ban.championId), [44, 22, 66]);
});

test('buildNormalizedTeamBans ignores unavailable champion selections', () => {
    const bans = buildNormalizedTeamBans([
        { championId: 0, teamId: 100, pickTurn: 1 },
        { championId: 'not-a-champion', teamId: 200, pickTurn: 2 },
        { championId: 1, teamId: 300, pickTurn: 3 },
    ]);

    assert.deepEqual(bans, { BLUE: [], RED: [] });
});

test('buildNormalizedTeamRosters normalizes selected skin numbers without treating them as indexes', () => {
    const rosters = buildNormalizedTeamRosters([
        { teamId: 100, championId: 1, lastSelectedSkinIndex: 0 },
        { teamId: 100, championId: 2, lastSelectedSkinIndex: 65 },
        { teamId: 100, championId: 3, lastSelectedSkinIndex: '12' },
        { teamId: 200, championId: 4 },
        { teamId: 200, championId: 5, lastSelectedSkinIndex: -1 },
        { teamId: 200, championId: 6, lastSelectedSkinIndex: 'invalid' },
    ]);

    assert.deepEqual(rosters.BLUE.map((entry) => entry.lastSelectedSkinIndex), [0, 65, 12]);
    assert.deepEqual(rosters.RED.map((entry) => entry.lastSelectedSkinIndex), [null, null, null]);
});

test('buildLolLiveMatchCardBuffer renders rows with banned champions', async () => {
    const card = await buildLolLiveMatchCardBuffer({
        queueLabel: 'Ranked Solo/Duo',
        sides: {
            blue: [{ riotId: 'Blue Player' }],
            red: [{ riotId: 'Red Player' }],
            blueBans: [{ championId: 17 }],
            redBans: [{ championId: 22 }],
        },
    });

    assert.ok(Buffer.isBuffer(card));
    assert.ok(card.length > 0);
});

test('buildLolLiveMatchCardBuffer falls back to the champion icon when a skin tile is unavailable', async () => {
    const card = await buildLolLiveMatchCardBuffer({
        sides: {
            blue: [{
                riotId: 'Fallback Player',
                championSkinTileUrl: '/definitely/missing/skin-tile.jpg',
                championIconUrl: new URL('../../assets/RiotLogo.png', import.meta.url).pathname,
            }],
            red: [],
        },
    });

    assert.ok(Buffer.isBuffer(card));
    assert.deepEqual([...card.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
