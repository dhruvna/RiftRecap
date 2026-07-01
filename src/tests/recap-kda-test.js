import test from 'node:test';
import assert from 'node:assert/strict';

import { LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from '../constants/queues.js';
import { buildRecapEmbed, computeDailyKdaRows } from '../utils/recap.js';

function account(key, recapEvents) {
    return {
        key,
        gameName: key,
        tagLine: 'NA1',
        puuid: `${key}-tft`,
        trackedGames: {
            lol: {
                puuid: `${key}-lol`,
                recapEvents,
            },
        },
    };
}

test('computeDailyKdaRows totals all ranked LoL queues and ignores non-LoL ranked events', () => {
    const rows = computeDailyKdaRows([
        account('PlayerOne', [
            { at: 200, queueType: LOL_QUEUE_TYPES.RANKED_SOLO_DUO, kills: 5, deaths: 1, assists: 7 },
            { at: 190, queueType: LOL_QUEUE_TYPES.RANKED_FLEX, kills: 3, deaths: 4, assists: 10 },
            { at: 180, queueType: LOL_QUEUE_TYPES.RANKED_5S, kills: 2, deaths: 0, assists: 5 },
            { at: 170, queueType: TFT_QUEUE_TYPES.RANKED, kills: 99, deaths: 99, assists: 99 },
            { at: 50, queueType: LOL_QUEUE_TYPES.RANKED_SOLO_DUO, kills: 99, deaths: 99, assists: 99 },
        ]),
    ], 100);

    assert.equal(rows[0].games, 3);
    assert.equal(rows[0].kills, 10);
    assert.equal(rows[0].deaths, 5);
    assert.equal(rows[0].assists, 22);
});

test('buildRecapEmbed adds a Daily KDA field only to daily recaps with KDA rows', () => {
    const rows = [{ account: account('PlayerOne', []), games: 1, delta: 12, _nameKey: 'playerone#na1' }];
    const daily = buildRecapEmbed({
        rows,
        mode: 'DAILY',
        game: 'LOL',
        queue: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
        hours: 24,
        dailyKdaRows: [{ account: rows[0].account, games: 2, kills: 8, deaths: 2, assists: 12, _nameKey: 'playerone#na1' }],
    }).toJSON();
    const weekly = buildRecapEmbed({
        rows,
        mode: 'WEEKLY',
        game: 'LOL',
        queue: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
        hours: 168,
        dailyKdaRows: [{ account: rows[0].account, games: 2, kills: 8, deaths: 2, assists: 12, _nameKey: 'playerone#na1' }],
    }).toJSON();

    assert.ok(daily.fields.some((field) => field.name === 'Daily KDA' && field.value.includes('8/2/12')));
    assert.ok(!weekly.fields.some((field) => field.name === 'Daily KDA'));
});
