import { MessageFlags } from 'discord.js';

export function ephemeralResponseOptions(options = {}) {
    return {
        ...options,
        flags: MessageFlags.Ephemeral,
    };
}

export function maybeEphemeralResponseOptions(options = {}, ephemeral = true) {
    if (!ephemeral) return { ...options };
    return ephemeralResponseOptions(options);
}
