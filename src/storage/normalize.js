// Shape-normalization layer: pure helpers for coercing storage payloads into stable in-memory shapes.
// Keep this module side-effect free (no file I/O, no mutation queue, no env reads).

export const TRACKED_GAMES = {
    TFT: 'tft',
    LOL: 'lol',
};

export const DEFAULT_RECAP_CONFIG_ID = 'default';

export function normalizeIdentityNamespace(identityNamespace) {
    const safeNamespace = identityNamespace && typeof identityNamespace === 'object' ? identityNamespace : {};
    return {
        ...safeNamespace,
        puuid: safeNamespace.puuid ?? null,
    };
}

export function normalizeAccountIdentity(account) {
    const safeIdentity = account?.identity && typeof account.identity === 'object'
        ? account.identity
        : {};
    return {
        ...safeIdentity,
        [TRACKED_GAMES.TFT]: normalizeIdentityNamespace(safeIdentity[TRACKED_GAMES.TFT]),
        [TRACKED_GAMES.LOL]: normalizeIdentityNamespace(safeIdentity[TRACKED_GAMES.LOL]),
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

function normalizeTrackedGameNamespace(gameState) {
    const safeGameState = gameState && typeof gameState === 'object' ? gameState : {};
    const numericLastMatchAt = Number(safeGameState.lastMatchAt ?? 0);

    return {
        // Canonical tracked-game namespace is intentionally limited to these fields.
        // Live-game detection fields were removed and are treated as non-canonical.
        enabled: typeof safeGameState.enabled === 'boolean' ? safeGameState.enabled : true,
        lastMatchId: safeGameState.lastMatchId ?? null,
        lastMatchAt: Number.isFinite(numericLastMatchAt) && numericLastMatchAt > 0 ? numericLastMatchAt : null,
        lastRankByQueue:
            safeGameState.lastRankByQueue && typeof safeGameState.lastRankByQueue === 'object'
                ? safeGameState.lastRankByQueue
                : {},
        recapEvents: Array.isArray(safeGameState.recapEvents) ? safeGameState.recapEvents : [],
    };
}

export function normalizeAccountTracking(account) {
    if (!account || typeof account !== 'object') return account;

    const normalizedAccount = {
        ...account,
        identity: normalizeAccountIdentity(account),
    };

    const trackedGames = account.trackedGames && typeof account.trackedGames === 'object' ? account.trackedGames : {};

    const tftTracked = normalizeTrackedGameNamespace(trackedGames[TRACKED_GAMES.TFT]);
    const lolTracked = normalizeTrackedGameNamespace(trackedGames[TRACKED_GAMES.LOL]);

    normalizedAccount.trackedGames = {
        ...trackedGames,
        [TRACKED_GAMES.TFT]: tftTracked,
        [TRACKED_GAMES.LOL]: lolTracked,
    };
    return normalizedAccount;
}
