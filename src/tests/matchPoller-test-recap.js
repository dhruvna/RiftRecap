import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecapEvents } from '../services/matchPoller.js';

test('buildRecapEvents inserts by descending timestamp and tie-breaks by matchId', () => {
    const baseEvents = [
        { matchId: 'z-100', at: 100, queueType: 'ranked', delta: 10, placement: 1 },
        { matchId: 'm-90', at: 90, queueType: 'ranked', delta: 8, placement: 2 },
        { matchId: 'a-90', at: 90, queueType: 'ranked', delta: 7, placement: 3 },
        { matchId: 'k-80', at: 80, queueType: 'ranked', delta: -2, placement: 4 },
    ];

    const withTieTimestamp = buildRecapEvents({
        recapEvents: baseEvents,
        matchId: 'b-90',
        queueType: 'ranked',
        delta: 5,
        placement: 5,
        gameMs: 90,
    });

    assert.deepEqual(withTieTimestamp.map((event) => event.matchId), [
        'z-100',
        'a-90',
        'b-90',
        'm-90',
        'k-80',
    ]);
});

test('buildRecapEvents dedupes by matchId and truncates to 250', () => {
    const recapEvents = Array.from({ length: 250 }, (_, index) => ({
        matchId: `m-${300 - index}`,
        at: 300 - index,
        queueType: 'ranked',
        delta: index,
        placement: 1,
    }));

    const deduped = buildRecapEvents({
        recapEvents,
        matchId: 'm-250',
        queueType: 'ranked',
        delta: 9,
        placement: 1,
        gameMs: 9999,
    });
    assert.equal(deduped, recapEvents);

    const insertedAndTrimmed = buildRecapEvents({
        recapEvents,
        matchId: 'm-9999',
        queueType: 'ranked',
        delta: 9,
        placement: 1,
        gameMs: 9999,
    });

    assert.equal(insertedAndTrimmed.length, 250);
    assert.equal(insertedAndTrimmed[0].matchId, 'm-9999');
    assert.equal(insertedAndTrimmed.at(-1)?.matchId, 'm-52');
});
