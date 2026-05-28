// === LOL utilities ===
// This module holds helpers for queue detection, placement formatting, and embeds.

import { EmbedBuilder } from 'discord.js';
import { 
    getMatchUrl,
    getLolChampionImagesByIds,
} from '../riot.js';
import { getLolIdentity } from '../storage.js';
import { GAME_TYPES, resolveLolQueueContext } from '../constants/queues.js';
import {
    formatRankAndLpFields,
    normalizeEmbedTimestamp,
    resolveLiveGamePresentation,
    resolveMatchResultPresentation,
    resolveQueuePresentation,
} from './matchEmbedShared.js';
import { resolveChampionIcon } from './lolChampionIcon.js';
import { buildLiveDraftImageBuffer } from './liveDraftImage.js';

function formatDurationFromSeconds(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Unknown';

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function normalizeText(value) {
    return String(value ?? '').trim().toLowerCase();
}

function normalizeTeamSide(teamId) {
    return Number(teamId) === 200 ? 'RED' : 'BLUE';
}

function buildNormalizedTeamRosters(participants) {
    if (!Array.isArray(participants) || participants.length === 0) {
        return { BLUE: [], RED: [] };
    }

    const rosters = participants.reduce((accumulator, participant) => {
        const side = normalizeTeamSide(participant?.teamId);
        const entry = {
            puuid: participant?.puuid ?? null,
            summonerName: participant?.summonerName ?? null,
            riotId: participant?.riotId ?? null,
            championId: participant?.championId ?? null,
            championName: participant?.championName ?? null,
            spell1Id: participant?.spell1Id ?? null,
            spell2Id: participant?.spell2Id ?? null,
            runeIds: Array.isArray(participant?.runeIds)
                ? participant.runeIds.map((id) => Number(id)).filter(Number.isFinite)
                : [],
        };

        accumulator[side].push(entry);
        return accumulator;

    }, { BLUE: [], RED: [] });

    const stableSort = (left, right) =>
        String(left?.summonerName ?? left?.riotId ?? left?.puuid ?? '')
            .localeCompare(String(right?.summonerName ?? right?.riotId ?? right?.puuid ?? ''), undefined, { sensitivity: 'base' });
    rosters.BLUE.sort(stableSort);
    rosters.RED.sort(stableSort);

    return rosters;

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

    const riotId = `${account?.gameName ?? 'Unknown'}#${account?.tagLine ?? ''}`;
    const queueContext = resolveQueuePresentation({
        game: GAME_TYPES.LOL,
        queueId,
        queueType,
        queueResolver: ({ queueId: resolvedQueueId, queueType: rawQueueType }) => resolveLolQueueContext({ queueId: resolvedQueueId, rawQueueType }),
    });
    const resolvedQueueType = queueContext.queueType;
    const queueLabel = queueContext.queueLabel;

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
        isRanked: queueContext.isRanked,
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

    const teamRostersBySide = buildNormalizedTeamRosters(participants);
    for (const side of ['BLUE', 'RED']) {
        teamRostersBySide[side] = teamRostersBySide[side].map((entry) => ({
            ...entry,
            championIconUrl: championImagesById.get(String(entry?.championId ?? '')) ?? null,
        }));
    }

    const spellIds = [Number(trackedParticipant?.spell1Id), Number(trackedParticipant?.spell2Id)].filter(Number.isFinite);
    const spellSummary = spellIds.map((spellId, index) => `S${index + 1}: ${spellId}`).join(' • ');

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
            isRanked: context.isRanked,
        },
        game: {
            gameStartTimestamp: context.gameStartTimestamp,
            gameStartEpochSeconds: context.gameStartEpochSeconds,
            matchId: matchId ?? null,
            matchUrl: context.matchUrl,
        },
        rosters: { bySide: teamRostersBySide },
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
 * @property {{ BLUE: Array<Object>, RED: Array<Object> }} teamRostersBySide
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
        teamRostersBySide: dto.rosters.bySide,
        display: dto.display,
    };
}

export async function buildLolLiveTeamPresentationModel({ account, activeGame, identity = null }) {
    const queueId = Number(activeGame?.gameQueueConfigId ?? 0) || null;
    const participants = Array.isArray(activeGame?.participants)
        ? activeGame.participants.map((participant) => {
            const perkIds = Array.isArray(participant?.perks?.perkIds) ? participant.perks.perkIds : [];
            return {
                ...participant,
                runeIds: perkIds,
            };
        })
        : [];

    const dto = await buildLolGameDto({
        account,
        identity,
        queueId,
        participants,
        gameStartTime: activeGame?.gameStartTime,
    });

    const red = dto.rosters.bySide?.RED ?? [];
    const blue = dto.rosters.bySide?.BLUE ?? [];

    const tracked = dto.trackedPlayer?.participant ?? null;

    return {
        trackedPlayer: {
            ...dto.trackedPlayer,
            metadata: tracked ? {
                teamId: tracked?.teamId ?? null,
                championId: tracked?.championId ?? null,
                spellIds: [Number(tracked?.spell1Id), Number(tracked?.spell2Id)].filter(Number.isFinite),
                runeIds: Array.isArray(tracked?.runeIds)
                    ? tracked.runeIds.map((id) => Number(id)).filter(Number.isFinite)
                    : [],
            } : null,
        },
        queueLabel: dto.queue.queueLabel,
        gameStartEpochSeconds: dto.game.gameStartEpochSeconds,
        display: dto.display,
        sides: { red, blue },
    };
}

