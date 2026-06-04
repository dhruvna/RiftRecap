// === Imports ===
// This script registers slash commands with Discord. We keep it separate from
// the bot runtime so command registration can be run on demand.
import { REST, Routes } from 'discord.js';
import config from './config.js';
import { loadCommands } from './commands/loadCommands.js';
import { loadDb, getKnownGuildIds } from './storage.js';

// === Configuration ===
// Pull required values from config once so we can validate early.
const token = config.discordBotToken;
const clientId = config.discordClientId;

// === Command discovery ===
const loadedCommands = await loadCommands({
    onInvalid(file) {
        console.warn(`Skipping ${file}: missing default export with { data, execute }`);
    },
});
const commands = loadedCommands.map((command) => {
    console.log(`Loaded command: ${command.data.name}`);
    return command.data.toJSON();
});


// === Registration ===
// Register globally so commands work in every guild the bot joins.
const rest = new REST({ version: '10' }).setToken(token);

console.log('Registering slash commands (global)...');
await rest.put(Routes.applicationCommands(clientId), { body: commands });
console.log('Global slash command registration complete.');

const db = await loadDb();
const guildIds = getKnownGuildIds(db);

if (!guildIds.length) {
    console.log('No guild IDs found in storage; skipping guild override cleanup.');
} else {
    console.log(`Clearing guild-scoped command overrides in ${guildIds.length} known guild(s)...`);

    for (const guildId of guildIds) {
        try {
            await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
            console.log(`Cleared guild override commands for guild ${guildId}.`);
        } catch (error) {
            console.warn(`Failed to clear guild override commands for guild ${guildId}.`, error);
        }
    }
    console.log('Guild override cleanup complete.');
}
