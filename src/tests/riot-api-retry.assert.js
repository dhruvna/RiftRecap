import assert from 'node:assert/strict';

process.env.DISCORD_BOT_TOKEN ||= 'test-discord-token';
process.env.DISCORD_CLIENT_ID ||= 'test-discord-client';
process.env.RIOT_TFT_API_KEY ||= 'test-tft-key';
process.env.RIOT_LOL_API_KEY ||= 'test-lol-key';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

try {
    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };

    const { getTFTRankByPuuid } = await import('../riot/api.js');
    const limiter = {
        acquire: async () => {},
        penalize: () => {},
    };

    let attempts = 0;
    globalThis.fetch = async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError('fetch failed');
        return {
            ok: true,
            json: async () => [{ queueType: 'RANKED_TFT' }],
        };
    };

    const result = await getTFTRankByPuuid({ platform: 'na1', puuid: 'test-puuid', limiter });
    assert.equal(attempts, 3, 'network failures should be retried');
    assert.deepEqual(result, [{ queueType: 'RANKED_TFT' }]);

    attempts = 0;
    const networkCause = new TypeError('fetch failed');
    globalThis.fetch = async () => {
        attempts += 1;
        throw networkCause;
    };

    await assert.rejects(
        getTFTRankByPuuid({ platform: 'na1', puuid: 'test-puuid', limiter }),
        (error) => {
            assert.equal(error.message, 'Riot API network request failed on https://na1.api.riotgames.com/tft/league/v1/by-puuid/test-puuid');
            assert.equal(error.endpoint, 'https://na1.api.riotgames.com/tft/league/v1/by-puuid/test-puuid');
            assert.equal(error.attempts, 4);
            assert.equal(error.cause, networkCause);
            return true;
        }
    );
    assert.equal(attempts, 4, 'network failures should stop after the retry limit');
} finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
}

console.log('Riot API network retry assertions passed.');
