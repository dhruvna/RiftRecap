function normalizeErrorMessage(error) {
    const status = error?.status;
    if (status === 404) return "Couldn't find that Riot ID. Please double-check spelling and try again.";
    if (status === 401 || status === 403) return 'Riot API key/config issue. Please try again later.';
    if (status === 429) return 'Riot API rate limited, try again shortly.';
    return error?.userMessage ?? 'Something went wrong. Please try again shortly.';
}

export async function respondToCommandError(interaction, error, { commandName = 'command' } = {}) {
    const message = normalizeErrorMessage(error);
    console.error(`[${commandName}] command failed`, error);

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
        return;
    }

    await interaction.reply({ content: message, ephemeral: true });
}

export function withGuildCommand(handler, options = {}) {
    const {
        defer = false,
        ephemeral = true,
        commandName,
        onError,
    } = options;

    return async function wrappedGuildCommand(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used inside a server (not DMs).',
                ephemeral: true,
            });
            return;
        }

        try {
            if (defer) {
                await interaction.deferReply({ ephemeral });
            }
            await handler(interaction, { guildId });
        } catch (error) {
            if (typeof onError === 'function') {
                await onError(interaction, error);
                return;
            }
            await respondToCommandError(interaction, error, { commandName: commandName ?? interaction.commandName });
        }
    };
}
