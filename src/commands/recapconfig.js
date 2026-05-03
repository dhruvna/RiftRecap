// src/commands/recapconfig.js
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { loadDb, getGuildRecapConfigs, setGuildRecapConfigsInStore } from "../storage.js";
import {
  GAME_TYPES,
  GAME_TYPE_CHOICES,
  ALL_RECAP_QUEUE_CHOICES,
  defaultRankedQueueForGame,
  queueChoicesForRecap,
  queueLabel,
} from "../constants/queues.js";
import { RECAP_MODE_CHOICES, VALID_RECAP_MODES, formatRecapScheduleTime, modeLabel } from "../constants/recap.js";
import config from "../config.js";

function normalizeId(raw) {
  return (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function formatAllowedQueueChoices(game) {
  return queueChoicesForRecap(game)
    .map((choice) => `\`${choice.value}\` (${choice.name})`)
    .join(", ");
}

export default {
  data: new SlashCommandBuilder()
    .setName("recapconfig")
    .setDescription("Manage recap autopost configs or use `status:true` to view all configs.")
    .addBooleanOption((opt) => opt.setName("status").setDescription("Show current recap configs.").setRequired(false))
    .addStringOption((opt) => opt.setName("id").setDescription("Config id to edit/remove.").setRequired(false))
    .addIntegerOption((opt) => opt.setName("slot").setDescription("1-based config slot to edit/remove.").setRequired(false).setMinValue(1))
    .addBooleanOption((opt) => opt.setName("remove").setDescription("Remove selected config.").setRequired(false))
    .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable/disable selected config.").setRequired(false))
    .addStringOption((opt) => opt.setName("game").setDescription("Game for recap autopost").setRequired(false).addChoices(...GAME_TYPE_CHOICES))
    .addStringOption((opt) => opt.setName("mode").setDescription("Daily or weekly recap content").setRequired(false).addChoices(...RECAP_MODE_CHOICES))
    .addStringOption((opt) => opt.setName("queue").setDescription("Which queue to post").setRequired(false).addChoices(...ALL_RECAP_QUEUE_CHOICES))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });

    const wantsStatus = interaction.options.getBoolean("status") ?? false;
    const requestedId = normalizeId(interaction.options.getString("id"));
    const slot = interaction.options.getInteger("slot");
    const remove = interaction.options.getBoolean("remove") ?? false;
    const enabled = interaction.options.getBoolean("enabled");
    const game = interaction.options.getString("game");
    const mode = interaction.options.getString("mode") ?? null;
    const rawQueue = interaction.options.getString("queue");

    const db = await loadDb();
    let recapConfigs = [...getGuildRecapConfigs(db, guildId)];

    if (wantsStatus) {
      const scheduleText = formatRecapScheduleTime(config.recapAutopostHour, config.recapAutopostMinute);
      const lines = recapConfigs.map((cfg, index) =>
        `**${index + 1}. ${cfg.id}** • ${cfg.enabled ? "Enabled" : "Disabled"} • ${cfg.game === GAME_TYPES.LOL ? "LoL" : "TFT"} • ${queueLabel(cfg.game ?? GAME_TYPES.TFT, cfg.queue)} • ${modeLabel(cfg.mode)} • lastSent: ${cfg.lastSentYmd ?? "—"}`
      );
      return interaction.reply({
        content: `**Recap autopost status**\n• Time: **${scheduleText}**\n${lines.length ? lines.join("\n") : "No configs set."}`,
        ephemeral: true,
      });
    }

    if (mode !== null) {
      if (!VALID_RECAP_MODES.has(mode)) {
        await interaction.reply({
          content: `Invalid mode. Allowed values: ${[...VALID_RECAP_MODES].join(", ")}.`,
          ephemeral: true,
        });
        return;
      }
    }

    const targetIdxBySlot = Number.isInteger(slot) ? slot - 1 : -1;
    const targetIdxById = requestedId ? recapConfigs.findIndex((cfg) => cfg.id === requestedId) : -1;
    let targetIdx = targetIdxById >= 0 ? targetIdxById : targetIdxBySlot;

    const hasPatchField = enabled !== null || Boolean(game) || Boolean(mode) || Boolean(rawQueue);
    if (remove && targetIdx < 0) {
      return interaction.reply({ content: "Select a valid `id` or `slot` to remove a config.", ephemeral: true });
    }

    if (remove) {
      const [deleted] = recapConfigs.splice(targetIdx, 1);
      await setGuildRecapConfigsInStore(guildId, recapConfigs);
      return interaction.reply({ content: `🗑️ Removed recap config **${deleted.id}**.`, ephemeral: true });
    }

    if (!hasPatchField && targetIdx < 0) {
      return interaction.reply({ content: "Provide fields to update (`enabled/game/mode/queue`) and optional `id`/`slot` selector.", ephemeral: true });
    }

    if (targetIdx < 0) {
      const newId = requestedId || `cfg-${recapConfigs.length + 1}`;
      recapConfigs.push({ id: newId, enabled: false, game: GAME_TYPES.TFT, mode: "DAILY", queue: defaultRankedQueueForGame(GAME_TYPES.TFT), lastSentYmd: null });
      targetIdx = recapConfigs.length - 1;
    }

    const current = recapConfigs[targetIdx];
    const nextGame = game ?? current.game ?? GAME_TYPES.TFT;
    const validQueueTypes = new Set(queueChoicesForRecap(nextGame).map((choice) => choice.value));
    
    if (rawQueue && !validQueueTypes.has(rawQueue)) {
      return interaction.reply({
        content: `Invalid queue for ${nextGame === GAME_TYPES.LOL ? "LoL" : "TFT"}. Allowed values: ${formatAllowedQueueChoices(nextGame)}.`,
        ephemeral: true,
      });
    }

    const nextQueue = rawQueue ?? current.queue ?? defaultRankedQueueForGame(nextGame);

    recapConfigs[targetIdx] = {
      ...current,
      ...(requestedId ? { id: requestedId } : {}),
      ...(enabled !== null ? { enabled } : {}),
      ...(game ? { game } : {}),
      ...(mode ? { mode } : {}),
      ...(nextQueue ? { queue: nextQueue } : {}),
      ...(enabled === true ? { lastSentYmd: null } : {}),
    };

    recapConfigs = await setGuildRecapConfigsInStore(guildId, recapConfigs);
    const updated = recapConfigs[targetIdx];
    const scheduleText = formatRecapScheduleTime(config.recapAutopostHour, config.recapAutopostMinute);

    return interaction.reply({
      content: `✅ Saved recap config **${updated.id}**: ${updated.enabled ? "Enabled" : "Disabled"} • ${updated.game === GAME_TYPES.LOL ? "LoL" : "TFT"} / ${queueLabel(updated.game ?? GAME_TYPES.TFT, updated.queue)} • ${modeLabel(updated.mode)} • posts at **${scheduleText}**`,
      ephemeral: true,
    });
  },
};
