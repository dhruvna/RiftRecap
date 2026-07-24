import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNormalizedTeamBans } from '../utils/lol/participants.js';

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
