import assert from 'node:assert/strict';
import { getTftFinishedMatchDedupeKey, getTftInGameDedupeKey } from '../services/matchPoller/spectatorState.js';

function runTftDedupeKeyAssertions() {
  const queueType = 1100;
  const start = 1700000000000;

  assert.equal(
    getTftInGameDedupeKey({ activeGameId: 5560917162 }),
    getTftFinishedMatchDedupeKey({ match: { info: { game_id: 'NA1_5560917162' } }, queueType }),
  );

  assert.equal(
    getTftInGameDedupeKey({ activeGameId: 'NA1_5560917162' }),
    getTftFinishedMatchDedupeKey({ match: { metadata: { match_id: 'NA1_5560917162' } }, queueType }),
  );

  assert.equal(
    getTftInGameDedupeKey({ activeGameId: '5560917162' }),
    getTftFinishedMatchDedupeKey({ match: { info: { game_id: 5560917162 } }, queueType }),
  );

  assert.equal(
    getTftInGameDedupeKey({ activeGameStartTime: start, activeQueueId: queueType }),
    `start:${String(start)}:queue:${String(queueType)}`,
  );
  assert.equal(
    getTftFinishedMatchDedupeKey({ match: { info: { game_datetime: start } }, queueType }),
    `start:${String(start)}:queue:${String(queueType)}`,
  );
}

runTftDedupeKeyAssertions();
console.log('tft dedupe key assertions passed');
