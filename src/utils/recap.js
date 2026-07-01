// === Imports ===
// Recap output is rendered into Discord embeds, with queue labels for clarity.

import { EmbedBuilder } from 'discord.js';
import { GAME_TYPES, queueLabel } from '../constants/queues.js';
import { modeLabel } from '../constants/recap.js';
import { medalForIndex } from './presentation.js';
import { getLolTracking, getTftTracking } from '../storage.js';
import { isAccountVisibleForGame } from './accountVisibility.js';

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

function isFiniteKdaStat(value) {
  return Number.isFinite(Number(value));
}

function formatKda({ kills, deaths, assists }) {
  const k = Number(kills ?? 0);
  const d = Number(deaths ?? 0);
  const a = Number(assists ?? 0);
  const ratio = d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2);
  return `${k}/${d}/${a} (${ratio})`;
}

function getTrackingForGame(account, game) {
  return game === GAME_TYPES.LOL ? getLolTracking(account) : getTftTracking(account);
}

function getRecapEventsForAccount(account, game) {
  const tracking = getTrackingForGame(account, game);
  return Array.isArray(tracking.recapEvents) ? tracking.recapEvents : [];
}

// === Recap aggregation ===
// Compute per-account stats inside the requested time window for the selected queue.
export function computeRecapRows(accounts, cutoffMs, wantedQueue, game = GAME_TYPES.TFT) {
  return accounts.filter((account) => isAccountVisibleForGame(account, game)).map((account) => {
    const events = getRecapEventsForAccount(account, game);
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

// Compute LoL KDA from the same recap events used by the selected recap.
export function computeRecapKdaRows(accounts, cutoffMs, wantedQueue, game = GAME_TYPES.TFT) {
  if (game !== GAME_TYPES.LOL) return [];
  return accounts.filter((account) => isAccountVisibleForGame(account, GAME_TYPES.LOL)).map((account) => {
    const events = getRecapEventsForAccount(account, GAME_TYPES.LOL);
    const filtered = events.filter((event) => (
      Number(event?.at ?? 0) >= cutoffMs
      && event?.queueType === wantedQueue
      && isFiniteKdaStat(event?.kills)
      && isFiniteKdaStat(event?.deaths)
      && isFiniteKdaStat(event?.assists)
    ));

    const kills = filtered.reduce((sum, event) => sum + Number(event.kills ?? 0), 0);
    const deaths = filtered.reduce((sum, event) => sum + Number(event.deaths ?? 0), 0);
    const assists = filtered.reduce((sum, event) => sum + Number(event.assists ?? 0), 0);

    return {
      account,
      games: filtered.length,
      kills,
      deaths,
      assists,
      _nameKey: accountName(account).toLowerCase(),
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

function sortByKdaGames(rows) {
  return rows
    .filter((row) => row.games > 0)
    .sort((a, b) => {
      if (b.games !== a.games) return b.games - a.games;
      const bRatio = b.deaths === 0 ? Number.POSITIVE_INFINITY : (b.kills + b.assists) / b.deaths;
      const aRatio = a.deaths === 0 ? Number.POSITIVE_INFINITY : (a.kills + a.assists) / a.deaths;
      if (bRatio !== aRatio) return bRatio - aRatio;
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

function buildKdaLines(rows, limit) {
  return rows.slice(0, limit).map((row, index) => {
    const games = row.games === 1 ? '1 game' : `${row.games} games`;
    return `${medalForIndex(index)} **${accountName(row.account)}** ${formatKda(row)} — ${games}`;
  });
}

// === Embed construction ===
// Translate recap rows into a Discord embed for posting.
export function buildRecapEmbed({ rows, mode, game = GAME_TYPES.TFT, queue, hours, kdaRows = [] }) {
  const totalGames = rows.reduce((s, r) => s + r.games, 0);

  const gains = sortByGains(rows);
  const losses = sortByLosses(rows);
  const sortedKdaRows = sortByKdaGames(kdaRows);

  const gainsText = (buildLines(gains, 25).join('\n') || '—').slice(0, 1024);
  const lossesText =
    losses.length > 0
      ? buildLines(losses, 10).join('\n').slice(0, 1024)
      : '—';

  const embed = new EmbedBuilder()
    .setTitle(`${modeLabel(mode)} Recap`)
    .addFields(
      { name: 'Top gains', value: gainsText, inline: true },
      { name: 'Top losses', value: lossesText, inline: true }
    )
    .setFooter({
      text: `${rows.length} players | ${totalGames} games • ${queueLabel(game, queue)} • last ${hours}h`,
    })
    .setTimestamp(new Date());
  if (game === GAME_TYPES.LOL && sortedKdaRows.length > 0) {
    embed.addFields({
      name: 'KDA',
      value: buildKdaLines(sortedKdaRows, 10).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}
