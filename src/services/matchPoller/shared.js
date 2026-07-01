import {
    getLolIdentity,
    getTftIdentity,
} from '../../storage.js';

import {
    getLolMatch,
    getLolMatchIdsByPuuid,
    getTFTMatch,
    getTFTMatchIdsByPuuid,
} from '../../riot.js';

import { GAME_TYPES } from '../../constants/queues.js';
import logger from '../../utils/logger.js';

export const MATCH_BACKFILL_LIMIT = 10;

export async function fetchMatch({ riotLimiter, account, matchId, game }) {
    if (game === GAME_TYPES.TFT) {
        return getTFTMatch({
            regional: account.regional,
            matchId,
            limiter: riotLimiter,
        });
    }
    if (game === GAME_TYPES.LOL) {
        return getLolMatch({
            regional: account.regional,
            matchId,
            limiter: riotLimiter,
        });
    }
    throw new Error(`[match-poller] Unsupported game type: ${String(game)}`);
}

export async function fetchMatchIds({ riotLimiter, account, count, start = 0, game }) {
    const identity = game === GAME_TYPES.LOL ? getLolIdentity(account) : getTftIdentity(account);
    const fetchByGame = game === GAME_TYPES.LOL ? getLolMatchIdsByPuuid : getTFTMatchIdsByPuuid;
    return fetchByGame({
        regional: account.regional,
        puuid: identity.puuid,
        count,
        start,
        limiter: riotLimiter,
    });
}

function compareRecapEventsDesc(left, right) {
    const byTimestamp = Number(right?.at ?? 0) - Number(left?.at ?? 0);
    if (byTimestamp !== 0) return byTimestamp;
    return String(left?.matchId ?? '').localeCompare(String(right?.matchId ?? ''));
}

export function buildRecapEvents({ recapEvents, matchId, queueType, delta, placement, gameMs, kills = null, deaths = null, assists = null }) {
    const already = recapEvents.some((event) => event.matchId === matchId);
    if (already) return recapEvents;

    const nextEvent = {
        matchId,
        at: gameMs,
        queueType,
        delta: Number(delta ?? 0),
        placement: Number(placement ?? 0),
        ...(kills != null ? { kills: Number(kills ?? 0) } : {}),
        ...(deaths != null ? { deaths: Number(deaths ?? 0) } : {}),
        ...(assists != null ? { assists: Number(assists ?? 0) } : {}),
    };
    const nextEvents = [...recapEvents, nextEvent].sort(compareRecapEventsDesc);
    if (nextEvents.length > 250) nextEvents.length = 250;
    return nextEvents;
}

export function buildDiscordMessagePayload({ embed, files, content, allowedMentions }) {
    return {
        ...(content ? { content } : {}),
        embeds: [embed],
        files,
        ...(allowedMentions ? { allowedMentions } : {}),
    };
}

export async function announceGameMatchToDiscord({ buildEmbed, ...context }) {
    const { channel, guildId, channelId } = context;
    if (!channel) {
        logger.info(
            `[match-poller] no channel for guild=${guildId} (channelId=${channelId ?? 'null'})`
        );
        return null;
    }
    const payload = buildDiscordMessagePayload(await buildEmbed(context));
    const sentMessage = await channel.send(payload);
    return sentMessage ?? null;
}

export function findLatestRankedIndex(matches, { shouldInclude = () => true } = {}) {
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const candidate = matches[i];
        if (candidate?.isRanked && shouldInclude(candidate)) {
            return i;
        }
    }
    return -1;
}
