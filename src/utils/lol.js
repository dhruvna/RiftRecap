// === LOL utilities ===
// This module holds helpers for queue detection, placement formatting, and embeds.

import { EmbedBuilder } from "discord.js";
import { 
    getMatchUrl,
    getLolChampionImagesByIds,
} from "../riot.js";
import { getLolIdentity } from "../storage.js";
import { GAME_TYPES } from "../constants/queues.js";
import {
  isRankedQueueForGame,
  queueLabelForGame,
  queueTypeFromQueueId,
} from "../constants/queues.js";
import { formatDelta, formatRankWithLp } from "./presentation.js";
import { resolveChampionIcon } from "./lolChampionIcon.js";

function formatDurationFromSeconds(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "Unknown";

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeRole(position) {
    const role = normalizeText(position).toUpperCase();
    return role || "UNKNOWN";
}

function normalizeTeamSide(teamId) {
    return Number(teamId) === 200 ? "RED" : "BLUE";
}

function buildNormalizedTeamRosters(participants) {
    if (!Array.isArray(participants) || participants.length === 0) {
        return { BLUE: {}, RED: {} };
    }

    return participants.reduce((rosters, participant) => {
        const side = normalizeTeamSide(participant?.teamId);
        const role = normalizeRole(participant?.teamPosition ?? participant?.individualPosition ?? participant?.lane);
        const entry = {
            puuid: participant?.puuid ?? null,
            summonerName: participant?.summonerName ?? null,
            riotId: participant?.riotId ?? null,
            championId: participant?.championId ?? null,
            championName: participant?.championName ?? null,
            spell1Id: participant?.spell1Id ?? null,
            spell2Id: participant?.spell2Id ?? null,
        };

        if (!rosters[side][role]) rosters[side][role] = [];
        rosters[side][role].push(entry);
        return rosters;
    }, { BLUE: {}, RED: {} });
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

// function resolveChampionIcon({ participant, version, championImagesById = new Map() }) {
//     const championId = participant?.championId;
//     let resolvedImageKey = null;

//     // const championIconUrl = championId != null
//     // NOTE: keep this mutable because fallback-by-name may assign when ID lookup misses.
//     let championIconUrl = championId != null
//         ? (championImagesById.get(String(championId)) ?? null)
//         : null;

//     if (!championIconUrl && version) {
//         const championName = participant?.championName;
//         if (championName) {
//             const normalized = String(championName).replace(/[ .'_]/g, '');
//             if (normalized) {
//                 resolvedImageKey = resolvedImageKey ?? normalized;
//                 championIconUrl = `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${normalized}.png`;
//             }
//         }
//     }

//     if (championIconUrl) {
//         const fileName = championIconUrl.split("/").pop();
//         resolvedImageKey = fileName ? fileName.replace(/\.png$/i, "") : null;
//     }

//     return { resolvedImageKey, championIconUrl };
// }

async function buildLolEmbedContext({ account, queueId, queueType, participant, participants = [], gameStartTime, matchId }) {
    const riotId = `${account?.gameName ?? "Unknown"}#${account?.tagLine ?? ""}`;
    const resolvedQueueType = queueType ?? queueTypeFromQueueId(queueId, GAME_TYPES.LOL);
    const queueLabel = queueLabelForGame(GAME_TYPES.LOL, resolvedQueueType);

    const championDisplay = participant?.championName
        ? String(participant.championName)
        : (participant?.championId ? `ID ${participant.championId}` : null);

    const gameStartTimeMs = Number(gameStartTime ?? 0);
    const gameStartTimestamp = Number.isFinite(gameStartTimeMs) && gameStartTimeMs > 0
        ? new Date(gameStartTimeMs)
        : new Date();
    const gameStartEpochSeconds = Number.isFinite(gameStartTimeMs) && gameStartTimeMs > 0
        ? Math.floor(gameStartTimeMs / 1000)
        : null;

    let championIconUrl = null;
    let resolvedImageKey = null;
    try {
        const championIds = participants.map((p) => p?.championId).filter((id) => id != null);
        if (championIds.length === 0 && participant?.championId != null) championIds.push(participant.championId);
        const championImagesById = await getLolChampionImagesByIds(championIds);
        const resolved = resolveChampionIcon({ participant, championImagesById });
        championIconUrl = resolved?.championIconUrl ?? null;
        resolvedImageKey = resolved?.resolvedImageKey ?? null;
    } catch {
    }

    return {
        riotId,
        queueType: resolvedQueueType,
        queueLabel,
        championDisplay,
        championIconUrl,
        resolvedImageKey,
        gameStartTimestamp,
        gameStartEpochSeconds,
        matchUrl: matchId ? getMatchUrl({ game: GAME_TYPES.LOL, matchId }) : null,
    };
}

/**
 * @typedef {Object} LolLiveGameViewModel
 * @property {{ riotId: string, puuid: (string|null), participantFound: boolean, participant: Object|null }} trackedPlayer
 * @property {string} queueLabel
 * @property {(number|null)} gameStartEpochSeconds
 * @property {{ BLUE: Record<string, Array<Object>>, RED: Record<string, Array<Object>> }} teamRostersBySideRole
 * @property {{ championDisplay: (string|null), championId: (number|null), championIconUrl: (string|null), championImageKey: (string|null), spellIds: Array<number>, spellSummary: string }} display
 */

/**
 * Build a pure display-agnostic view model for live game rendering.
 * @param {{ account: Object, activeGame: Object }} params
 * @returns {Promise<LolLiveGameViewModel>}
 */
export async function buildLolLiveGameViewModel({ account, activeGame }) {
    const queueId = Number(activeGame?.gameQueueConfigId ?? 0) || null;
    const participants = Array.isArray(activeGame?.participants) ? activeGame.participants : [];
    const identity = getLolIdentity(account);
    const me = resolveTrackedParticipant({ account, identity, participants });

    const context = await buildLolEmbedContext({
        account,
        queueId,
        participant: me,
        participants,
        gameStartTime: activeGame?.gameStartTime,
    });

    const championIds = participants.map((p) => p?.championId).filter((id) => id != null);
    const championImagesById = await getLolChampionImagesByIds(championIds);
    const teamRostersBySideRole = buildNormalizedTeamRosters(participants);
    for (const side of ["BLUE", "RED"]) {
        for (const role of Object.keys(teamRostersBySideRole[side])) {
            teamRostersBySideRole[side][role] = teamRostersBySideRole[side][role].map((entry) => ({
                ...entry,
                championIconUrl: championImagesById.get(String(entry?.championId ?? "")) ?? null,
            }));
            console.log(`Resolved ${teamRostersBySideRole[side][role].length} champion icons for ${side} ${role}`);
            console.log(teamRostersBySideRole[side]["championId"
            ]);
        }
    }

    const spellIds = [Number(me?.spell1Id), Number(me?.spell2Id)].filter(Number.isFinite);
    const spellSummary = spellIds.map((spellId, index) => `S${index + 1}: ${spellId}`).join(" • ");

    return {
        trackedPlayer: {
            riotId: context.riotId,
            puuid: identity?.puuid ?? null,
            participantFound: Boolean(me),
            participant: me,
        },
        queueLabel: context.queueLabel,
        gameStartEpochSeconds: context.gameStartEpochSeconds,
        teamRostersBySideRole,
        display: {
            championDisplay: context.championDisplay,
            championId: me?.championId ?? null,
            championIconUrl: context.championIconUrl,
            championImageKey: context.resolvedImageKey,
            spellIds,
            spellSummary,
        },
    };
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
    participants = [],
    gameMs,
 }) {
    const context = await buildLolEmbedContext({
        account,
        queueType,
        participant,
        participants,
        gameStartTime: gameMs,
        matchId,
    });

    const { matchUrl, queueLabel, riotId, championIconUrl, gameStartTimestamp } = context;

    const kills = Number(participant?.kills ?? 0);
    const deaths = Number(participant?.deaths ?? 0);
    const assists = Number(participant?.assists ?? 0);
    const kda = `${kills}/${deaths}/${assists}`;
    const didWin = participant?.win === true;
    const isRankedMatch = isRankedQueueForGame(GAME_TYPES.LOL, queueType);

    const embed = new EmbedBuilder()
        .setURL(matchUrl)
        .setTimestamp(gameStartTimestamp)
        .setColor(didWin ? 0x2dcf71 : 0xf34e3c)
        .setTitle(`${queueLabel} • ${didWin ? "Victory" : "Defeat"} • ${riotId}`)

    const lpChangeValue = isRankedMatch ? formatDelta(didWin ? Math.abs(delta) : -Math.abs(delta)) : "—";
    const rankValue = isRankedMatch ? formatRankWithLp(afterRank) : "—";

    const damageDealt = Number(participant?.totalDamageDealtToChampions ?? 0);
    const totalCs = Number(participant?.totalMinionsKilled ?? 0) + Number(participant?.neutralMinionsKilled ?? 0);
    const duration = formatDurationFromSeconds(participant?.timePlayed ?? 0);
    // const missingPings = Number(participant?.enemyMissingPings ?? 0);
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

    if (championIconUrl) embed.setThumbnail(championIconUrl);
    return { embed, files: [] };
}

export async function buildLolLiveGameEmbed({ account, activeGame }) {
    const viewModel = await buildLolLiveGameViewModel({ account, activeGame });

    const embed = new EmbedBuilder()
        .setColor(0x6a5cff)
        .setTitle(`${viewModel.queueLabel} Game in Progress for ${viewModel.trackedPlayer.riotId}`)
        .setTimestamp(new Date());

    if (viewModel.display.championIconUrl) embed.setThumbnail(viewModel.display.championIconUrl);

    return { embed, files: [] };
}
