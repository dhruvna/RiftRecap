// === Imports: runtime dependencies and internal helpers ===
// We group imports up front so the rest of the file reads as a narrative:
// 1) framework primitives, 2) Node utilities, 3) local services/helpers.
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { loadDb, pruneExpiredRecapEventsInStore } from './storage.js';
import { startRecapAutoposter } from './services/recapAutoPoster.js';
import { startMatchPoller } from './services/matchPoller.js';
import config from './config.js';
import { TFT_QUEUE_TYPES } from './constants/queues.js';
import { getRankSnapshotForQueue } from './utils/rankSnapshot.js';
import { loadCommands } from './commands/loadCommands.js';

// === Configuration ===
// Grab the token once so the login call is simple and we avoid reading config
// from multiple places.
const token = config.discordBotToken;

// === Discord client setup ===
// We scope intents to Guilds to minimize permissions while still supporting
// slash commands and interactions.
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// === Command discovery ===
// Store commands in a collection for quick lookup by name at runtime.
client.commands = new Collection();

// Discover and import commands from `src/commands`. Invalid command modules are
// warned and skipped so the bot can continue starting up.
const commands = await loadCommands({
    onInvalid(file) {
        console.warn(` Command ${file} is missing data or execute()`);
    },
});

// Cache each command by name for fast lookups on interaction.
for (const command of commands) {
    client.commands.set(command.name, command);
}

// === Startup hook ===
// Once the client is connected, we log diagnostics and spin up background services.
/**
 * Bootstraps startup diagnostics and long-running services after Discord signals readiness.
 */
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        const pruneResult = await pruneExpiredRecapEventsInStore();
        console.log(
            `[startup] recap prune didChange=${pruneResult?.didChange ?? false} prunedEvents=${pruneResult?.prunedEvents ?? 0} touchedAccounts=${pruneResult?.touchedAccounts ?? 0}`
        );
    } catch (e) {
        console.error('[startup] failed pruning recap events:', e);
    }

    // Load the database and log some info about each guild for debugging.
    // This gives visibility into accounts, snapshot coverage, and recap config.
    try {
        const db = await loadDb();
        for (const [gid, g] of Object.entries(db)) {
            const accounts = g?.accounts ?? [];
            const rankedSnapshots = accounts.filter((account) =>
                getRankSnapshotForQueue(account, TFT_QUEUE_TYPES.RANKED)?.tier).length;
            console.log(
                `[startup] guild=${gid} channelId=${g?.channelId ?? "null"} accounts=${accounts.length} rankedSnapshots=${rankedSnapshots} recapConfigs=${JSON.stringify(
                        g?.recapConfigs ?? []
                    )} tft=${JSON.stringify(g?.tft ?? null)}`
                );
        }
    } catch (e) {
        console.error("[startup] failed reading db:", e);
    }

    // Start the background services that keep the bot up-to-date:
    // - match poller: periodic rank/match updates
    // - recap autoposter: scheduled recap messages
    startMatchPoller(client).catch((error) => {
        console.error('[startup] match poller failed:', error);
    });

    startRecapAutoposter(client).catch((error) => {
        console.error('[startup] recap autoposter failed:', error);
    });
});

// === Interaction routing ===
// All Discord interactions funnel through here. We separate autocomplete from
// chat commands, then dispatch to the appropriate command handler.
/**
 * Routes Discord interactions to autocomplete or slash-command handlers.
 */
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command?.autocomplete) return;
        try {
            await command.autocomplete(interaction);
        } catch (error) {
            console.error(error);
        }
        return;
    }
    // If the interaction is not a chat input command, ignore it.
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if(!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        // Catch command errors to keep the bot alive and respond gracefully.
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: 'Something wrong',
                ephemeral: true,
            });
        } else {
            await interaction.reply({
                content: 'Something wrong',
                ephemeral: true,
            });
        }
    }
});

// === Connect ===
// Perform the actual login once all handlers are attached.
client.login(token);
