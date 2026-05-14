import { SlashCommandBuilder } from 'discord.js';
import { listGuildAccounts } from '../storage.js';
import { withGuildCommand } from '../utils/withGuildCommand.js';

export default {
    data: new SlashCommandBuilder()
        .setName('list')
        .setDescription('Lists all registered Riot IDs in this server'),
    
    execute: withGuildCommand(async (interaction, { guildId }) => {
        const accounts = await listGuildAccounts(guildId);
        if (accounts.length === 0) {
            await interaction.editReply('No Riot IDs are registered in this server.');
            return;
        }

        const lines = accounts
            .map((a) => `- **${a.gameName}#${a.tagLine}** (${a.region})`)
            .join('\n');
        
        await interaction.editReply(`Registered accounts in this server:\n${lines}`);
    }, { defer: true, ephemeral: true, commandName: 'list' }),
};
