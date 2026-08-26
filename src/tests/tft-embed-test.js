import test from 'node:test';
import assert from 'node:assert/strict';
import { loadImage } from '@napi-rs/canvas';

import { TFT_QUEUE_TYPES } from '../constants/queues.js';
import { buildMatchResultEmbed } from '../utils/tft.js';

test('TFT match-result unit art renders at high-density pixel dimensions', async () => {
    const { files } = await buildMatchResultEmbed({
        account: { gameName: 'Player', tagLine: 'NA1' },
        placement: 1,
        matchId: 'NA1_test',
        queueType: TFT_QUEUE_TYPES.RANKED,
        delta: 0,
        afterRank: null,
        participant: {
            units: [{ rarity: 0, tier: 1, items: [] }],
            traits: [],
        },
        gameMs: Date.now(),
    });

    assert.equal(files.length, 1);
    const image = await loadImage(files[0].attachment);
    // The logical six-column strip is 502x126; TFT attachments render at 2x.
    assert.equal(image.width, 1004);
    assert.equal(image.height, 252);
});
