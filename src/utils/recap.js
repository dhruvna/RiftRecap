// === Imports ===
// Recap output is rendered into Discord embeds, with queue labels for clarity.

import { EmbedBuilder } from 'discord.js';
import { GAME_TYPES, queueLabel } from '../constants/queues.js';
import { modeLabel } from '../constants/recap.js';
import { medalForIndex } from './presentation.js';
import { getLolTracking, getTftTracking } from '../storage.js';

// === Formatting helpers ===
// Normalize LP deltas into a human-readable string.
function formatDelta(delta) {
  const d = Number(delta ?? 0);
  if (d > 0) return `↑ +${d} LP`;
  if (d < 0) return `↓ ${Math.abs(d)} LP`;
  return '0 LP';
}

// Consistent account name formatting across the board.
function accountName(a) {
  return `${a.gameName}#${a.tagLine}`;
}

// === Recap aggregation ===
// Compute per-account stats inside the requested time window
export function computeRecapRows(accounts, cutoffMs, wantedQueue, game = GAME_TYPES.TFT) {
  return accounts.map((account) => {
    const tracking = game === GAME_TYPES.LOL ? getLolTracking(account) : getTftTracking(account);
    const events = Array.isArray(tracking.recapEvents) ? tracking.recapEvents : [];
    const filtered = events.filter(
      (e) => Number(e?.at ?? 0) >= cutoffMs && e.queueType === wantedQueue
    );

    return {
      account,
      games: filtered.length,
      delta: filtered.reduce((s, e) => s + Number(e.delta ?? 0), 0),
      _nameKey: accountName(account).toLowerCase(), // for consistent sorting
    };
  });
}

// Sort by LP gains, then games played, then account name. Only include positive gains.
function sortByGains(rows) {
  return rows
    .filter((r) => r.games > 0 && r.delta >= 0)
    .sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      if (b.games !== a.games) return b.games - a.games;
      return a._nameKey.localeCompare(b._nameKey);
    });
}

// Sort by losses so the biggest negative deltas appear first.
function sortByLosses(rows) {
  return rows
    .filter((r) => r.delta < 0)
    .sort((a, b) => {
      if (a.delta !== b.delta) return a.delta - b.delta;
      if (b.games !== a.games) return b.games - a.games;
      return a._nameKey.localeCompare(b._nameKey);
    });
}

// Build line entries with medals and optional game counts.
function buildLines(rows, limit) {
  return rows.slice(0, limit).map((r, i) => {
    const games = r.games > 0 ? ` — ${r.games} games` : '';
    return `${medalForIndex(i)} **${accountName(r.account)}** ${formatDelta(r.delta)}${games}`;
  });
}

// === Embed construction ===
// Translate recap rows into a Discord embed for posting.
export function buildRecapEmbed({ rows, mode, game = GAME_TYPES.TFT, queue, hours }) {
  const totalGames = rows.reduce((s, r) => s + r.games, 0);

  const gains = sortByGains(rows);
  const losses = sortByLosses(rows);

  const gainsText = (buildLines(gains, 25).join('\n') || '—').slice(0, 1024);
  const lossesText =
    losses.length > 0
      ? buildLines(losses, 10).join('\n').slice(0, 1024)
      : '—';

  return new EmbedBuilder()
    .setTitle(`${modeLabel(mode)} Recap`)
    .addFields(
      { name: 'Top gains', value: gainsText, inline: true },
      { name: 'Top losses', value: lossesText, inline: true }
    )
    .setFooter({
      text: `${rows.length} players | ${totalGames} games • ${queueLabel(game, queue)} • last ${hours}h`,
    })
    .setTimestamp(new Date());
}
