// === Imports ===
// Leaderboard needs Discord builders, storage, and rank snapshot helpers.
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { listGuildAccounts } from '../storage.js';

import { 
  GAME_TYPES, 
  ALL_LEADERBOARD_QUEUE_CHOICES,
  defaultRankedQueueForGame,
  queueLabel,
  gameFromQueue,
} from '../constants/queues.js';

import { getRankSnapshotForQueue } from '../utils/rankSnapshot.js';
import { formatRankWithLp, formatWinrate, medalForIndex } from '../utils/presentation.js';
import { withGuildCommand } from '../utils/withGuildCommand.js';

// === Ranking constants ===
// Tier ordering (low -> high) used to compute a sortable score.
const TIER_ORDER = [
  'IRON', // 0 - 399
  'BRONZE', // 400 - 799
  'SILVER', // 800 - 1199
  'GOLD', // 1200 - 1599
  'PLATINUM', // 1600 - 1999
  'EMERALD', // 2000 - 2399
  'DIAMOND', // 2400 - 2799
  'MASTER', // 2800+
  'GRANDMASTER',
  'CHALLENGER',
];

// Division ordering for non-apex tiers.
const DIVISION_ORDER = {
  IV: 0,
  III: 1,
  II: 2,
  I: 3,
};

// Convert a tier name into its index in TIER_ORDER.
function tierIndex(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? -1 : idx;
}

// Higher score = better rank. This normalizes tiers/divisions into one number.
function rankScore(rank) {
    if (!rank?.tier) return -1;

    const t = tierIndex(rank.tier);
    if (t < 0) return -1;

    // Master+ has no division, it's just above D1
    const isApex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier);
    const div = isApex ? 4 : (DIVISION_ORDER[rank.rank] ?? 0);
    const lp = Number(rank.lp ?? rank.leaguePoints ?? 0);

    // big base number so tiers/divisions dominate
    return t * 1_000_000 + div * 10_000 + lp;
}

// === Slash command definition ===
export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show server leaderboard for registered accounts by queue')
    .addStringOption((opt) =>
      opt
        .setName('queue')
        .setDescription('Which ladder? (TFT + LoL options)')
        .setRequired(false)
        .addChoices(...ALL_LEADERBOARD_QUEUE_CHOICES)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('How many entries to show (1–25)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25)
    ),

  // === Command handler ===
  // Build and send a leaderboard embed for the requested queue.
  execute: withGuildCommand(async (interaction, { guildId }) => {
    const queueType = interaction.options.getString('queue') ?? defaultRankedQueueForGame(GAME_TYPES.TFT);

    if (process.env.NODE_ENV !== 'production') {
      const validQueueTypes = new Set(ALL_LEADERBOARD_QUEUE_CHOICES.map((choice) => choice.value));
      console.assert(validQueueTypes.has(queueType), `[leaderboard] Unexpected queue type: ${queueType}`);
    }
    
    const game = gameFromQueue(queueType);
    const limit = interaction.options.getInteger('limit') ?? 15;

    const accounts = await listGuildAccounts(guildId);
    if (!accounts.length) {
      await interaction.editReply('No accounts registered in this server yet. Use `/register` first.');
      return;
    }
    
    // Map accounts to a sortable structure (rank + computed score).
    const ranked = accounts
      .map((account) => {
        const rank = getRankSnapshotForQueue(account, queueType, game);
        return {
            account,
            rank,
            score: rankScore(rank),
        };
      })
      .filter((entry) => entry.rank?.tier) // Only show ranked accounts in the requested queue.
      .sort((a, b) => b.score - a.score);
    
    if (!ranked.length) {
      await interaction.editReply('No ranked snapshots available for this queue yet.');
      return;
    }

    // Limit output so the embed stays readable.
    const shown = ranked.slice(0, limit);
    
    const queueLabelText = queueLabel(game, queueType);

    // Build the human-readable lines shown in the embed.
    const lines = shown.map((r, i) => {
      const name = `${r.account.gameName}#${r.account.tagLine}`;
      const rankStr = formatRankWithLp(r.rank);
    
      const wins = Number(r.rank?.wins ?? 0);
      const losses = Number(r.rank?.losses ?? 0);
      const wr = formatWinrate(wins, losses);

      // Only show W/L if we have an entry
      const stats = ` • ${wins}W-${losses}L • ${wr}`;

      return `${medalForIndex(i)} **${name}** — ${rankStr}${stats}`;
    });

    // Build and send the embed.
    const embed = new EmbedBuilder()
        .setTitle(`${game === GAME_TYPES.LOL ? 'LoL' : 'TFT'} Leaderboard — ${queueLabelText}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Showing top ${shown.length} of ${ranked.length} ranked account(s)` });
        
    await interaction.editReply({ embeds: [embed] });
  }, { defer: true, ephemeral: false, commandName: 'leaderboard' }),
};
