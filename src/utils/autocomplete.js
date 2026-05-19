// === Imports ===
// Autocomplete needs access to per-guild accounts stored on disk.
import { listGuildAccounts } from '../storage.js';

// === Autocomplete helper ===
// Provide account choices that match the user's typed query.
export async function respondWithAccountChoices(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.respond([]);

    // Discord provides the current focused value; use it to filter results.
    const focused = interaction.options.getFocused() ?? '';
    const q = focused.toLowerCase();

    const accounts = await listGuildAccounts(guildId);

    // Filter by name or region so typing any part of either works.
    const filtered = 
        q.length === 0
            ? accounts
            : accounts.filter(a => {
                const name = `${a.gameName}#${a.tagLine}`.toLowerCase();
                const region = String(a.region ?? '').toLowerCase();
                return name.includes(q) || region.includes(q);
            });

    // Limit to Discord's max autocomplete choice count.
    await interaction.respond(
        filtered.slice(0, 25).map(a => ({
            name: `${a.gameName}#${a.tagLine} (${a.region})`,
            value: a.key,
        }))
    );
}
