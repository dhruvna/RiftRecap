import assert from 'node:assert/strict';
import { resolveChampionIcon } from '../utils/lolChampionIcon.js';

function runResolveChampionIconAssertions() {
  const championImagesById = new Map([
    ['266', 'https://ddragon.leagueoflegends.com/cdn/15.1.1/img/champion/Aatrox.png'],
  ]);

  const directLookup = resolveChampionIcon({
    participant: { championId: 266, championName: 'Aatrox' },
    championImagesById,
  });
  assert.deepEqual(directLookup, {
    resolvedImageKey: 'Aatrox',
    championIconUrl: 'https://ddragon.leagueoflegends.com/cdn/15.1.1/img/champion/Aatrox.png',
  });

  const noLookupResult = resolveChampionIcon({
    participant: { championId: 999999, championName: 'Unknown' },
    championImagesById,
  });
  assert.deepEqual(noLookupResult, {
    resolvedImageKey: null,
    championIconUrl: null,
  });

  const keyExtractedFromUrl = resolveChampionIcon({
    participant: { championId: 266 },
    championImagesById: new Map([
      ['266', 'https://cdn.example.com/champions/Aatrox.png'],
    ]),
  });
  assert.equal(keyExtractedFromUrl.resolvedImageKey, 'Aatrox');
}

runResolveChampionIconAssertions();
console.log('resolveChampionIcon assertions passed');
