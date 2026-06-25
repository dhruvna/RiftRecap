import config from '../config.js';
import { resolveRegionRoutes, normalizeRegionToShard } from '../constants/regions.js';
import { createRiotRateLimiter } from '../utils/rateLimiter.js';

export function resolveRegion(regionMaybe) {
    return resolveRegionRoutes(regionMaybe || config.defaultRegion);
}

const RIOT_TFT_API_KEY = config.riotTftApiKey;
const RIOT_LOL_API_KEY = config.riotLolApiKey;
const sharedRiotLimiter = createRiotRateLimiter();

async function riotFetchJson(url, gameType = 'TFT', limiter = sharedRiotLimiter) {
    const apiKey = gameType === 'TFT' ? RIOT_TFT_API_KEY : RIOT_LOL_API_KEY;

    if (limiter) {
        await limiter.acquire();
    }

    const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
    if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Riot API request failed: ${res.status} on ${url}`);
        err.status = res.status;
        err.responseText = body || null;
        err.endpoint = url;
        throw err;
    }

    return res.json();
}

const { regional: DEFAULT_REGIONAL } = resolveRegion();

export async function getAccountByRiotId({ 
    regional = DEFAULT_REGIONAL,
    gameName, 
    tagLine, 
    gameType = 'TFT',
    limiter 
}) {
    const url = `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
        gameName
    )}/${encodeURIComponent(tagLine)}`;
    return riotFetchJson(url, gameType, limiter);
}

export async function getTFTRankByPuuid({ platform, puuid, limiter }) {
    const url = `https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${encodeURIComponent(puuid)}`;
    return riotFetchJson(url, 'TFT', limiter);
}

export async function getTFTMatchIdsByPuuid({ regional, puuid, count = 1, start = 0, limiter }) {
    const safeCount = Math.max(1, Math.min(Number(count) || 1, 20));
    const safeStart = Math.max(0, Number(start) || 0);
    const url = `https://${regional}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(
        puuid
    )}/ids?count=${safeCount}&start=${safeStart}`;

    return riotFetchJson(url, 'TFT', limiter);
}

export async function getTFTMatch({ regional, matchId, limiter }) {
    const url = `https://${regional}.api.riotgames.com/tft/match/v1/matches/${encodeURIComponent(matchId)}`;
    return riotFetchJson(url, 'TFT', limiter);
}

export async function getLolRankByPuuid({ platform, puuid, limiter }) {
    const url = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    return riotFetchJson(url, 'LOL', limiter);
}

export async function getLolMatchIdsByPuuid({
    regional,
    puuid,
    count = 1,
    start = 0,
    queue,
    type,
    limiter,
}) {
    const safeCount = Math.max(1, Math.min(Number(count) || 1, 100));
    const safeStart = Math.max(0, Number(start) || 0);
    const params = new URLSearchParams({
        count: String(safeCount),
        start: String(safeStart),
    });

    if (queue !== undefined && queue !== null) {
        const safeQueue = Number(queue);
        if (Number.isFinite(safeQueue)) {
            params.set('queue', String(safeQueue));
        }
    }

    if (type) {
        params.set('type', String(type));
    }

    const url = `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(
        puuid
    )}/ids?${params.toString()}`;

    return riotFetchJson(url, 'LOL', limiter);
}

export async function getLolMatch({ regional, matchId, limiter }) {
    const url = `https://${regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
    return riotFetchJson(url, 'LOL', limiter);
}

function encodeRiotIdPath({ gameName, tagLine }) {
    return `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
}

function parseMatchId(matchId) {
    if (!matchId || !String(matchId).includes('_')) return null;
    const [platformPrefix, numericId] = String(matchId).split('_');
    if (!platformPrefix || !numericId) return null;
    return {
        platformPrefix,
        numericId,
        shard: normalizeRegionToShard(platformPrefix),
    };
}

export function getProfileUrl({ game, region = 'NA', gameName, tagLine }) {
    const shard = normalizeRegionToShard(region);
    const encodedRiotIdPath = encodeRiotIdPath({ gameName, tagLine }).replace('/', '-');
    if (String(game).toUpperCase() === 'LOL') {
        return `https://www.leagueofgraphs.com/summoner/${shard}/${encodedRiotIdPath}`;
    }
    return `https://www.leagueofgraphs.com/tft/summoner/${shard}/${encodedRiotIdPath}`;
}

export function getMatchUrl({ game, matchId }) {
    const parsed = parseMatchId(matchId);
    if (!parsed) return null;
    const { shard, numericId } = parsed;
    if (String(game).toUpperCase() === 'LOL') {
        return `https://www.leagueofgraphs.com/match/${shard}/${numericId}`;
    }
    return `https://www.leagueofgraphs.com/tft/match/${shard}/${numericId}`;
}

export async function getLolActiveGameByPuuid({ platform, puuid, limiter }) {
    // THIS ENDPOINT IS CORRECT. I KNOW IT LOOKS SLIGHTLY INCORRECT, BUT IT IS TESTED AND WORKING. WHY DID RIOT SAY SUMMONER BUT USE PUUID? I HAVE NO IDEA. DO NOT CHANGE THIS. IT IS CORRECT
    const url = `https://${platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
    return riotFetchJson(url, 'LOL', limiter);
}

export async function getTftActiveGameByPuuid({ platform, puuid, limiter }) {
    // THIS ENDPOINT IS CORRECT. I KNOW IT LOOKS SLIGHTLY INCORRECT, BUT IT IS TESTED AND WORKING. RIOT REALLY DID MAKE THE TFT SPECTATOR ENDPOINT DIFFERENT FROM THE LOL ONE. I HAVE NO IDEA WHY. DO NOT CHANGE THIS. IT IS CORRECT
    const url = `https://${platform}.api.riotgames.com/lol/spectator/tft/v5/active-games/by-puuid/${encodeURIComponent(puuid)}`;
    return riotFetchJson(url, 'TFT', limiter);
}
