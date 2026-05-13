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

async function buildLolEmbedContext({
    account,
    queueId,
    queueType,
    participant,
    participants = [],
    gameStartTime,
    matchId,
    championImagesById = null,
}) {

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
        let imagesById = championImagesById;
        if (!imagesById) {
            const championIds = participants.map((p) => p?.championId).filter((id) => id != null);
            if (championIds.length === 0 && participant?.championId != null) championIds.push(participant.championId);
            imagesById = await getLolChampionImagesByIds(championIds);
        }

        const resolved = resolveChampionIcon({ participant, championImagesById: imagesById });
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

async function buildLolGameDto({
    account,
    identity = null,
    queueId = null,
    queueType = null,
    participants = [],
    participant = null,
    gameStartTime = null,
    matchId = null,
}) {
    const resolvedIdentity = identity ?? getLolIdentity(account);
    const trackedParticipant = participant ?? resolveTrackedParticipant({ account, identity: resolvedIdentity, participants });
    const championIds = participants.map((p) => p?.championId).filter((id) => id != null);
    if (trackedParticipant?.championId != null && !championIds.includes(trackedParticipant.championId)) championIds.push(trackedParticipant.championId);
    const championImagesById = await getLolChampionImagesByIds(championIds);
    
    const context = await buildLolEmbedContext({
        account,
        queueId,
        queueType,
        participant: trackedParticipant,
        participants,
        gameStartTime,
        matchId,
        championImagesById,
    });

    const teamRostersBySideRole = buildNormalizedTeamRosters(participants);
    for (const side of ["BLUE", "RED"]) {
        for (const role of Object.keys(teamRostersBySideRole[side])) {
            teamRostersBySideRole[side][role] = teamRostersBySideRole[side][role].map((entry) => ({
                ...entry,
                championIconUrl: championImagesById.get(String(entry?.championId ?? "")) ?? null,
            }));
        }
    }

    const spellIds = [Number(trackedParticipant?.spell1Id), Number(trackedParticipant?.spell2Id)].filter(Number.isFinite);
    const spellSummary = spellIds.map((spellId, index) => `S${index + 1}: ${spellId}`).join(" • ");

    return {
        trackedPlayer: {
            riotId: context.riotId,
            puuid: resolvedIdentity?.puuid ?? null,
            participantFound: Boolean(trackedParticipant),
            participant: trackedParticipant,
        },
        queue: {
            queueId: queueId ?? null,
            queueType: context.queueType,
            queueLabel: context.queueLabel,
            isRanked: isRankedQueueForGame(GAME_TYPES.LOL, context.queueType),
        },
        game: {
            gameStartTimestamp: context.gameStartTimestamp,
            gameStartEpochSeconds: context.gameStartEpochSeconds,
            matchId: matchId ?? null,
            matchUrl: context.matchUrl,
        },
        rosters: { bySideRole: teamRostersBySideRole },
        display: {
            championDisplay: context.championDisplay,
            championId: trackedParticipant?.championId ?? null,
            championIconUrl: context.championIconUrl,
            championImageKey: context.resolvedImageKey,
            spellIds,
            spellSummary,
        },
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
    const dto = await buildLolGameDto({
        account,
        queueId,
        participants,
        gameStartTime: activeGame?.gameStartTime,
    });

    return {
        trackedPlayer: dto.trackedPlayer,
        queueLabel: dto.queue.queueLabel,
        gameStartEpochSeconds: dto.game.gameStartEpochSeconds,
        teamRostersBySideRole: dto.rosters.bySideRole,
        display: dto.display,
    };
}

const LOL_ROLE_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024;

function truncateForDiscordField(value, maxLength = DISCORD_EMBED_FIELD_VALUE_LIMIT) {
    const text = String(value ?? "");
    if (text.length <= maxLength) return text;
    if (maxLength <= 1) return text.slice(0, maxLength);
    return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeLolRoleKey(role) {
    const normalized = normalizeText(role).toUpperCase();

    if (["TOP"].includes(normalized)) return "TOP";
    if (["JUNGLE", "JGL"].includes(normalized)) return "JUNGLE";
    if (["MIDDLE", "MID"].includes(normalized)) return "MIDDLE";
    if (["BOTTOM", "BOT", "ADC"].includes(normalized)) return "BOTTOM";
    if (["UTILITY", "SUPPORT", "SUP"].includes(normalized)) return "UTILITY";
    return null;
}

function getChampionImageKeyFromUrl(imageUrl) {
    const text = String(imageUrl ?? "").trim();
    if (!text) return null;

    const fileName = text.split("/").pop();
    if (!fileName) return null;

    const key = fileName.replace(/\.png$/i, "").trim();
    return key || null;
}

function safeChampionLabel(participant) {
    const championName = String(participant?.championName ?? "").trim();
    if (championName) return championName;

    const imageKey = getChampionImageKeyFromUrl(participant?.championIconUrl);
    if (imageKey) return imageKey;

    const championId = participant?.championId;
    if (championId !== null && championId !== undefined && String(championId).trim() !== "") {
        return `ID ${String(championId).trim()}`;
    }

    return "—";
}

function formatRosterLineByRole(rosterByRole) {
    const inputRoleMap = rosterByRole && typeof rosterByRole === "object" ? rosterByRole : {};
    const normalizedRoleMap = {};

    for (const [rawRole, entries] of Object.entries(inputRoleMap)) {
        const normalizedRole = normalizeLolRoleKey(rawRole);
        if (!normalizedRole) continue;
        normalizedRoleMap[normalizedRole] = Array.isArray(entries) ? entries : [];
    }

    const fields = LOL_ROLE_ORDER.map((role) => {
        const participant = normalizedRoleMap[role]?.[0] ?? null;
        const championDisplay = safeChampionLabel(participant);
        return `${role}: ${championDisplay}`;
    });

    const output = fields.join(" | ").replace(/\b(undefined|null)\b/gi, "—");
    return truncateForDiscordField(output);
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
    const dto = await buildLolGameDto({
        account,
        queueType,
        participant,
        participants,
        gameStartTime: gameMs,
        matchId,
    });

    const trackedParticipant = dto.trackedPlayer.participant;
    const { matchUrl, gameStartTimestamp } = dto.game;
    const { queueLabel } = dto.queue;
    const { riotId } = dto.trackedPlayer;
    const { championIconUrl } = dto.display;

    const kills = Number(trackedParticipant?.kills ?? 0);
    const deaths = Number(trackedParticipant?.deaths ?? 0);
    const assists = Number(trackedParticipant?.assists ?? 0);
    const kda = `${kills}/${deaths}/${assists}`;
    const didWin = trackedParticipant?.win === true;
    const isRankedMatch = dto.queue.isRanked;

    const embed = new EmbedBuilder()
        .setURL(matchUrl)
        .setTimestamp(gameStartTimestamp)
        .setColor(didWin ? 0x2dcf71 : 0xf34e3c)
        .setTitle(`${queueLabel} • ${didWin ? "Victory" : "Defeat"} • ${riotId}`)

    const lpChangeValue = isRankedMatch ? formatDelta(didWin ? Math.abs(delta) : -Math.abs(delta)) : "—";
    const rankValue = isRankedMatch ? formatRankWithLp(afterRank) : "—";
    const damageDealt = Number(trackedParticipant?.totalDamageDealtToChampions ?? 0);
    const totalCs = Number(trackedParticipant?.totalMinionsKilled ?? 0) + Number(trackedParticipant?.neutralMinionsKilled ?? 0);
    const duration = formatDurationFromSeconds(trackedParticipant?.timePlayed ?? 0);
    const lane = trackedParticipant?.teamPosition ?? "Unknown";
    const visionScore = Number(trackedParticipant?.visionScore ?? 0);
    const csPerMin = duration === "Unknown" ? null : totalCs / (Number(trackedParticipant?.timePlayed) / 60);
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
    const queueId = Number(activeGame?.gameQueueConfigId ?? 0) || null;
    const participants = Array.isArray(activeGame?.participants) ? activeGame.participants : [];
    const dto = await buildLolGameDto({
        account,
        queueId,
        participants,
        gameStartTime: activeGame?.gameStartTime,
    });

    const redSideLine = formatRosterLineByRole(dto.rosters.bySideRole?.RED);
    const blueSideLine = formatRosterLineByRole(dto.rosters.bySideRole?.BLUE);

    const embed = new EmbedBuilder()
        .setColor(0x6a5cff)
        .setTitle(`${dto.queue.queueLabel} Game in Progress for ${dto.trackedPlayer.riotId}`)
        .addFields(
            { name: "Red Side", value: redSideLine, inline: false },
            { name: "Blue Side", value: blueSideLine, inline: false },
        )
        .setTimestamp(new Date());        

    if (dto.display.championIconUrl) embed.setThumbnail(dto.display.championIconUrl);

    return { embed, files: [] };
}
