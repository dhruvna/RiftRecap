// src/commands/recapconfig.js
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { loadDb, getGuildRecapConfigs, setGuildRecapConfigsInStore } from "../storage.js";
import {
  GAME_TYPES,
  ALL_RECAP_QUEUE_CHOICES,
  gameFromQueue,
  queueLabel,
} from "../constants/queues.js";
import {
  RECAP_MODE_CHOICES,
  formatRecapScheduleTime,
  invalidRecapModeMessage,
  modeLabel,
  parseRecapMode,
} from "../constants/recap.js";

import config from "../config.js";


export default {
  data: new SlashCommandBuilder()
    .setName("recapconfig")
    .setDescription("Manage recap autopost configs or use `status:true` to view all configs.")
    .addBooleanOption((opt) => opt.setName("status").setDescription("Show current recap configs.").setRequired(false))
    .addStringOption((opt) => opt.setName("mode").setDescription("Daily, weekly, or both recap content").setRequired(false).addChoices(...RECAP_MODE_CHOICES))
    .addStringOption((opt) => opt.setName("queue").setDescription("Which queue to post").setRequired(false).addChoices(...ALL_RECAP_QUEUE_CHOICES))
    .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable/disable recap autopost for queue+mode.").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });

    const wantsStatus = interaction.options.getBoolean("status") ?? false;
    const enabled = interaction.options.getBoolean("enabled");
    const rawMode = interaction.options.getString("mode");
    const mode = rawMode === null ? null : parseRecapMode(rawMode);
    const rawQueue = interaction.options.getString("queue");

    const db = await loadDb();
    let recapConfigs = [...getGuildRecapConfigs(db, guildId)];

    if (wantsStatus) {
      const scheduleText = formatRecapScheduleTime(config.recapAutopostHour, config.recapAutopostMinute);
      
      const lines = recapConfigs.map((cfg, index) => {
        const sentByMode = cfg?.lastSentYmdByMode && typeof cfg.lastSentYmdByMode === "object" ? cfg.lastSentYmdByMode : {};
        const sentText = cfg.mode === "BOTH"
          ? `daily ${sentByMode.DAILY ?? "—"}, weekly ${sentByMode.WEEKLY ?? "—"}`
          : (sentByMode[cfg.mode] ?? cfg.lastSentYmd ?? "—");
        return `**${index + 1}. ${cfg.id}** • ${cfg.enabled ? "Enabled" : "Disabled"} • ${cfg.game === GAME_TYPES.LOL ? "LoL" : "TFT"} • ${queueLabel(cfg.game ?? GAME_TYPES.TFT, cfg.queue)} • ${modeLabel(cfg.mode)} • lastSent: ${sentText}`;
      });

      // const lines = recapConfigs.map((cfg, index) =>
      //   `**${index + 1}.** ${cfg.enabled ? "Enabled" : "Disabled"} • ${cfg.game === GAME_TYPES.LOL ? "LoL" : "TFT"} • ${queueLabel(cfg.game ?? GAME_TYPES.TFT, cfg.queue)} • ${modeLabel(cfg.mode)} • lastSent: ${cfg.lastSentYmd ?? "—"}`
      // );
      
      return interaction.reply({
        content: `**Recap autopost status**\n• Time: **${scheduleText}**\n${lines.length ? lines.join("\n") : "No configs set."}`,
        ephemeral: true,
      });
    }

    const normalizedRawMode = rawMode === null ? null : String(rawMode).trim().toUpperCase();
    if (rawMode !== null && mode !== normalizedRawMode) {
      await interaction.reply({
        content: invalidRecapModeMessage(rawMode),
        ephemeral: true,
      });
      return;
    }

    if (!rawQueue || mode === null || enabled === null) {
      return interaction.reply({
        content: "When `status` is false, you must provide `queue`, `mode`, and `enabled`.",
        ephemeral: true,
      });
    }

    const targetGame = gameFromQueue(rawQueue);
    const targetIdx = recapConfigs.findIndex((cfg) => cfg?.queue === rawQueue && cfg?.mode === mode);
    const existing = targetIdx >= 0 ? recapConfigs[targetIdx] : null;

    const nextConfig = {
      ...(existing ?? {}),
      id: existing?.id ?? `recap-${mode.toLowerCase()}-${rawQueue.toLowerCase()}`,
      enabled,
      game: targetGame,
      mode,
      queue: rawQueue,
      ...(enabled ? { lastSentYmd: null } : { lastSentYmd: existing?.lastSentYmd ?? null }),
    };

    if (targetIdx >= 0) {
      recapConfigs[targetIdx] = nextConfig;
    } else {
      recapConfigs.push(nextConfig);
    }

    recapConfigs = await setGuildRecapConfigsInStore(guildId, recapConfigs);
    const updated = recapConfigs.find((cfg) => cfg?.queue === rawQueue && cfg?.mode === mode) ?? nextConfig;
    const scheduleText = formatRecapScheduleTime(config.recapAutopostHour, config.recapAutopostMinute);

    return interaction.reply({
      content: `✅ Saved recap config: ${updated.enabled ? "Enabled" : "Disabled"} • ${updated.game === GAME_TYPES.LOL ? "LoL" : "TFT"} / ${queueLabel(updated.game ?? GAME_TYPES.TFT, updated.queue)} • ${modeLabel(updated.mode)} • posts at **${scheduleText}**`,
      ephemeral: true,
    });
  },
};
