// === LOL utilities ===
// This module holds helpers for queue detection, placement formatting, and embeds.

import { EmbedBuilder } from "discord.js";
import { 
    getLatestDDragonVersion,
    getMatchUrl,
    getLolChampionImageById,
    getLolChampionImageKeyById,
} from "../riot.js";
import { getLolIdentity } from "../storage.js";
import { GAME_TYPES } from "../constants/queues.js";
import {
  isRankedQueueForGame,
  queueLabelForGame,
  queueTypeFromQueueId,
} from "../constants/queues.js";
import { formatDelta, formatRankWithLp } from "./presentation.js";

function formatDurationFromSeconds(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "Unknown";

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

async function resolveChampionIcon(participant, version) {
    const championId = participant?.championId;
    let resolvedImageKey = null;
    let championIconUrl = null;

    if (championId != null) {
        resolvedImageKey = await getLolChampionImageKeyById(championId);
        championIconUrl = await getLolChampionImageById(championId);
    }

    if (!championIconUrl && version) {
        const championName = participant?.championName;
        if (championName) {
            const normalized = String(championName).replace(/[ .'_]/g, '');
            if (normalized) {
                resolvedImageKey = resolvedImageKey ?? normalized;
                championIconUrl = `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${normalized}.png`;
            }
        }
    }

     return { resolvedImageKey, championIconUrl };
}
// function buildChampionIconUrl(participant, version) {
//     const championName = participant?.championName;
//     if (!championName || !version) return null;

//     // Data Dragon champion icon files map to champion key names.
//     const normalized = String(championName).replace(/[ .'_]/g, '');
//     if (!normalized) return null;

//     return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${normalized}.png`;
// }

function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
}

function resolveTrackedParticipant({ account, identity, participants }) {
    if (!Array.isArray(participants) || participants.length === 0) return null;

    const myPuuid = identity?.puuid ?? null;
    if (myPuuid) {
        const byPuuid = participants.find((p) => p?.puuid && String(p.puuid) === String(myPuuid));
        if (byPuuid) return byPuuid;
    }

    const gameName = normalizeText(account?.gameName);
    const tagLine = normalizeText(account?.tagLine);
    const riotId = `${gameName}#${tagLine}`;

    return participants.find((p) => {
        const participantRiotId = normalizeText(p?.riotId);
        if (participantRiotId && participantRiotId === riotId) return true;

        const participantGameName = normalizeText(p?.riotIdGameName);
        const participantTagLine = normalizeText(p?.riotIdTagline ?? p?.riotIdTagLine);
        if (participantGameName && participantTagLine && participantGameName === gameName && participantTagLine === tagLine) {
            return true;
        }

        const summonerName = normalizeText(p?.summonerName);
        return Boolean(summonerName && summonerName === gameName);
    }) ?? null;
}

// === Queue helpers ===
// Extract the queue id from a match payload while handling API variations.
export function getQueueIdFromLolMatch(match) {
    const info = match?.info;
    const q = info?.queueId ?? info?.queue_id ?? null;
    return typeof q === "number" ? q : (q ? Number(q) : null);
}

// Convert queue id into human-friendly metadata.
export function detectLolQueueMetaFromMatch(match) {
    const queueId = getQueueIdFromLolMatch(match);
    const queueType = queueTypeFromQueueId(queueId, GAME_TYPES.LOL);
    return { queueId, queueType, label: queueLabelForGame(GAME_TYPES.LOL, queueType) };
}

// === Embed construction ===
// Build the Discord embed used for match announcements.
export async function buildLolMatchResultEmbed({
    account,
    matchId,
    queueType,
    delta,
    afterRank,
    participant,
    gameMs,
 }) {
    const matchUrl = getMatchUrl({ game: GAME_TYPES.LOL, matchId });
    const label = queueLabelForGame(GAME_TYPES.LOL, queueType);
    const riotId = `${account.gameName}#${account.tagLine}`;

    const kills = Number(participant?.kills ?? 0);
    const deaths = Number(participant?.deaths ?? 0);
    const assists = Number(participant?.assists ?? 0);
    const kda = `${kills}/${deaths}/${assists}`;
    const didWin = participant?.win === true;
    const isRankedMatch = isRankedQueueForGame(GAME_TYPES.LOL, queueType);

    const embed = new EmbedBuilder()
        .setURL(matchUrl)
        // .setTimestamp(new Date())
        .setTimestamp(Number.isFinite(Number(gameMs)) && Number(gameMs) > 0 ? new Date(Number(gameMs)) : new Date())
        .setColor(didWin ? 0x2dcf71 : 0xf34e3c)
        .setTitle(`${label} • ${didWin ? "Victory" : "Defeat"} • ${riotId}`)

    const lpChangeValue = isRankedMatch ? formatDelta(didWin ? Math.abs(delta) : -Math.abs(delta)) : "—";
    const rankValue = isRankedMatch ? formatRankWithLp(afterRank) : "—";

    const damageDealt = Number(participant?.totalDamageDealtToChampions ?? 0);
    const totalCs = Number(participant?.totalMinionsKilled ?? 0) + Number(participant?.neutralMinionsKilled ?? 0);
    const duration = formatDurationFromSeconds(participant?.timePlayed ?? 0);
    const missingPings = Number(participant?.enemyMissingPings ?? 0);
    const lane = participant?.teamPosition ?? "Unknown";
    const visionScore = Number(participant?.visionScore ?? 0);
    const csPerMin = duration === "Unknown" ? null : totalCs / (Number(participant?.timePlayed) / 60);
    const csPerMinLabel = Number.isFinite(csPerMin) && csPerMin > 0 ? `${csPerMin.toFixed(1)} CS/min` : null;

    embed.addFields(
        { name: "K/D/A", value: kda, inline: true },
        { name: "Damage", value: damageDealt.toLocaleString(), inline: true },  
        // if lane = UTILITY, show vision score instead of CS/min (and corresponding label as well)
        { name: lane === "UTILITY" ? "Vision Score" : "CS/min", value: lane === "UTILITY" ? visionScore.toString() : (csPerMinLabel ?? "—"), inline: true },
        // { name: "CS/min", value: csPerMinLabel ?? "—", inline: true }, 
        { name: "Rank", value: rankValue.slice(0, 1024), inline: true },
        { name: didWin ? "LP Win" : "LP Loss", value: lpChangeValue, inline: true },
        { name: "Duration", value: duration, inline: true },
        // { name: "Missing Pings", value: missingPings.toString(), inline: true },
        // { name: "Lane", value: lane, inline: true },
    );

    try {
        const version = await getLatestDDragonVersion();
        const { championIconUrl } = await resolveChampionIcon(participant, version);
        if (championIconUrl) embed.setThumbnail(championIconUrl);
    } catch {
    }
    return { embed, files: [] };
}

export async function buildLolLiveGameEmbed({ account, activeGame }) {
    const riotId = `${account.gameName}#${account.tagLine}`;
    const queueId = Number(activeGame?.gameQueueConfigId ?? 0) || null;
    const queueType = queueTypeFromQueueId(queueId, GAME_TYPES.LOL);
    const queueLabel = queueLabelForGame(GAME_TYPES.LOL, queueType);
    const gameStartTimeMs = Number(activeGame?.gameStartTime ?? 0) || null;

    const participants = Array.isArray(activeGame?.participants) ? activeGame.participants : [];
    const identity = getLolIdentity(account);
    const myPuuid = identity?.puuid ?? null;
    const me = resolveTrackedParticipant({ account, identity, participants });

    const championName = me?.championName ? String(me.championName) : (me?.championId ? `ID ${me.championId}` : null);
    const spell1 = me?.spell1Id ? `S1: ${me.spell1Id}` : null;
    const spell2 = me?.spell2Id ? `S2: ${me.spell2Id}` : null;
    const spellSummary = [spell1, spell2].filter(Boolean).join(" • ");
    console.log(
        `[lol-live] resolvedParticipant account=${account?.key ?? `${account?.gameName}#${account?.tagLine}`} puuidPresent=${Boolean(myPuuid)} participantFound=${Boolean(me)} champion=${championName ?? "none"} spells=${spellSummary || "none"}`
    );

    const embed = new EmbedBuilder()
        .setColor(0x6a5cff)
        .setTitle(`${queueLabel} Game in Progress for ${riotId}`)
        .setTimestamp(new Date());

    embed.addFields(
        { name: "Started", value: gameStartTimeMs ? `<t:${Math.floor(gameStartTimeMs / 1000)}:f>` : "Unknown", inline: false },
    );

    if (championName) {
        embed.addFields({
            name: "Champion",
            value: spellSummary ? `${championName} (${spellSummary})` : String(championName),
            inline: true,
        });
    }

    try {
        const version = await getLatestDDragonVersion();
        // const championIconUrl = buildChampionIconUrl(me, version);
        const { resolvedImageKey, championIconUrl } = await resolveChampionIcon(me, version);
        console.log(
            `[lol-live] championIconLookup championId=${me?.championId ?? "none"} imageKey=${resolvedImageKey ?? "none"} url=${championIconUrl ?? "none"}`
        );

        if (championIconUrl) embed.setThumbnail(championIconUrl);
    } catch {
    }


    return { embed, files: [] };
}
