import test from 'node:test';
import assert from 'node:assert/strict';

import { getUnitCost, normalizeUnitCost, normalizeUnits } from '../utils/unitStrip/model.js';

test('TFT match rarity is converted from a zero-based rarity to shop cost', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(normalizeUnitCost), [1, 2, 3, 4, 5]);
});

test('Data Dragon champion cost takes precedence over match rarity', () => {
    assert.equal(getUnitCost({ cost: 4, rarity: 0 }), 4);
    assert.equal(getUnitCost({ rarity: 2 }), 3);
});

test('units are sorted by normalized shop cost and then star tier', () => {
    const units = normalizeUnits([
        { character_id: 'one', cost: 1, tier: 3 },
        { character_id: 'four-one-star', cost: 4, tier: 1 },
        { character_id: 'four-two-star', cost: 4, tier: 2 },
    ], 10);

    assert.deepEqual(units.map((unit) => unit.character_id), [
        'four-two-star',
        'four-one-star',
        'one',
    ]);
});
