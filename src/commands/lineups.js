import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getGuildLineupStats } from '../storage/lineups.js';
import { withGuildCommand } from '../utils/withGuildCommand.js';

function parseLineupDisplay(lineupKey) {
    if (typeof lineupKey !== 'string' || !lineupKey.trim()) {
        return 'Unknown lineup';
    }
    return lineupKey.split('|').join(' + ');
}

export default {
    data: new SlashCommandBuilder()
        .setName('lineups')
        .setDescription('Show top LoL lineups by win rate in this server')
        .addIntegerOption((opt) =>
            opt
                .setName('min_games')
                .setDescription('Minimum games played for a lineup to be included')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .addIntegerOption((opt) =>
            opt
                .setName('limit')
                .setDescription('Max lineups to show (default: 10, can show up to 20 best lineups)',)
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)
        ),

    execute: withGuildCommand(async (interaction, { guildId }) => {
        const minGames = interaction.options.getInteger('min_games') ?? 1;
        const limit = interaction.options.getInteger('limit') ?? 10;

        const stats = await getGuildLineupStats(guildId);
        const entries = Object.entries(stats)
            .map(([lineupKey, value]) => {
                const wins = Number(value?.wins ?? 0);
                const losses = Number(value?.losses ?? 0);
                const games = Number(value?.games ?? wins + losses);
                const winRate = games > 0 ? wins / games : 0;
                return { lineupKey, wins, losses, games, winRate };
            })
            .filter((entry) => entry.games >= minGames)
            .sort((a, b) => {
                if (b.winRate !== a.winRate) return b.winRate - a.winRate;
                if (b.games !== a.games) return b.games - a.games;
                if (b.wins !== a.wins) return b.wins - a.wins;
                return a.lineupKey.localeCompare(b.lineupKey);
            })
            .slice(0, limit);

        if (entries.length === 0) {
            await interaction.editReply(`No lineup stats found for this server with at least ${minGames} games.`);
            return;
        }

        const lines = entries.map((entry, index) => {
            const pct = (entry.winRate * 100).toFixed(1);
            return `${index + 1}. **${parseLineupDisplay(entry.lineupKey)}** — ${pct}% (${entry.wins}W-${entry.losses}L)`;
        });

        const embed = new EmbedBuilder()
            .setTitle('Top LoL Lineups in This Server')
            .setDescription(lines.join('\n'))

        await interaction.editReply({ embeds: [embed] });
    }, { defer: true, ephemeral: false, commandName: 'lineups' }),
};
