#!/usr/bin/env node
import { migrateLegacyRegistrationsJsonToSqlite } from '../storage.js';

function parseArgs(argv) {
    const options = { force: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--force') {
            options.force = true;
            continue;
        }
        if (arg === '--source') {
            options.sourcePath = argv[index + 1];
            index += 1;
            continue;
        }
        if (arg.startsWith('--source=')) {
            options.sourcePath = arg.slice('--source='.length);
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

try {
    const result = await migrateLegacyRegistrationsJsonToSqlite(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
}
