import test from 'node:test';
import assert from 'node:assert/strict';

import { GAME_TYPES, LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from '../constants/queues.js';
import {
    areMatchAnnouncementsEnabledForGame,
    shouldAnnounceAccountMatch,
} from '../utils/accountVisibility.js';

test('an explicit false disables announcements independently for TFT and LoL', () => {
    const account = { notifications: { tftAnnouncements: false, lolAnnouncements: true } };

    assert.equal(areMatchAnnouncementsEnabledForGame(account, GAME_TYPES.TFT), false);
    assert.equal(areMatchAnnouncementsEnabledForGame(account, GAME_TYPES.LOL), true);
    assert.equal(shouldAnnounceAccountMatch({
        account,
        game: GAME_TYPES.TFT,
        queueType: TFT_QUEUE_TYPES.RANKED,
    }), false);
});

test('an account and its queue must both allow an announcement', () => {
    const account = { notifications: { tftAnnouncements: true, lolAnnouncements: true } };
    const allowedQueues = new Set([TFT_QUEUE_TYPES.RANKED]);

    assert.equal(shouldAnnounceAccountMatch({
        account,
        game: GAME_TYPES.TFT,
        queueType: TFT_QUEUE_TYPES.RANKED,
        announceQueueLookup: allowedQueues,
    }), true);
    assert.equal(shouldAnnounceAccountMatch({
        account,
        game: GAME_TYPES.LOL,
        queueType: LOL_QUEUE_TYPES.RANKED_SOLO_5x5,
        announceQueueLookup: allowedQueues,
    }), false);
});

test('legacy accounts without notification settings remain enabled by default', () => {
    assert.equal(areMatchAnnouncementsEnabledForGame({}, GAME_TYPES.TFT), true);
    assert.equal(areMatchAnnouncementsEnabledForGame({}, GAME_TYPES.LOL), true);
});
