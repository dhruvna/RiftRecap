import { SlashCommandBuilder } from 'discord.js';
import { listGuildAccounts } from '../storage.js';

export default {
    data: new SlashCommandBuilder()
        .setName('list')
        .setDescription('Lists all registered Riot IDs in this server'),
    
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

        const accounts = await listGuildAccounts(guildId);
        if (accounts.length === 0) {
            await interaction.editReply('No Riot IDs are registered in this server.');
            return;
        }

        const lines = accounts
            .map((a) => `- **${a.gameName}#${a.tagLine}** (${a.region})`)
            .join('\n');
        
        await interaction.editReply(`Registered accounts in this server:\n${lines}`);
    },
};
