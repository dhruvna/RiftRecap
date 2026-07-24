import { GAME_TYPES, isRankedQueue, queueLabel } from '../constants/queues.js';
import { formatDelta, formatRankWithLp } from './presentation.js';
import { EmbedBuilder } from 'discord.js';

const MATCH_RESULT_COLORS = Object.freeze({
  WIN: 0x2dcf71,
  LOSS: 0xf34e3c,
  NEUTRAL: 0x5865f2,
});

const LIVE_GAME_COLORS = Object.freeze({
  DEFAULT: 0x6a5cff,
});

export function normalizeEmbedTimestamp(gameMs) {
  const value = Number(gameMs);
  if (Number.isFinite(value) && value > 0) return new Date(value);
  return new Date();
}

export function resolveQueuePresentation({ game, queueType, queueId = null, queueResolver = null }) {
  const resolved = typeof queueResolver === 'function'
    ? queueResolver({ queueId, queueType })
    : { queueType, queueLabel: queueLabel(game, queueType), isRanked: isRankedQueue(game, queueType) };

  return {
    queueId,
    queueType: resolved.queueType,
    queueLabel: resolved.queueLabel,
    isRanked: Boolean(resolved.isRanked),
  };
}

export function formatRankAndLpFields({ isRanked, delta = 0, didWin = null, afterRank }) {
  if (!isRanked) return { lpChangeValue: '—', rankValue: '—' };
  const normalizedDelta = Number(delta);
  const deltaValue = Number.isFinite(normalizedDelta) ? normalizedDelta : 0;
  const directionalDelta = didWin === null ? deltaValue : (didWin ? Math.abs(deltaValue) : -Math.abs(deltaValue));
  return {
    lpChangeValue: formatDelta(directionalDelta),
    rankValue: formatRankWithLp(afterRank),
  };
}

export function resolveMatchResultPresentation({ didWin, queueLabel, queueType, riotId, game }) {
  if (game === GAME_TYPES.LOL && isLolClashQueue(queueType)) {
    const result = didWin === true ? 'VICTORY' : didWin === false ? 'DEFEAT' : 'RESULT';
    const color = didWin === true ? MATCH_RESULT_COLORS.WIN : didWin === false ? MATCH_RESULT_COLORS.LOSS : MATCH_RESULT_COLORS.NEUTRAL;
    return { color, title: `🏆 ${queueLabel} • ${result} • ${riotId}` };
  }
  if (didWin === true) {
    return {
      color: MATCH_RESULT_COLORS.WIN,
      title: `${queueLabel} • Victory • ${riotId}`,
    };
  }

  if (didWin === false) {
    return {
      color: MATCH_RESULT_COLORS.LOSS,
      title: `${queueLabel} • Defeat • ${riotId}`,
    };
  }

  return {
    color: MATCH_RESULT_COLORS.NEUTRAL,
    title: `${queueLabel} • Result • ${riotId}`,
  };
}

export function resolveLiveGamePresentation({ queueLabel }) {
  return {
    color: LIVE_GAME_COLORS.DEFAULT,
    title: `${queueLabel} game in progress!`,
  };
}

const TIER_PROGRESS_ORDER = Object.freeze(['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVISION_PROGRESS_ORDER = Object.freeze(['IV', 'III', 'II', 'I']);

function tierProgressIndex(tier) {
    return typeof tier === 'string' ? TIER_PROGRESS_ORDER.indexOf(tier.toUpperCase()) : -1;
}

function divisionProgressIndex(division) {
  return typeof division === 'string' ? DIVISION_PROGRESS_ORDER.indexOf(division.toUpperCase()) : -1;
}

function rankBoundaryIndex(rank) {
  if (!rank?.tier) return null;

  const tierIndex = tierProgressIndex(rank.tier);
  if (tierIndex < 0) return null;

  const isApexTier = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(String(rank.tier).toUpperCase());
  if (isApexTier) return tierIndex * 10;

  const divisionIndex = divisionProgressIndex(rank.rank);
  if (divisionIndex < 0) return null;

  return tierIndex * 10 + divisionIndex;
}

function findTierChange({ beforeRank, afterRank }) {
  const beforeBoundary = rankBoundaryIndex(beforeRank);
  const afterBoundary = rankBoundaryIndex(afterRank);
  if (beforeBoundary === null || afterBoundary === null || beforeBoundary === afterBoundary) return false;
  return afterBoundary > beforeBoundary ? 'promote' : 'demote';
}

export function buildTierChangeEmbed({ account, queueType, beforeRank, afterRank }) {
  const tierChange = findTierChange({ beforeRank, afterRank });
  if (!tierChange) return;

  let riotId = null;
  // if (account?.gameName === "LoneRonin") {
  //   riotId = "The Rift Terrorist";
  // } 
  // else if (account?.gameName === "Robotros") {
  //   riotId = "The Rift Robot";
  // }
  // else {
  //   riotId = `${account?.gameName ?? 'Unknown'}#${account?.tagLine ?? ''}`;
  // }
  const beforeRankStr = formatRankWithLp(beforeRank);
  const afterRankStr = formatRankWithLp(afterRank);
  const color = tierChange === 'promote' ? 0xf5b642 : 0xf34e3c;
  const title = tierChange === 'promote'
    ? '✨ Rank Promotion! ✨'
    : '😭🤣 Rank Demotion 🤣😭';
  const description = tierChange === 'promote'
    ? `**${account?.gameName || riotId}** promoted from ${beforeRankStr} to ${afterRankStr} in ${queueType}`
    : `**${account?.gameName || riotId}** demoted from ${beforeRankStr} to ${afterRankStr} in ${queueType}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp(new Date());
  return embed;
}
