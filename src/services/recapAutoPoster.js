// === Imports ===
// The recap autoposter builds recap embeds and sends them on a schedule.
import { getKnownGuildIds, loadDb, setGuildRecapLastSentYmdByIdInStore } from '../storage.js';
import { GAME_TYPES, defaultRankedQueueForGame } from '../constants/queues.js';
import { hoursForMode } from '../constants/recap.js';
import { buildRecapEmbed, computeRecapRows } from '../utils/recap.js';
import config from "../config.js";

// === Date helpers ===
// Use local dates for daily scheduling (matching users' expectations).
export function getLocalYmd(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// Calculate cutoff timestamp for recap aggregation.
export function getRecapCutoffTimestamp({ now, hours}) {
    return now.getTime() - hours * 60 * 60 * 1000;
}

// === Scheduling logic ===
// Decide whether we should fire at the current time, accounting for last send.
export function shouldFireRecapAutopost({ 
    now,
    fireHour,
    fireMinute,
    lastSentYmd,
    getYmd = getLocalYmd,
}) {
    const today = getYmd(now);
    const scheduledTime = new Date(now);
    scheduledTime.setHours(fireHour, fireMinute, 0, 0);
    return {
        shouldFire: now >= scheduledTime && lastSentYmd !== today,
        today,
        scheduledTime,
    };
}

async function postRecapForConfig({
    channel,
    guild,
    guildId,
    recapConfig,
    now,
    today,
    fireHour,
    fireMinute,
}) {
    const game = recapConfig.game ?? GAME_TYPES.TFT;
    const mode = recapConfig.mode ?? 'DAILY';
    const queue = recapConfig.queue ?? defaultRankedQueueForGame(game);
    const lastSentYmd = recapConfig.lastSentYmd ?? null;
    const configId = recapConfig.id ?? 'default';

    const { shouldFire, scheduledTime } = shouldFireRecapAutopost({
        now,
        fireHour,
        fireMinute,
        lastSentYmd,
    });

    if (!shouldFire) return;

    console.log(
        `[recap-autopost] firing guild=${guildId} config=${configId} mode=${mode} game=${game} queue=${queue}`
    );

    const hours = hoursForMode(mode);
    const cutoff = getRecapCutoffTimestamp({ now, hours });
    const accounts = guild?.accounts ?? [];
    const rows = computeRecapRows(accounts, cutoff, queue, game);
    const embed = buildRecapEmbed({ rows, mode, game, queue, hours });

    await channel.send({ embeds: [embed] });
    const updated = await setGuildRecapLastSentYmdByIdInStore(guildId, configId, today);
    console.log(`[recap-autopost] sent guild=${guildId} config=${configId} mode=${mode} game=${game} queue=${queue} today=${today} stored=${updated}`);
}

// === Service entry point ===
// Polls on a configurable interval to see if a recap should be posted.
export async function startRecapAutoposter(client, { fireHour, fireMinute, pollIntervalMs } = {}) {
    const FIRE_HOUR = fireHour ?? config.recapAutopostHour;
    const FIRE_MINUTE = fireMinute ?? config.recapAutopostMinute;
    const POLL_INTERVAL_MS = pollIntervalMs ?? 5 * 60 * 1000;

    // One polling iteration. Splitting this out keeps the interval handler small.
    const tick = async () => {
        const db = await loadDb();
        const guildIds = getKnownGuildIds(db);
        if (guildIds.length === 0) return;

        const now = new Date();
        const today =  getLocalYmd(now);
        // const { today, scheduledTime } = shouldFireRecapAutopost({
        //     now,
        //     fireHour: FIRE_HOUR,
        //     fireMinute: FIRE_MINUTE,
        //     lastSentYmd: null,
        // });

        for (const guildId of guildIds) {
            const guild = db[guildId];
            const recapConfigs = Array.isArray(guild?.recapConfigs) ? guild.recapConfigs : (guild?.recap ? [guild.recap] : []);
            const enabledConfigs = recapConfigs.filter((cfg) => cfg?.enabled);
            if (enabledConfigs.length === 0) continue;

            const channelId = guild?.channelId;
            if (!channelId) continue;

            let channel = null;
            try {
                channel = await client.channels.fetch(channelId);
            } catch {
                channel = null;
            }

            if (!channel || !channel.isTextBased()) {
                console.log(
                    `[recap-autopost] skip guild=${guildId} (channel not found or not text-based) channelId=${channelId}`
                );
                continue;
            }

            for (const recapConfig of enabledConfigs) {
                await postRecapForConfig({
                    channel,
                    guild,
                    guildId,
                    recapConfig,
                    now,
                    today,
                    fireHour: FIRE_HOUR,
                    fireMinute: FIRE_MINUTE,
                });
            }
        }
    };

    // Run immediately and then continue polling; firing logic allows catch-up after fire minute.
    await tick();
    setInterval(() => tick().catch((e) => console.error("Recap autopost tick failed:", e)), POLL_INTERVAL_MS);
}
