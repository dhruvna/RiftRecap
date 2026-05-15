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
import logger from './utils/logger.js';

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
        logger.warn('invalid_command_module', { service: 'startup', event: 'command_invalid', file });
    },
});

// Cache each command by name for fast lookups on interaction.
for (const command of commands) {
    client.commands.set(command.name, command);
}

// === Startup hook ===
// Once the client is connected, we log concise diagnostics and spin up background services.
const debugEnabled = logger.isLevelEnabled('debug');
/**
 * Bootstraps startup diagnostics and long-running services after Discord signals readiness.
 */
client.once('clientReady', async () => {
    logger.info('client_ready', { service: 'startup', event: 'client_ready', userTag: client.user.tag });

    try {
        const pruneResult = await pruneExpiredRecapEventsInStore();
        logger.info('recap_prune_complete', { service: 'startup', event: 'recap_prune_complete', didChange: pruneResult?.didChange ?? false, prunedEvents: pruneResult?.prunedEvents ?? 0, touchedAccounts: pruneResult?.touchedAccounts ?? 0 });
    } catch (e) {
        logger.error('recap_prune_failed', { service: 'startup', event: 'recap_prune_failed', error: e });
    }

    // Load the database and log concise startup summary.
    // Detailed guild payloads remain available behind debug logging.
    try {
        const db = await loadDb();
        const guildEntries = Object.entries(db);
        let totalAccounts = 0;
        let totalRankedSnapshots = 0;

        for (const [gid, g] of guildEntries) {
            const accounts = g?.accounts ?? [];
            const rankedSnapshots = accounts.filter((account) =>
                getRankSnapshotForQueue(account, TFT_QUEUE_TYPES.RANKED)?.tier).length;
            totalAccounts += accounts.length;
            totalRankedSnapshots += rankedSnapshots;

            if (debugEnabled) {
                logger.debug('guild_startup_snapshot', { service: 'startup', event: 'guild_startup_snapshot', guildId: gid, channelId: g?.channelId ?? null, accounts: accounts.length, rankedSnapshots, recapConfigs: g?.recapConfigs ?? [], tft: g?.tft ?? null });
            }
        }
        logger.info('startup_summary', { service: 'startup', event: 'startup_summary', guilds: guildEntries.length, totalAccounts, rankedSnapshots: totalRankedSnapshots });
    } catch (e) {
        logger.error('startup_db_read_failed', { service: 'startup', event: 'startup_db_read_failed', error: e });
    }

    // Start the background services that keep the bot up-to-date:
    // - match poller: periodic rank/match updates
    // - recap autoposter: scheduled recap messages
    startMatchPoller(client).catch((error) => {
        logger.error('match_poller_failed', { service: 'startup', event: 'match_poller_failed', error });
    });

    startRecapAutoposter(client).catch((error) => {
        logger.error('recap_autoposter_failed', { service: 'startup', event: 'recap_autoposter_failed', error });
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
            logger.error('interaction_autocomplete_failed', { service: 'discord', event: 'interaction_autocomplete_failed', error, guildId: interaction.guildId ?? null });
        }
        return;
    }
    // If the interaction is not a chat input command, ignore it.
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        // Catch command errors to keep the bot alive and respond gracefully.
        logger.error('interaction_execute_failed', { service: 'discord', event: 'interaction_execute_failed', error, guildId: interaction.guildId ?? null, commandName: interaction.commandName });
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
