import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getGuildLineupStats } from '../storage/lineups.js';
import { withGuildCommand } from '../utils/withGuildCommand.js';
import { respondWithAccountChoices } from '../utils/autocomplete.js';

function parseLineupDisplay(lineupKey) {
    if (typeof lineupKey !== 'string' || !lineupKey.trim()) {
        return 'Unknown lineup';
    }
    const names = lineupKey.split('|').map((part) => {
        const trimmedPart = part.trim();
        const atIndex = trimmedPart.indexOf('@');
        if (atIndex === -1) {
            return trimmedPart; // if there's no @, return the whole part
        }
        return trimmedPart.substring(0, atIndex); // return only the part before the @
    });
    return names.join(' + ');
}

function buildLineupFiltersText({ lineupSize, minGames, selectedAccountKey }) {
    const filters = [
        `Size: ${lineupSize ?? 'All'}`,
        `Min games: ${minGames}`,
    ];

    if (selectedAccountKey) {
        filters.push(`User: ${parseLineupDisplay(selectedAccountKey)}`);
    }

    return filters.join(' • ');
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

const LINEUP_CONTEXT_MIN_GAMES = 5;

const ROLE_DISPLAY_NAMES = {
    TOP: 'top',
    JUNGLE: 'jungle',
    MIDDLE: 'mid',
    MID: 'mid',
    BOTTOM: 'bot',
    ADC: 'bot',
    BOT: 'bot',
    SUPPORT: 'support',
    UTILITY: 'support',
};

function getLineupMemberKeys(lineupKey) {
    if (typeof lineupKey !== 'string' || !lineupKey.trim()) {
        return [];
    }
    return lineupKey
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean);
}

function getCounterGames(counter) {
    if (typeof counter === 'number') return counter;
    return Number(counter?.games ?? 0);
}

function getCounterWins(counter) {
    if (typeof counter === 'number') return 0;
    return Number(counter?.wins ?? 0);
}

function selectTopCounterValue(counters = {}, { preferWins = false } = {}) {
    if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
        return null;
    }

    return Object.entries(counters)
        .map(([value, counter]) => ({ value, games: getCounterGames(counter), wins: getCounterWins(counter) }))
        .filter((entry) => entry.value && entry.games > 0)
        .sort((a, b) => {
            if (preferWins) {
                const aWinRate = a.games > 0 ? a.wins / a.games : 0;
                const bWinRate = b.games > 0 ? b.wins / b.games : 0;
                if (bWinRate !== aWinRate) return bWinRate - aWinRate;
                if (b.wins !== a.wins) return b.wins - a.wins;
            }
            if (b.games !== a.games) return b.games - a.games;
            if (b.wins !== a.wins) return b.wins - a.wins;
            return a.value.localeCompare(b.value);
        })[0]?.value ?? null;
}

function formatRoleName(role) {
    if (typeof role !== 'string') return null;
    const normalized = role.trim().toUpperCase();
    return ROLE_DISPLAY_NAMES[normalized] ?? normalized.toLowerCase();
}

function buildLineupContextLines(entry) {
    if (entry.games < LINEUP_CONTEXT_MIN_GAMES) {
        return [];
    }

    const memberKeys = getLineupMemberKeys(entry.lineupKey);
    const roleNames = memberKeys
        .map((memberKey) => formatRoleName(selectTopCounterValue(entry.rolesByMember?.[memberKey])))
        .filter(Boolean);
    const championNames = memberKeys
        .map((memberKey) => selectTopCounterValue(entry.championsByMember?.[memberKey], { preferWins: true }))
        .filter(Boolean);
    const contextLines = [];

    if (roleNames.length >= 2) {
        contextLines.push(`Most common roles: ${roleNames.join(' + ')}`);
    }
    if (championNames.length >= 2) {
        contextLines.push(`Best champs together: ${championNames.join(' / ')}`);
    }

    return contextLines;
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
                .setName('size')
                .setDescription('Only show lineups with this many registered players')
                .setRequired(false)
                .addChoices(
                    { name: '2', value: 2 },
                    { name: '3', value: 3 },
                    { name: '5', value: 5 }
                )
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
        const lineupSize = interaction.options.getInteger('size') ?? null;

        const stats = await getGuildLineupStats(guildId);
        const entries = Object.entries(stats)
            .map(([lineupKey, value]) => {
                const wins = Number(value?.wins ?? 0);
                const losses = Number(value?.losses ?? 0);
                const games = Number(value?.games ?? wins + losses);
                const winRate = games > 0 ? wins / games : 0;
                const size = lineupKey.split('|').length;
                return {
                    lineupKey,
                    wins,
                    losses,
                    games,
                    winRate,
                    size,
                    rolesByMember: value?.rolesByMember,
                    championsByMember: value?.championsByMember,
                };
            })
            .filter((entry) => (lineupSize ? entry.size === lineupSize : true))
            .filter((entry) => entry.games >= minGames)
            .filter((entry) => (selectedAccountKey ? lineupIncludesAccount(entry.lineupKey, selectedAccountKey) : true))
            .sort((a, b) => {
                if (b.winRate !== a.winRate) return b.winRate - a.winRate;
                if (b.games !== a.games) return b.games - a.games;
                if (b.wins !== a.wins) return b.wins - a.wins;
                return a.lineupKey.localeCompare(b.lineupKey);
            })
            .slice(0, 10);

        if (entries.length === 0) {
            const sizeText = lineupSize ? ` and ${lineupSize} registered players` : '';
            await interaction.editReply(`No lineup stats found for this server with at least ${minGames} games${sizeText}.`);
            return;
        }

        const shouldShowLineupSize = !lineupSize;
        const lines = entries.map((entry, index) => {
            const pct = (entry.winRate * 100).toFixed(1);
            const sizeLabel = shouldShowLineupSize ? ` [${entry.size}-player]` : '';
            const contextLines = buildLineupContextLines(entry).map((line) => `   ${line}`);
            return [
                `${index + 1}.${sizeLabel} **${parseLineupDisplay(entry.lineupKey)}** — ${pct}% (${entry.wins}W-${entry.losses}L)`,
                ...contextLines,
            ].join('\n');
        });

        const embed = new EmbedBuilder()
            .setTitle('Top LoL Lineups')
            .setDescription(lines.join('\n'))
            .setFooter({ text: buildLineupFiltersText({ lineupSize, minGames, selectedAccountKey }) });


        await interaction.editReply({ embeds: [embed] });
    }, { defer: true, ephemeral: false, commandName: 'lineups' }),
};