// === Queue helpers ===
// Extract the queue id from a match payload while handling API variations.
export function getQueueIdFromLolMatch(match) {
    const info = match?.info;
    const q = info?.queueId ?? info?.queue_id ?? null;
    return typeof q === 'number' ? q : (q ? Number(q) : null);
}

// Convert queue id into human-friendly metadata.
export function detectLolQueueMetaFromMatch(match) {
    const queueId = getQueueIdFromLolMatch(match);
    const resolved = resolveQueuePresentation({
        game: GAME_TYPES.LOL,
        queueId,
        queueResolver: ({ queueId: resolvedQueueId }) => resolveLolQueueContext({ match, queueId: resolvedQueueId }),
    });
    return { queueId, queueType: resolved.queueType, label: resolved.queueLabel, isRanked: resolved.isRanked };
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
        .setTimestamp(normalizeEmbedTimestamp(gameStartTimestamp?.getTime?.() ?? gameMs));

        const resultPresentation = resolveMatchResultPresentation({
        didWin,
        queueLabel,
        riotId,
        game: GAME_TYPES.LOL,
    });

    embed
        .setColor(resultPresentation.color)
        .setTitle(resultPresentation.title);

    const { lpChangeValue, rankValue } = formatRankAndLpFields({
        isRanked: isRankedMatch,
        delta,
        didWin,
        afterRank,
    });

    const damageDealt = Number(trackedParticipant?.totalDamageDealtToChampions ?? 0);
    const totalCs = Number(trackedParticipant?.totalMinionsKilled ?? 0) + Number(trackedParticipant?.neutralMinionsKilled ?? 0);
    const duration = formatDurationFromSeconds(trackedParticipant?.timePlayed ?? 0);
    const lane = trackedParticipant?.teamPosition ?? 'Unknown';
    const visionScore = Number(trackedParticipant?.visionScore ?? 0);
    const csPerMin = duration === 'Unknown' ? null : totalCs / (Number(trackedParticipant?.timePlayed) / 60);
    const csPerMinLabel = Number.isFinite(csPerMin) && csPerMin > 0 ? `${csPerMin.toFixed(1)} CS/min` : null;

    embed.addFields(
        { name: 'K/D/A', value: kda, inline: true },
        { name: 'Damage', value: damageDealt.toLocaleString(), inline: true },  
        // if lane = UTILITY, show vision score instead of CS/min (and corresponding label as well)
        { name: lane === 'UTILITY' ? 'Vision Score' : 'CS/min', value: lane === 'UTILITY' ? visionScore.toString() : (csPerMinLabel ?? '—'), inline: true },
        { name: 'Rank', value: rankValue.slice(0, 1024), inline: true },
        { name: didWin ? 'LP Win' : 'LP Loss', value: lpChangeValue, inline: true },
        { name: 'Duration', value: duration, inline: true },
        // { name: "Lane", value: lane, inline: true },
    );

    if (championIconUrl) embed.setThumbnail(championIconUrl);
    return { embed, files: [] };
}

export async function buildLolLiveGameEmbed({ account, activeGame }) {
    const model = await buildLolLiveTeamPresentationModel({ account, activeGame });

    const files = [];
    const blueIconUrls = model.sides.blue.map((participant) => participant?.championIconUrl ?? null);
    const redIconUrls = model.sides.red.map((participant) => participant?.championIconUrl ?? null);

    const presentation = resolveLiveGamePresentation({
        queueLabel: model.queueLabel,
        riotId: model.trackedPlayer.riotId,
        game: GAME_TYPES.LOL,
    });

    const embed = new EmbedBuilder()
        .setColor(presentation.color)
        .setTitle(presentation.title)
        .setTimestamp(new Date());

    const gameName = String(account?.gameName ?? '').trim();
    const tagLine = String(account?.tagLine ?? '').trim();
    if (gameName && tagLine) {
        embed.setURL(`https://porofessor.gg/live/na/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`);
    }

    try {
        const stripBuffer = await buildLiveDraftImageBuffer({ blueIconUrls, redIconUrls });
        files.push({ attachment: stripBuffer, name: 'lol-live-draft.png' });
        embed.setImage('attachment://lol-live-draft.png');
    } catch {
    }        

    if (model.display.championIconUrl) embed.setThumbnail(model.display.championIconUrl);

    return { embed, files };
}
