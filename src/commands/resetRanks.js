import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GAME_TYPES, GAME_TYPE_CHOICES } from '../constants/queues.js';
import {
    TRACKED_GAMES,
    resetGuildAccountProgressBeforeInStore,
    resetGuildAccountProgressInStore,
    updateGuildTftConfigInStore,
} from '../storage.js';

function parseCutoffDateOrNull(input) {
    if (!input) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return NaN;

    const asUtcMidnight = Date.parse(`${input}T00:00:00.000Z`);
    if (!Number.isFinite(asUtcMidnight)) return NaN;
    const normalized = new Date(asUtcMidnight).toISOString().slice(0, 10);
    if (normalized !== input) return NaN;
    return asUtcMidnight;
}

function normalizeResetGameScope(selectedGame) {
    if (selectedGame === 'BOTH') return [TRACKED_GAMES.TFT, TRACKED_GAMES.LOL];
    if (selectedGame === GAME_TYPES.LOL) return [TRACKED_GAMES.LOL];
    return [TRACKED_GAMES.TFT];
}

export default {
    data: new SlashCommandBuilder()
        .setName('resetranks')
        .setDescription('Reset tracking progress for this server (TFT, LoL, or both). Optionally, set a cutoff date.')
        .addBooleanOption((opt) =>
            opt
                .setName('confirm')
                .setDescription('Confirm the reset action.')
                .setRequired(true)
        )
        .addStringOption((opt) =>
            opt
                .setName('game')
                .setDescription('Game scope to reset. Defaults to TFT when omitted.')
                .setRequired(false)
                .addChoices(...GAME_TYPE_CHOICES, { name: 'Both', value: 'BOTH' })
        )
        .addStringOption((opt) =>
            opt
                .setName('before_date')
                .setDescription('Optional UTC cutoff date. Resets accounts with last match before this date.')
                .setRequired(false)
        )
        .addBooleanOption((opt) =>
            opt
                .setName('clear_match_cursor')
                .setDescription('Also clear lastMatchId/lastMatchAt. Usually keep this false to prevent re-processing old matches.')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used within a server.',
                ephemeral: true,
            });
            return;
        }

        const confirm = interaction.options.getBoolean('confirm', true);
        if (!confirm) {
        await interaction.reply({
            content: 'Reset cancelled. Re-run with `confirm:true` to perform the reset.',
            ephemeral: true,
        });
        return;
        }

        const selectedGame = interaction.options.getString('game') ?? GAME_TYPES.TFT;
        const gameScope = normalizeResetGameScope(selectedGame);
        const beforeDate = interaction.options.getString('before_date');
        const cutoffMs = parseCutoffDateOrNull(beforeDate);
        const clearMatchCursor = interaction.options.getBoolean('clear_match_cursor') ?? false;
        if (Number.isNaN(cutoffMs)) {
            await interaction.reply({
                content: 'Invalid `before_date`. Use `YYYY-MM-DD` format, for example `2026-04-01`.',
                ephemeral: true,
            });
            return;
        }

        const result = beforeDate
            ? await resetGuildAccountProgressBeforeInStore(guildId, cutoffMs, { clearMatchCursor, gameScope })
            : clearMatchCursor
                ? await resetGuildAccountProgressBeforeInStore(guildId, null, { clearMatchCursor: true, gameScope })
                : await resetGuildAccountProgressInStore(guildId, { gameScope });

        if (beforeDate) {
            await updateGuildTftConfigInStore(guildId, { seasonCutoffMs: cutoffMs });
        }

        if ((result?.totalAccounts ?? 0) === 0) {
            await interaction.reply({
                content: 'No registered accounts were found for this server.',
                ephemeral: true,
            });
            return;
        }

        await interaction.reply({
            content:
                `Reset complete for this server${beforeDate ? ` (cutoff: **${beforeDate} 00:00:00 UTC**)` : ''}.\n` +
                `• Accounts registered: **${result.totalAccounts}**\n` +
                `• Accounts with progress cleared: **${result.resetAccounts}**\n` +
                `• Game scope: **${selectedGame === 'BOTH' ? 'TFT + LoL' : (selectedGame === GAME_TYPES.LOL ? 'LoL' : 'TFT')}**\n\n` +
                `${beforeDate ? `• Accounts skipped (recent match on/after cutoff): **${result.skippedAccounts ?? 0}**\n\n` : ''}` +
                `${beforeDate ? `Saved guild TFT season cutoff to **${beforeDate} 00:00:00 UTC** for future polling.\n` : ''}` +
                'Cleared each selected game\'s \'lastRankByQueue\' and \'recapEvents\'' +
                `${clearMatchCursor ? ", plus 'lastMatchId' and 'lastMatchAt'." : ". (Kept 'lastMatchId' and 'lastMatchAt' to avoid replaying old matches.)"}`,
            ephemeral: true,
        });
    },
};
