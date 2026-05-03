// Shape-normalization layer: pure helpers for coercing storage payloads into stable in-memory shapes.
// Keep this module side-effect free (no file I/O, no mutation queue, no env reads).

export const TRACKED_GAMES = {
    TFT: 'tft',
    LOL: 'lol',
};

export const DEFAULT_RECAP_CONFIG_ID = 'default';

export function normalizeIdentityNamespace(identityNamespace, fallbackPuuid = null) {
    const safeNamespace =
        identityNamespace && typeof identityNamespace === 'object' ? identityNamespace : {};
    return {
        ...safeNamespace,
        puuid: safeNamespace.puuid ?? fallbackPuuid ?? null,
    };
}

export function normalizeAccountIdentity(account) {
    const safeIdentity = account?.identity && typeof account.identity === 'object'
        ? account.identity
        : {};
    const legacyPuuid = account?.puuid ?? null;
    return {
        ...safeIdentity,
        [TRACKED_GAMES.TFT]: normalizeIdentityNamespace(safeIdentity[TRACKED_GAMES.TFT], legacyPuuid),
        [TRACKED_GAMES.LOL]: normalizeIdentityNamespace(safeIdentity[TRACKED_GAMES.LOL], null),
    };
}

export function normalizeRecapConfig(config, fallbackId = DEFAULT_RECAP_CONFIG_ID) {
    const safe = config && typeof config === 'object' ? config : {};
    return {
        id: typeof safe.id === 'string' && safe.id.trim() ? safe.id : fallbackId,
        enabled: Boolean(safe.enabled),
        mode: safe.mode ?? 'DAILY',
        game: safe.game ?? 'TFT',
        queue: safe.queue ?? 'RANKED_TFT',
        lastSentYmd: safe.lastSentYmd ?? null,
        lastSentYmdByMode:
            safe.lastSentYmdByMode && typeof safe.lastSentYmdByMode === 'object'
                ? safe.lastSentYmdByMode
                : {},
    };
}

function readLegacyRankByQueue(account) {
    return account?.lastRankByQueue && typeof account.lastRankByQueue === 'object'
        ? account.lastRankByQueue
        : {};
}

function readLegacyRecapEvents(account) {
    return Array.isArray(account?.recapEvents) ? account.recapEvents : [];
}

function readLegacyLastMatchId(account) {
    return account?.lastMatchId ?? null;
}

function normalizeTrackedGameNamespace(
    gameState,
    {
        fallbackEnabled = true,
        fallbackLastMatchId = null,
        fallbackLastMatchAt = null,
        fallbackLastRankByQueue = {},
        fallbackRecapEvents = [],
    } = {}
) {
    const safeGameState = gameState && typeof gameState === 'object' ? gameState : {};
    const numericLastMatchAt = Number(safeGameState.lastMatchAt ?? fallbackLastMatchAt ?? 0);
    const enabled =
        typeof safeGameState.enabled === 'boolean'
            ? safeGameState.enabled
            : Boolean(fallbackEnabled);
    return {
        ...safeGameState,
        enabled,
        lastMatchId: safeGameState.lastMatchId ?? fallbackLastMatchId,
        lastMatchAt: Number.isFinite(numericLastMatchAt) && numericLastMatchAt > 0 ? numericLastMatchAt : null,
        lastRankByQueue:
            safeGameState.lastRankByQueue && typeof safeGameState.lastRankByQueue === 'object'
                ? safeGameState.lastRankByQueue
                : fallbackLastRankByQueue,
        recapEvents: Array.isArray(safeGameState.recapEvents) ? safeGameState.recapEvents : fallbackRecapEvents,
    };
}

export function normalizeAccountTracking(account) {
    if (!account || typeof account !== 'object') return account;

    const normalizedAccount = {
        ...account,
        identity: normalizeAccountIdentity(account),
    };

    const trackedGames = account.trackedGames && typeof account.trackedGames === 'object'
        ? account.trackedGames
        : {};

    const tftTracked = normalizeTrackedGameNamespace(trackedGames[TRACKED_GAMES.TFT], {
        fallbackEnabled: true,
        fallbackLastMatchId: readLegacyLastMatchId(account),
        fallbackLastMatchAt: null,
        fallbackLastRankByQueue: readLegacyRankByQueue(account),
        fallbackRecapEvents: readLegacyRecapEvents(account),
    });

    const lolTracked = normalizeTrackedGameNamespace(trackedGames[TRACKED_GAMES.LOL], {
        fallbackEnabled: true,
        fallbackLastMatchId: null,
        fallbackLastMatchAt: null,
        fallbackLastRankByQueue: {},
        fallbackRecapEvents: [],
    });

    normalizedAccount.trackedGames = {
        ...trackedGames,
        [TRACKED_GAMES.TFT]: tftTracked,
        [TRACKED_GAMES.LOL]: lolTracked,
    };

    if ('lastMatchId' in normalizedAccount) delete normalizedAccount.lastMatchId;
    if ('lastRankByQueue' in normalizedAccount) delete normalizedAccount.lastRankByQueue;
    if ('recapEvents' in normalizedAccount) delete normalizedAccount.recapEvents;
    if ('puuid' in normalizedAccount) delete normalizedAccount.puuid;

    return normalizedAccount;
}
