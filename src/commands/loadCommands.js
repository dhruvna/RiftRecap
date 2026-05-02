import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// Determine the file-system location of this module. We need this to resolve
// the commands folder relative to this file, regardless of how the app is run.
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const commandsPath = __dirname;

function isValidCommand(command) {
    if (!command?.data || typeof command.execute !== 'function') {
        return false;
    }

    if (
        command.autocomplete !== undefined
        && typeof command.autocomplete !== 'function'
    ) {
        return false;
    }
    return true;
}

export async function loadCommands({ onInvalid } = {}) {
    // Collect command JSON payloads by reading the commands directory.
    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter((file) => file.endsWith('.js') && file !== 'loadCommands.js')
        .sort((a, b) => a.localeCompare(b));
    
    const commands = [];

    // For each command file, import it and add it to the commands collection.
    // This keeps new command modules discoverable without manual registration.
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const module = await import(url.pathToFileURL(filePath));
        const command = module.default;

        // Validate shape: commands must expose `data` (for Discord) and `execute`.
        if (!isValidCommand(command)) {
            if (typeof onInvalid === 'function') {
                onInvalid(file);
            }
            continue;
        }
        // Discord expects JSON data, so serialize the builder object.
        commands.push({
            file,
            name: command.data.name,
            data: command.data,
            execute: command.execute,
            autocomplete: command.autocomplete,
        });
    }
    return commands;
}
