import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { updateGuildChannelAndQueueConfigInStore } from "../storage.js";
import { DEFAULT_ANNOUNCE_QUEUES, LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from "../constants/queues.js";

const ANNOUNCE_QUEUE_PRESETS = Object.freeze({
    RANKED_TFT_AND_LOL: DEFAULT_ANNOUNCE_QUEUES,
    RANKED_TFT_ONLY: [
        TFT_QUEUE_TYPES.RANKED,
        TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
    ],
    RANKED_LOL_ONLY: [
        LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
        LOL_QUEUE_TYPES.RANKED_FLEX,
    ]
});

export default {
    data: new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Set the channel for match result announcements")
        .addChannelOption((opt) =>
            opt
                .setName("channel")
                .setDescription("Channel to post match tracking embeds in")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addStringOption((opt) =>
            opt
                .setName("queue_preset")
                .setDescription("Select which queues to announce")
                .setRequired(false)
                .addChoices(
                    { name: "Ranked TFT + Ranked LoL", value: "RANKED_TFT_AND_LOL" },
                    { name: "Ranked TFT only", value: "RANKED_TFT_ONLY" },
                    { name: "Ranked LoL only", value: "RANKED_LOL_ONLY" },
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({ 
                content: "This command can only be used in a server.", 
                ephemeral: true 
            });
        return;
        }

        const channel = interaction.options.getChannel("channel", true);
        if (!channel.isTextBased()) {
            await interaction.reply({ 
                content: "Please select a text-based channel.", 
                ephemeral: true 
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        
        const presetName = interaction.options.getString("queue_preset") ?? "RANKED_TFT_AND_LOL";
        const selectedQueues = ANNOUNCE_QUEUE_PRESETS[presetName] ?? DEFAULT_ANNOUNCE_QUEUES;
        const queueFilterLabel =
            presetName === "RANKED_TFT_ONLY"
                    ? "Ranked TFT only"
                    : presetName === "RANKED_LOL_ONLY"
                        ? "Ranked LoL only"
                        : "Ranked TFT + Ranked LoL";

        await updateGuildChannelAndQueueConfigInStore(guildId, {
            channelId: channel.id,
            queues: selectedQueues,
        });
        
        await interaction.editReply(
            `Match result announcements will be sent to ${channel}.\n` +
                `Queue filter: **${queueFilterLabel}**`
        );
    },
}