import { SlashCommandBuilder } from 'discord.js';

import { removeGuildAccountByKey } from '../storage.js';
import { respondWithAccountChoices } from '../utils/autocomplete.js';

export default {
    data: new SlashCommandBuilder()
        .setName('unregister')
        .setDescription('Unregister a Riot ID from this server')
        .addStringOption((opt) =>
            opt
                .setName('account')
                .setDescription('Select a registered Riot ID to unregister')
                .setRequired(true)
                .setAutocomplete(true)
        ),
    
    async autocomplete(interaction) {
        try {
            await respondWithAccountChoices(interaction);
        } catch (err) {
            console.error('Error during unregister autocomplete:', err);
            return interaction.respond([]);
        }        
    },
    
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used inside a server (not DMs).',
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const key = interaction.options.getString('account', true);

        const removed = await removeGuildAccountByKey(guildId, key);

        if (!removed) {
            await interaction.editReply('The selected Riot ID is not registered in this server. It may have already been removed.');
            return;
        }

        await interaction.editReply(
            `Successfully unregistered **${removed.gameName}#${removed.tagLine}** from this server.`
        );
    },
};
