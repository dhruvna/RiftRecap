import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTftRegaliaThumbnailUrl, getLeagueOfGraphsUrl, getLolProfileUrl } from "../riot.js";
import { GAME_TYPES, LOL_QUEUE_TYPES, TFT_QUEUE_TYPES, TRACKING_GAME_CHOICES } from "../constants/queues.js"
import { queueLabelForGame, rankedQueueChoicesByGame } from "../constants/queues.js"
import { getLolTracking, getTftTracking, loadDb, normalizeAccountTracking } from "../storage.js";
import { respondWithAccountChoices } from "../utils/autocomplete.js";
import { formatRankLine, formatWinrate } from "../utils/presentation.js";

/* Add a section for a specific queue type to the fields array 
   - A header field with the rank line
   - 3 inline stat fields (Wins/Losses/Winrate) aligned as columns */
function addQueueSection(fields, label, entry) {
    const wins = entry.wins ?? 0;
    const losses = entry.losses ?? 0;
    const wr = formatWinrate(wins, losses);

    // Header / rank line
    fields.push({ name: label, value: `**${formatRankLine(entry)}**`, inline: false });
    fields.push(
        { name: "Wins", value: `${wins}`, inline: true },
        { name: "Losses", value: `${losses}`, inline: true },
        { name: "Winrate", value: `${wr}`, inline: true }
    );
}

function formatLastUpdated(lastUpdatedAt) {
    const millis = Number(lastUpdatedAt);
    if (!Number.isFinite(millis) || millis <= 0) return "Unknown";

    const unixSeconds = Math.floor(millis / 1000);
    return `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`;
}

function buildQueueEntry(lastRankByQueue, queueType, gameType) {
    const snapshot = lastRankByQueue?.[queueType];
    if (!snapshot) return null;

    return { ...snapshot, queueType, gameType };
}

const QUEUE_DEFINITIONS = [
    ...rankedQueueChoicesByGame(GAME_TYPES.TFT).map((choice) => ({ gameType: GAME_TYPES.TFT, queueType: choice.value, enabledBySelectedGame: (selectedGame) => selectedGame === "BOTH" || selectedGame === "TFT" })),
    ...rankedQueueChoicesByGame(GAME_TYPES.LOL).map((choice) => ({ gameType: GAME_TYPES.LOL, queueType: choice.value, enabledBySelectedGame: (selectedGame) => selectedGame === "BOTH" || selectedGame === "LOL" })),
];

async function buildQueueEmbed({account, label, entry}) {
    const fields = [];
    addQueueSection(fields, label, entry);

    fields.push({ name: "Last updated", value: formatLastUpdated(entry.lastUpdatedAt), inline: false });
    const profileUrl = entry.gameType === GAME_TYPES.LOL
        ? getLolProfileUrl({ region: account.region, gameName: account.gameName, tagLine: account.tagLine })
        : getLeagueOfGraphsUrl({ region: account.region, gameName: account.gameName, tagLine: account.tagLine });

    const embed = new EmbedBuilder()
        .setTitle(`${account.gameName}#${account.tagLine} — ${label}`)
        .addFields(fields)
        .setURL(profileUrl);

    if (entry.gameType === GAME_TYPES.TFT) {
        const thumbUrl = await getTftRegaliaThumbnailUrl({ queueType: entry.queueType, tier: entry.tier, });
        if (thumbUrl) embed.setThumbnail(thumbUrl ?? 'https://placehold.co/96x96/png?text=TFT');
    }

    return embed;
}

export default {
    data: new SlashCommandBuilder()
        .setName("rank")
        .setDescription("Show stored TFT/LoL ranked snapshots for a registered account")
        .addStringOption((opt) =>
            opt.setName('account').setDescription('Select a Riot ID').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((opt) => 
            opt
                .setName('game')
                .setDescription("Choose which game's rank snapshot to show")
                .setRequired(false)
                .addChoices(...TRACKING_GAME_CHOICES)
        ),
    
    async autocomplete(interaction) {
        await respondWithAccountChoices(interaction);
    },
    
    async execute(interaction) {
        // 1. Make sure command is run in server/guild only
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({ content: "This command can only be used inside a server (not DMs).", ephemeral: true, });
            return;
        }   

        // 2. Defer reply in case of Riot API delays
        await interaction.deferReply({ ephemeral: true });

        // 3. Determine selected account
        const key = interaction.options.getString('account', true);

        const db = await loadDb();
        const guild = db[guildId];
        const accountIdx = guild?.accounts?.findIndex((a) => a.key === key) ?? -1;
        const stored = accountIdx >= 0 ? normalizeAccountTracking(guild.accounts[accountIdx]) : null;

        if (!stored) {
            await interaction.editReply("The selected account is not registered in this server. Try registering again.");
            return;
        }

        const selectedGame = interaction.options.getString('game') ?? "BOTH";
        
        // 4. Pull out separate tracked rank snapshots for each game
        const tftTracking = getTftTracking(stored);
        const lolTracking = getLolTracking(stored);
        
        const rankByQueueByGameType = {
            [GAME_TYPES.TFT]: tftTracking.lastRankByQueue ?? {},
            [GAME_TYPES.LOL]: lolTracking.lastRankByQueue ?? {},
        };

        // 5. Build embed fields
        const embeds = [];

        for (const definition of QUEUE_DEFINITIONS) {
            if (!definition.enabledBySelectedGame(selectedGame)) continue;

            const lastRankByQueue = rankByQueueByGameType[definition.gameType];
            const entry = buildQueueEntry(lastRankByQueue, definition.queueType, definition.gameType);
            if (!entry) continue;
            embeds.push(
                await buildQueueEmbed({
                    account: stored,
                    label: queueLabelForGame(definition.gameType, definition.queueType),
                    entry,
                })
            );
        }
        // 6. If no ranked entries, show unranked message
        if (embeds.length === 0) {
            const gameSuffix = selectedGame === "BOTH" ? "" : ` ${selectedGame === "LOL" ? "LoL" : "TFT"}`;
            embeds.push(
                new EmbedBuilder()
                .setTitle(`${stored.gameName}#${stored.tagLine}'s${gameSuffix} Rank:`)
                .setDescription('Unranked')
            )
        }
        
        //7. Send reply with embeds (one main reply + up to 9 follow-ups if multiple queues)
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length && i < 10; i++) {
                await interaction.followUp({ embeds: [embeds[i]], ephemeral: true});
        }
    },
};
