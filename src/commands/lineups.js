import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getGuildLineupStats } from '../storage/lineups.js';
import { withGuildCommand } from '../utils/withGuildCommand.js';
import { respondWithAccountChoices } from '../utils/autocomplete.js';

function parseLineupDisplay(lineupKey) {
    if (typeof lineupKey !== 'string' || !lineupKey.trim()) {
        return 'Unknown lineup';
    }
    return lineupKey.split('|').join(' + ');
}

function lineupIncludesAccount(lineupKey, accountKey) {
    if (typeof lineupKey !== 'string' || typeof accountKey !== 'string') {
        return false;
    }
    const normalizedAccountKey = accountKey.trim().toLowerCase();
    if (!normalizedAccountKey) {
        return false;
    }

    return lineupKey
        .split('|')
        .map((value) => value.trim().toLowerCase())
        .includes(normalizedAccountKey);
}

export default {
    data: new SlashCommandBuilder()
        .setName('lineups')
        .setDescription('Show top LoL lineups by win rate in this server')
        .addStringOption((opt) =>
            opt
                .setName('user')
                .setDescription('Only show lineups that include this registered user')
                .setRequired(false)
                .setAutocomplete(true)
        )
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
    async autocomplete(interaction) {
        try {
            await respondWithAccountChoices(interaction);
        } catch (err) {
            console.error('Error during lineups autocomplete:', err);
            return interaction.respond([]);
        }
    },
    execute: withGuildCommand(async (interaction, { guildId }) => {
        const selectedAccountKey = interaction.options.getString('user') ?? null;
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
            .filter((entry) => (selectedAccountKey ? lineupIncludesAccount(entry.lineupKey, selectedAccountKey) : true))
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
            .setTitle(`Top LoL Lineups for ${selectedAccountKey || 'All Players'} in This Server`)
            .setDescription(lines.join('\n'));

        await interaction.editReply({ embeds: [embed] });
    }, { defer: true, ephemeral: false, commandName: 'lineups' }),
};
