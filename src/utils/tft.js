// === TFT utilities ===
// This module holds helpers for queue detection, placement formatting, and embeds.

import { EmbedBuilder } from "discord.js";
import { 
    getTFTMatchUrl,
    getTftRegaliaThumbnailUrl,
} from "../riot.js";
import { buildUnitStripImage } from "./unitStrip.js";
import {
  GAME_TYPES,
  TFT_QUEUE_TYPES,
} from "../constants/queues.js";
import {
  isRankedQueueForGame,
  queueLabelForGame,
  queueTypeFromQueueId,
} from "../constants/queues.js";
import { formatRankWithLp } from "./presentation.js";

// === Queue helpers ===
// Extract the queue id from a match payload while handling API variations.
export function getQueueIdFromMatch(match) {
    const info = match?.info;
    const q = info?.queueId ?? info?.queue_id ?? null;
    return typeof q === "number" ? q: (q ? Number(q) : null);
}

// Convert queue id into human-friendly metadata.
export function detectQueueMetaFromMatch(match) {
    const queueId = getQueueIdFromMatch(match);
    const queueType = queueTypeFromQueueId(queueId, GAME_TYPES.TFT);
    const mode = queueType === TFT_QUEUE_TYPES.RANKED ? "RANKED" : (queueType === TFT_QUEUE_TYPES.RANKED_DOUBLE_UP ? "DOUBLE UP" : "UNKNOWN");
    return { queueId, mode, queueType, label: queueLabelForGame(GAME_TYPES.TFT, queueType) };
}

// Normalize placement for queue-specific differences (like Double Up).
export function normalizePlacement({ placement, queueType}) {
    if (typeof placement !== "number" || placement < 1 || placement > 8) return null;

    if (queueType === TFT_QUEUE_TYPES.RANKED_DOUBLE_UP) {
        return Math.ceil(placement / 2); //
    } 

    return placement;
}

// Format LP delta for display.
export function formatDelta(delta) {
    if (!Number.isFinite(delta)) return "-";
    if (delta > 0) return `+${delta}`;
    if (delta < 0) return `-${Math.abs(delta)}`;
    return "0";
}

// Convert a placement number to ordinal text.
export function placementToOrdinal(placement) {
    if (!placement) return "?";
    if (placement === 1) return "1st";
    if (placement === 2) return "2nd";
    if (placement === 3) return "3rd";
    return `${placement}th`;
}

// Wrap queue label helper for semantic clarity at call sites.
export function labelForQueueType(queueType) {
    return queueLabelForGame(GAME_TYPES.TFT, queueType);
}

// === Embed construction ===
// Build the Discord embed used for match announcements.
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
    const matchUrl = getTFTMatchUrl({ matchId });
    const label = labelForQueueType(queueType);

    const p = typeof placement === "number" ? placement : null;
    const d = typeof delta === "number" ? delta : 0;

    const isRanked = isRankedQueueForGame(GAME_TYPES.TFT, queueType);
    
    const isWin = p !== null && p <= 4;
    const isLoss = p !== null && p >= 5;
    
    const lpChangeValue = isRanked ? formatDelta(d) : "—";
    const rankValue = isRanked ? formatRankWithLp(afterRank) : "—";
     
    // Start with a URL + timestamp so the embed is linkable and time-stamped
    const embed = new EmbedBuilder()
        .setURL(matchUrl)
        .setTimestamp(Number.isFinite(Number(gameMs)) && Number(gameMs) > 0 ? new Date(Number(gameMs)) : new Date());

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

    // Use different colors/titles for wins and losses for quick scanning.
    if (isWin) {
        embed.setColor(0x2dcf71).setTitle(`${label} Victory for ${riotId}!`);
    } else if (isLoss) {
        embed.setColor(0xf34e3c).setTitle(`${label} Defeat for ${riotId}...`);
    } else {
        embed
        .setColor(0x5865f2)
        .setTitle(`${label} Result for ${riotId}`)
    }

    embed.addFields(
        { name: "Placement", value: p ? ord : "Unknown", inline: true },
        { name: "LP Change", value: lpChangeValue, inline: true },
        { name: "Rank", value: rankValue, inline: true }
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
            files = [{ attachment: unitImage, name: "units.png" }];
            embed.setImage("attachment://units.png");
        }
    } catch {
        // ignore image generation errors
    }
    return { embed, files };
}