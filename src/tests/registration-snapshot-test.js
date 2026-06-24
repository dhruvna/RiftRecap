import test from 'node:test';
import assert from 'node:assert/strict';

import { GAME_TYPES, LOL_QUEUE_TYPES, RANKED_QUEUES_BY_GAME } from '../constants/queues.js';

import { getRegistrationSnapshot } from '../services/registrationSnapshot.js';

test('registration snapshot preserves all LoL ranked queue keys', async () => {
    const rankEntries = [
        {
            queueType: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
            tier: 'GOLD',
            rank: 'II',
            leaguePoints: 42,
            wins: 10,
            losses: 8,
        },
        {
            queueType: LOL_QUEUE_TYPES.RANKED_FLEX,
            tier: 'PLATINUM',
            rank: 'IV',
            leaguePoints: 17,
            wins: 12,
            losses: 9,
        },
        {
            queueType: LOL_QUEUE_TYPES.RANKED_5S,
            tier: 'SILVER',
            rank: 'I',
            leaguePoints: 88,
            wins: 20,
            losses: 18,
        },
    ];

    const lolSnapshot = await getRegistrationSnapshot({
        gameType: GAME_TYPES.LOL,
        regional: 'americas',
        platform: 'na1',
        gameName: 'RankedTester',
        tagLine: 'NA1',
        accountFetcher: async () => ({
            gameName: 'RankedTester',
            tagLine: 'NA1',
            puuid: 'lol-puuid',
        }),
        rankFetcher: async () => rankEntries,
        matchIdsFetcher: async () => [],
        matchFetcher: async () => null,
        rankedQueues: new Set(RANKED_QUEUES_BY_GAME[GAME_TYPES.LOL]),
        getMatchTimestamp: () => 0,
    });

    const trackedGames = {
        lol: {
            enabled: true,
            lastMatchId: lolSnapshot.lastMatchId,
            lastMatchAt: lolSnapshot.lastMatchAt,
            lastRankByQueue: lolSnapshot.lastRankByQueue,
            recapEvents: [],
        },
    };

    assert.deepEqual(Object.keys(trackedGames.lol.lastRankByQueue).sort(), [
        LOL_QUEUE_TYPES.RANKED_5S,
        LOL_QUEUE_TYPES.RANKED_FLEX,
        LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
    ].sort());
});
