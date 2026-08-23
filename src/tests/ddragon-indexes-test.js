import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createLolChampionLookup,
    getLolChampionSkinImagesBySelections,
} from '../riot/ddragonIndexes.js';

function createLookup() {
    return createLolChampionLookup({
        getVersion: async () => '99.1.2',
        loadChampions: async () => ({
            data: {
                Annie: { id: 'Annie', key: '1', image: { full: 'Annie.png' } },
                Wukong: { id: 'MonkeyKing', key: '62', image: { full: 'MonkeyKing.png' } },
            },
        }),
    });
}

test('LoL champion lookup resolves a numeric champion ID to its icon and canonical tile key', async () => {
    const lookup = createLookup();

    assert.equal(
        await lookup.getImageById(1),
        'https://ddragon.leagueoflegends.com/cdn/99.1.2/img/champion/Annie.png',
    );
    assert.equal(
        await lookup.getSkinImage(1, 65),
        'https://ddragon.leagueoflegends.com/cdn/99.1.2/img/champion/tiles/Annie_65.jpg',
    );
});

test('LoL skin lookup uses special canonical Data Dragon identifiers', async () => {
    assert.equal(
        await createLookup().getSkinImage(62, '3'),
        'https://ddragon.leagueoflegends.com/cdn/99.1.2/img/champion/tiles/MonkeyKing_3.jpg',
    );
});

test('LoL skin lookup rejects invalid selections', async () => {
    const lookup = createLookup();

    assert.equal(await lookup.getSkinImage(null, 1), null);
    assert.equal(await lookup.getSkinImage(1, null), null);
    assert.equal(await lookup.getSkinImage(1, ''), null);
    assert.equal(await lookup.getSkinImage(1, -1), null);
    assert.equal(await lookup.getSkinImage(1, 'not-a-skin'), null);
    assert.equal(await lookup.getSkinImage(999, 1), null);
});

test('batched LoL skin lookup keys results by champion ID and skin number', async () => {
    const images = await getLolChampionSkinImagesBySelections([
        { championId: 1, skinNum: 0 },
        { championId: 62, skinNum: '3' },
        { championId: 1, skinNum: -1 },
        { championId: null, skinNum: 2 },
    ], createLookup());

    assert.deepEqual([...images], [
        ['1:0', 'https://ddragon.leagueoflegends.com/cdn/99.1.2/img/champion/tiles/Annie_0.jpg'],
        ['62:3', 'https://ddragon.leagueoflegends.com/cdn/99.1.2/img/champion/tiles/MonkeyKing_3.jpg'],
    ]);
});
