import { GAME_TYPES } from '../constants/queues.js';
import { toRankSnapshot } from '../utils/rankSnapshot.js';

const ACCEPTED_GAME_TYPES = new Set(Object.values(GAME_TYPES));

function assertAcceptedGameType(gameType) {
    const normalizedGameType = String(gameType ?? '').toUpperCase();
    if (!ACCEPTED_GAME_TYPES.has(normalizedGameType)) {
        throw new Error(`Unsupported gameType for registration snapshot: ${gameType}`);
    }
    return normalizedGameType;
}

async function defaultAccountFetcher(args) {
    const { getAccountByRiotId } = await import('../riot.js');
    return getAccountByRiotId(args);
}

const DEFAULT_SNAPSHOT = {
    lastRankByQueue: {},
    lastMatchId: null,
    lastMatchAt: null,
};

function logSnapshotError({ stage, gameType, err, context }) {
    const status = err?.status;
    console.error(
        `[register] ${stage} snapshot failed gameType=${gameType} status=${status ?? 'unknown'} endpoint=${err?.endpoint ?? 'unknown'} ${context}`,
        err?.responseText ? { responseText: err.responseText } : err
    );
}

export async function getRegistrationSnapshot({
    gameType,
    regional,
    platform,
    gameName,
    tagLine,
    accountFetcher = defaultAccountFetcher,
    rankFetcher,
    matchIdsFetcher,
    matchFetcher,
    rankedQueues,
    getMatchTimestamp,
    limiter,
}) {
    const normalizedGameType = assertAcceptedGameType(gameType);
    const account = await accountFetcher({ regional, gameName, tagLine, gameType: normalizedGameType, limiter });
    
    let lastRankByQueue = {};
    try {
        const entries = await rankFetcher({ platform, puuid: account.puuid, limiter });
        lastRankByQueue = toRankSnapshot(entries, { rankedQueues });
    } catch (err) {
        logSnapshotError({
            stage: 'rank',
            gameType: normalizedGameType,
            err,
            context: `puuid=${account?.puuid} platform=${platform}`,
        });
    }

    let lastMatchId = null;
    let lastMatchAt = null;
    try {
        const ids = await matchIdsFetcher({ regional, puuid: account.puuid, count: 1, limiter });
        lastMatchId = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;

        if (lastMatchId) {
            const latestMatch = await matchFetcher({ regional, matchId: lastMatchId, limiter });
            const timestamp = Number(getMatchTimestamp(latestMatch));
            lastMatchAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
        }
    } catch (err) {
        logSnapshotError({
            stage: 'latest-match',
            gameType: normalizedGameType,
            err,
            context: `puuid=${account?.puuid} regional=${regional}`,
        });
        return { account, ...DEFAULT_SNAPSHOT };
    }

    return {
        account,
        lastRankByQueue,
        lastMatchId,
        lastMatchAt,
    };
}
