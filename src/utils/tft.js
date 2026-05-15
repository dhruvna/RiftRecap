// === TFT utilities ===
// This module holds helpers for queue detection, placement formatting, and embeds.

import { EmbedBuilder } from 'discord.js';
import { 
    getMatchUrl,
    getTftRegaliaThumbnailUrl,
} from '../riot.js';
import { buildUnitStripImage } from './unitStrip.js';
import {
  GAME_TYPES,
  TFT_QUEUE_TYPES,
  isRankedQueueForGame,
  queueLabelForGame,
  queueTypeFromQueueId,
} from '../constants/queues.js';
import {
  formatRankAndLpFields,
  normalizeEmbedTimestamp,
  resolveLiveGamePresentation,
  resolveMatchResultPresentation,
} from './matchEmbedShared.js';

// === Queue helpers ===
// Extract the queue id from a match payload while handling API variations.
export function getQueueIdFromMatch(match) {
    const info = match?.info;
    const q = info?.queueId ?? info?.queue_id ?? null;
    return typeof q === 'number' ? q: (q ? Number(q) : null);
}

// Convert queue id into human-friendly metadata.
export function detectQueueMetaFromMatch(match) {
    const queueId = getQueueIdFromMatch(match);
    const queueType = queueTypeFromQueueId(queueId, GAME_TYPES.TFT);
    return { queueId, queueType, label: queueLabelForGame(GAME_TYPES.TFT, queueType) };
}

// Normalize placement for queue-specific differences (like Double Up).
export function normalizePlacement({ placement, queueType }) {
    if (typeof placement !== 'number' || placement < 1 || placement > 8) return null;

    if (queueType === TFT_QUEUE_TYPES.RANKED_DOUBLE_UP) {
        return Math.ceil(placement / 2); //
    } 

    return placement;
}

// Convert a placement number to ordinal text.
export function placementToOrdinal(placement) {
    if (!placement) return '?';
    if (placement === 1) return '1st';
    if (placement === 2) return '2nd';
    if (placement === 3) return '3rd';
    return `${placement}th`;
}

// === Embed construction ===
// Build the Discord embed used for match announcements.

export async function buildTftLiveGameEmbed({ account, activeGame }) {
    const queueId = Number(activeGame?.gameQueueConfigId ?? activeGame?.gameQueueId ?? activeGame?.queueId ?? 0) || null;
    const queueType = queueTypeFromQueueId(queueId, GAME_TYPES.TFT);
    const queueLabel = queueLabelForGame(GAME_TYPES.TFT, queueType);
    const riotId = `${account?.gameName ?? 'Unknown'}#${account?.tagLine ?? ''}`;

    const presentation = resolveLiveGamePresentation({
        queueLabel,
        riotId,
        game: GAME_TYPES.TFT,
    });

    const embed = new EmbedBuilder()
        .setColor(presentation.color)
        .setTitle(presentation.title)
        .setTimestamp(new Date())
        .addFields(
            { name: 'Queue', value: queueLabel, inline: true },
            { name: 'Riot ID', value: riotId, inline: true },
        );
    try {
        const thumbUrl = await getTftRegaliaThumbnailUrl({
            queueType,
            tier: null,
        });
        if (thumbUrl) embed.setThumbnail(thumbUrl);
    } catch {
    }

    return { embed, files: [] };
}

export async function buildMatchResultEmbed({ 
    account, 
    placement,
    matchId,
    queueType, 
    delta, 
    afterRank,
    participant,
    gameMs,
 }) {
    const matchUrl = getMatchUrl({ game: GAME_TYPES.TFT, matchId });
    const queueLabel = queueLabelForGame(GAME_TYPES.TFT, queueType);

    const p = typeof placement === 'number' ? placement : null;
    const d = typeof delta === 'number' ? delta : 0;

    const isRanked = isRankedQueueForGame(GAME_TYPES.TFT, queueType);
    
    const isWin = p !== null && p <= 4;
    const isLoss = p !== null && p >= 5;
    
    const { lpChangeValue, rankValue } = formatRankAndLpFields({
        isRanked,
        delta: d,
        afterRank,
    });
     
    // Start with a URL + timestamp so the embed is linkable and time-stamped
    const embed = new EmbedBuilder()
        .setURL(matchUrl)
        .setTimestamp(normalizeEmbedTimestamp(gameMs));

    if (isRanked) {
        try {
            const thumbUrl = await getTftRegaliaThumbnailUrl({
                queueType,
                tier: afterRank?.tier,
            });
            if (thumbUrl) embed.setThumbnail(thumbUrl);
        } catch {
            // ignore errors loading thumbnail  
        }
    }
    
    const riotId = `${account.gameName}#${account.tagLine}`;
    const ord = p ? placementToOrdinal(p) : 'N/A';

    const resultPresentation = resolveMatchResultPresentation({
        didWin: isWin ? true : (isLoss ? false : null),
        queueLabel,
        riotId,
        game: GAME_TYPES.TFT,
    });
    embed.setColor(resultPresentation.color).setTitle(resultPresentation.title);

    embed.addFields(
        { name: 'Placement', value: p ? ord : 'Unknown', inline: true },
        { name: 'LP Change', value: lpChangeValue, inline: true },
        { name: 'Rank', value: rankValue, inline: true }
    );

    let files = [];
    try {
        const unitImage = await buildUnitStripImage(participant?.units, {
            tileSize: 72,
            padding: 10,
            columns: 6,
            traits: participant?.traits,
            traitIconSize: 30,
        });
        if (unitImage) {
            files = [{ attachment: unitImage, name: 'units.png' }];
            embed.setImage('attachment://units.png');
        }
    } catch {
        // ignore image generation errors
    }
    return { embed, files };
}
