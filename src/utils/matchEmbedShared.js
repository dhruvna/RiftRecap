import { GAME_TYPES, isRankedQueueForGame, queueLabelForGame } from '../constants/queues.js';
import { formatDelta, formatRankWithLp } from './presentation.js';

export const MATCH_RESULT_COLORS = Object.freeze({
  WIN: 0x2dcf71,
  LOSS: 0xf34e3c,
  NEUTRAL: 0x5865f2,
});

export const LIVE_GAME_COLORS = Object.freeze({
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
    : { queueType, queueLabel: queueLabelForGame(game, queueType), isRanked: isRankedQueueForGame(game, queueType) };

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

export function resolveMatchResultPresentation({ didWin, queueLabel, riotId, game }) {
  if (didWin === true) {
    return {
      color: MATCH_RESULT_COLORS.WIN,
      title: game === GAME_TYPES.TFT ? `${queueLabel} Victory for ${riotId}!` : `${queueLabel} • Victory • ${riotId}`,
    };
  }

  if (didWin === false) {
    return {
      color: MATCH_RESULT_COLORS.LOSS,
      title: game === GAME_TYPES.TFT ? `${queueLabel} Defeat for ${riotId}...` : `${queueLabel} • Defeat • ${riotId}`,
    };
  }

  return {
    color: MATCH_RESULT_COLORS.NEUTRAL,
    title: game === GAME_TYPES.TFT ? `${queueLabel} Result for ${riotId}` : `${queueLabel} • Result • ${riotId}`,
  };
}

export function resolveLiveGamePresentation({ queueLabel, riotId, game }) {
  return {
    color: LIVE_GAME_COLORS.DEFAULT,
    title: game === GAME_TYPES.TFT
      ? `${queueLabel} Game in Progress for ${riotId}`
      : `${queueLabel} Game in Progress for ${riotId}`,
  };
}
