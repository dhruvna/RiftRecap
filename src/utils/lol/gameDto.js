import {
    getMatchUrl,
    getLolChampionImagesByIds,
    getLolChampionSkinImagesBySelections,
    getLolSpellImagesByIds,
    getLolRuneImagesByIds,
} from '../../riot.js';
import { getLolIdentity } from '../../storage.js';
import { GAME_TYPES, resolveLolQueueContext } from '../../constants/queues.js';
import { resolveQueuePresentation } from '../matchEmbedShared.js';
import { resolveChampionIcon } from '../lolChampionIcon.js';
import {
    buildNormalizedTeamBans,
    buildNormalizedTeamRosters,
    getParticipantRuneIds,
    getParticipantSpellIds,
    resolveTrackedParticipant,
} from './participants.js';

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

export async function buildLolGameDto({
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
    const spellIds = participants.flatMap((p) => getParticipantSpellIds(p));
    const runeIds = participants.flatMap((p) => getParticipantRuneIds(p));
    if (trackedParticipant) {
        spellIds.push(...getParticipantSpellIds(trackedParticipant));
        runeIds.push(...getParticipantRuneIds(trackedParticipant));
    }

    const skinSelections = participants.map((p) => ({
        championId: p?.championId,
        skinNum: p?.lastSelectedSkinIndex,
    }));
    const [championImagesById, championSkinImagesBySelection, spellImagesById, runeImagesById] = await Promise.all([
        getLolChampionImagesByIds(championIds),
        getLolChampionSkinImagesBySelections(skinSelections),
        getLolSpellImagesByIds(spellIds),
        getLolRuneImagesByIds(runeIds),
    ]);
    
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
            championSkinTileUrl: championSkinImagesBySelection.get(
                `${String(entry?.championId ?? '').trim()}:${entry?.lastSelectedSkinIndex}`,
            ) ?? null,
            spellIconUrls: getParticipantSpellIds(entry)
                .map((spellId) => spellImagesById.get(String(spellId)) ?? null)
                .filter(Boolean),
            runeIconUrl: runeImagesById.get(String(getParticipantRuneIds(entry)[0] ?? '')) ?? null,
        }));
        
    }

    const trackedSpellIds = getParticipantSpellIds(trackedParticipant);
    const trackedRuneIds = getParticipantRuneIds(trackedParticipant);
    const spellSummary = trackedSpellIds.map((spellId, index) => `S${index + 1}: ${spellId}`).join(' • ');

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
            spellIds: trackedSpellIds,
            spellSummary,
            spellIconUrls: trackedSpellIds
                .map((spellId) => spellImagesById.get(String(spellId)) ?? null)
                .filter(Boolean),
            runeIds: trackedRuneIds,
            runeIconUrl: runeImagesById.get(String(trackedRuneIds[0] ?? '')) ?? null,
        },
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
    const bansBySide = buildNormalizedTeamBans(activeGame?.bannedChampions);
    const banChampionIds = [...bansBySide.BLUE, ...bansBySide.RED]
        .filter((ban) => !ban.isPlaceholder)
        .map((ban) => ban.championId);
    const banChampionImagesById = await getLolChampionImagesByIds(banChampionIds);
    const addBanIconUrl = (ban) => ({
        ...ban,
        championIconUrl: ban.isPlaceholder ? null : (banChampionImagesById.get(String(ban.championId)) ?? null),
    });

    const tracked = dto.trackedPlayer?.participant ?? null;

    return {
        trackedPlayer: {
            ...dto.trackedPlayer,
            metadata: tracked ? {
                teamId: tracked?.teamId ?? null,
                championId: tracked?.championId ?? null,
                spellIds: getParticipantSpellIds(tracked),
                runeIds: getParticipantRuneIds(tracked),
            } : null,
        },
        queueType: dto.queue.queueType,
        queueLabel: dto.queue.queueLabel,
        gameStartEpochSeconds: dto.game.gameStartEpochSeconds,
        display: dto.display,
        sides: {
            red,
            blue,
            redBans: bansBySide.RED.map(addBanIconUrl),
            blueBans: bansBySide.BLUE.map(addBanIconUrl),
        },
    };
}
