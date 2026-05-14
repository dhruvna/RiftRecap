import assert from 'node:assert/strict';
import { buildMatchResultEmbed } from '../utils/tft.js';
import { buildLolMatchResultEmbed } from '../utils/lol.js';
import { TFT_QUEUE_TYPES, LOL_QUEUE_TYPES } from '../constants/queues.js';

async function runEmbedSnapshotAssertions() {
  const account = { gameName: 'Tester', tagLine: 'NA1' };

  const tftResult = await buildMatchResultEmbed({
    account,
    placement: 2,
    matchId: 'TFT-1',
    queueType: TFT_QUEUE_TYPES.RANKED,
    delta: 31,
    afterRank: { tier: 'Gold', rank: 'II', leaguePoints: 74 },
    participant: { units: [], traits: [] },
    gameMs: 1700000000000,
  });

  const tftJson = tftResult.embed.toJSON();
  assert.deepEqual(
    tftJson.fields.map(({ name, value, inline }) => ({ name, value, inline })),
    [
      { name: 'Placement', value: '2nd', inline: true },
      { name: 'LP Change', value: '+31', inline: true },
      { name: 'Rank', value: 'Gold II — 74 LP', inline: true },
    ],
  );

  const lolResult = await buildLolMatchResultEmbed({
    account,
    matchId: 'LOL-1',
    queueType: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
    delta: 20,
    afterRank: { tier: 'Platinum', rank: 'IV', leaguePoints: 22 },
    participant: {
      win: true,
      kills: 8,
      deaths: 2,
      assists: 10,
      totalDamageDealtToChampions: 24500,
      totalMinionsKilled: 160,
      neutralMinionsKilled: 20,
      timePlayed: 1800,
      teamPosition: 'MIDDLE',
      visionScore: 15,
    },
    participants: [],
    gameMs: 1700000005000,
  });

  const lolJson = lolResult.embed.toJSON();
  assert.deepEqual(
    lolJson.fields.map(({ name, value, inline }) => ({ name, value, inline })),
    [
      { name: 'K/D/A', value: '8/2/10', inline: true },
      { name: 'Damage', value: '24,500', inline: true },
      { name: 'CS/min', value: '6.0 CS/min', inline: true },
      { name: 'Rank', value: 'Platinum IV — 22 LP', inline: true },
      { name: 'LP Win', value: '+20', inline: true },
      { name: 'Duration', value: '30:00', inline: true },
    ],
  );
}

await runEmbedSnapshotAssertions();
console.log('embed field snapshot assertions passed');
