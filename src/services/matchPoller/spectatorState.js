import { GAME_TYPES } from '../../constants/queues.js';
import { getLolIdentity, getTftIdentity } from '../../storage.js';
import { getLolActiveGameByPuuid, getTftActiveGameByPuuid } from '../../riot.js';

export const SPECTATOR_CHECK_COOLDOWN_MS = 0.5 * 60 * 1000;
export const LIVE_ANNOUNCE_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

export function getLolInGameDedupeKey(tracking = {}) {
    if (tracking?.activeGameId != null) return `gid:${String(tracking.activeGameId)}`;
    const start = tracking?.activeGameStartTime;
    const queue = tracking?.activeQueueId;
    if (start != null && queue != null) return `start:${String(start)}:queue:${String(queue)}`;
    return null;
}

export function getTftInGameDedupeKey(tracking = {}) {
    if (tracking?.activeGameId != null) return `gid:${String(tracking.activeGameId)}`;
    const start = tracking?.activeGameStartTime;
    const queue = tracking?.activeQueueId;
    if (start != null && queue != null) return `start:${String(start)}:queue:${String(queue)}`;
    return null;
}

export function getLolFinishedMatchDedupeKey({ match, queueType }) {
    const gameId = match?.info?.gameId;
    if (gameId != null) return `gid:${String(gameId)}`;
    const start = match?.info?.gameCreation;
    if (start != null && queueType != null) return `start:${String(start)}:queue:${String(queueType)}`;
    return null;
}

export async function probeSpectatorState({ riotLimiter, account, tracking, game }) {
    const now = Date.now();
    const lastCheckedAt = Number(tracking?.lastSpectatorCheckAt ?? 0);
    const wasInGame = tracking?.inGame === true;
    const previousActiveGameId = tracking?.activeGameId;
    const previousActiveQueueId = tracking?.activeQueueId;
    const previousActiveGameStartTime = tracking?.activeGameStartTime;

    if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt < SPECTATOR_CHECK_COOLDOWN_MS) {
        console.log(`Skipping spectator check for account ${account.key} - cooldown in effect`);
        return {
            inGame: wasInGame,
            lastSpectatorCheckAt: lastCheckedAt,
            activeGameId: previousActiveGameId,
            activeQueueId: previousActiveQueueId,
            activeGameStartTime: previousActiveGameStartTime,
            activeGame: null,
        };
    }

    const identity = game === GAME_TYPES.LOL ? getLolIdentity(account) : getTftIdentity(account);
    if (!identity?.puuid) {
        return {
            inGame: false,
            lastSpectatorCheckAt: now,
            activeGameId: null,
            activeQueueId: null,
            activeGameStartTime: null,
            activeGame: null,
        };
    }

    const fetcher = game === GAME_TYPES.LOL ? getLolActiveGameByPuuid : getTftActiveGameByPuuid;
    try {
        const activeGame = await fetcher({ platform: account.platform, puuid: identity.puuid, limiter: riotLimiter });
        console.log(`Probed spectator state for account ${account.key}: inGame=${Boolean(activeGame)}`);
        return {
            inGame: Boolean(activeGame),
            lastSpectatorCheckAt: now,
            activeGameId: activeGame?.gameId ?? null,
            activeQueueId: activeGame?.gameQueueConfigId ?? null,
            activeGameStartTime: activeGame?.gameStartTime ?? null,
            activeGame,
        };
    } catch (err) {
        if (Number(err?.status) === 404) return { inGame: false, lastSpectatorCheckAt: now, activeGameId: null, activeQueueId: null, activeGameStartTime: null };
        console.log(`Error probing spectator state for account ${account.key}`, err);
        return {
            inGame: wasInGame,
            lastSpectatorCheckAt: now,
            activeGameId: previousActiveGameId,
            activeQueueId: previousActiveQueueId,
            activeGameStartTime: previousActiveGameStartTime,
            activeGame: null,
        };
    }
}
