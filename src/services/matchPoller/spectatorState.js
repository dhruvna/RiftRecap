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
    // Canonical TFT game key source order:
    // 1) Stable game identifier from spectator-v5 (`gameId`).
    // 2) Deterministic fallback from spectator start timestamp + queue (`gameStartTime` + `gameQueueConfigId`).
    if (tracking?.activeGameId != null) return `gid:${normalizeTftGameIdentifier(tracking.activeGameId)}`;
    const start = tracking?.activeGameStartTime;
    const queue = tracking?.activeQueueId;
    if (start != null && queue != null) return `start:${String(start)}:queue:${String(queue)}`;
    return null;
}

export function normalizeTftGameIdentifier(gameId) {
    const stable = String(gameId ?? '').trim();
    if (!stable) return stable;
    const suffixMatch = stable.match(/(?:^|_)(\d+)$/);
    if (suffixMatch?.[1]) return suffixMatch[1];
    return stable;
}

export function getLolFinishedMatchDedupeKey({ match, queueType }) {
    const gameId = match?.info?.gameId;
    if (gameId != null) return `gid:${String(gameId)}`;
    const start = match?.info?.gameCreation;
    if (start != null && queueType != null) return `start:${String(start)}:queue:${String(queueType)}`;
    return null;
}

export function getTftFinishedMatchDedupeKey({ match, queueType }) {
    // Canonical TFT game key source order:
    // 1) Stable game identifier from match-v1 (`info.game_id`, then `metadata.match_id`).
    // 2) Deterministic fallback from match start timestamp + resolved queue (`info.game_datetime` + queueType).
    const gameId = match?.info?.game_id ?? match?.metadata?.match_id;
    if (gameId != null) return `gid:${normalizeTftGameIdentifier(gameId)}`;
    const start = match?.info?.game_datetime;
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
