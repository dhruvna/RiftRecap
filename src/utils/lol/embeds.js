import { EmbedBuilder } from 'discord.js';
import { GAME_TYPES } from '../../constants/queues.js';
import {
    formatRankAndLpFields,
    normalizeEmbedTimestamp,
    resolveLiveGamePresentation,
    resolveMatchResultPresentation,
} from '../matchEmbedShared.js';
import {
    buildLolLiveMatchCardBuffer,
    buildParticipantLoadoutThumbnailBuffer,
} from '../liveDraftImage.js';
import { buildPentakillRoleMentionPayload, formatPentakillResultValue } from '../lolSpecialCase.js';
import { buildLolGameDto, buildLolLiveTeamPresentationModel } from './gameDto.js';

function formatDurationFromSeconds(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Unknown';

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

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
    channel = null,
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
    const { queueLabel, queueType: resolvedQueueType } = dto.queue;
    const { riotId } = dto.trackedPlayer;
    const { championIconUrl, spellIconUrls, runeIconUrl } = dto.display;

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
        queueType: resolvedQueueType,
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

    const pentakillValue = formatPentakillResultValue(trackedParticipant);
    const resultFields = [
        { name: 'K/D/A', value: kda, inline: true },
        { name: 'Damage', value: damageDealt.toLocaleString(), inline: true },
        // if lane = UTILITY, show vision score instead of CS/min (and corresponding label as well)
        { name: lane === 'UTILITY' ? 'Vision Score' : 'CS/min', value: lane === 'UTILITY' ? visionScore.toString() : (csPerMinLabel ?? '—'), inline: true },
        { name: 'Rank', value: rankValue.slice(0, 1024), inline: true },
        { name: didWin ? 'LP Win' : 'LP Loss', value: lpChangeValue, inline: true },
        { name: 'Duration', value: duration, inline: true },
    ];

    embed.addFields(...resultFields);

    const files = [];
    if (championIconUrl) {
        try {
            const thumbnailBuffer = await buildParticipantLoadoutThumbnailBuffer({
                championIconUrl,
                spellIconUrls,
                runeIconUrl,
            });
            files.push({ attachment: thumbnailBuffer, name: 'lol-match-thumbnail.png' });
            embed.setThumbnail('attachment://lol-match-thumbnail.png');
        } catch {
            embed.setThumbnail(championIconUrl);
        }
    }

    const mentionPayload = pentakillValue
        ? await buildPentakillRoleMentionPayload(channel, { participant: trackedParticipant, summonerName: riotId })
        : {};
    return { embed, files, ...mentionPayload };
}

export async function buildLolLiveGameEmbed({ account, activeGame }) {
    const model = await buildLolLiveTeamPresentationModel({ account, activeGame });

    const files = [];
    // const blueParticipants = model.sides.blue;
    // const redParticipants = model.sides.red;

    const presentation = resolveLiveGamePresentation({
        queueLabel: model.queueLabel,
        queueType: model.queueType,
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
        const cardBuffer = await buildLolLiveMatchCardBuffer(model);
        files.push({ attachment: cardBuffer, name: 'lol-live-draft.png' });
        // const stripBuffer = await buildLiveDraftImageBuffer({ blueParticipants, redParticipants });
        // files.push({ attachment: stripBuffer, name: 'lol-live-draft.png' });
        embed.setImage('attachment://lol-live-draft.png');
    } catch {
    }        

    if (model.display.championIconUrl) embed.setThumbnail(model.display.championIconUrl);

    return { embed, files };
}
