// === Imports ===

import { DEFAULT_ANNOUNCE_QUEUES, GAME_TYPES } from './constants/queues.js';
import { getSqliteDb, withSqliteTransaction } from './storage/sqlite.js';
import {
    DEFAULT_RECAP_CONFIG_ID,
    TRACKED_GAMES,
    normalizeRecapConfig,
} from './storage/normalize.js';

/**
 * SQLite-backed storage module contract for guild data:
 * - Read helpers (`get*`, `list*`) return normalized views and do not mutate caller-owned objects.
 * - Update helpers (`update*InStore`) execute SQLite transactions and preserve the public API used by commands/services.
 *
 * `loadDb()` intentionally returns the legacy object-shaped view so existing callers can keep using selectors such as
 * `getKnownGuildIds(db)`, `getGuildLolConfig(db, guildId)`, and `getGuildRecapConfigs(db, guildId)`.
 */

const DISCORD_SNOWFLAKE_REGEX = /^\d{17,20}$/;
const RECAP_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export { TRACKED_GAMES };

function isValidGuildId(guildId) {
    return typeof guildId === 'string' && DISCORD_SNOWFLAKE_REGEX.test(guildId);
}

function assertValidGuildId(guildId, context = 'storage') {
    if (!isValidGuildId(guildId)) {
        throw new Error(
            `[${context}] Invalid guildId "${String(guildId)}". Expected a Discord snowflake string (17-20 digits).`
        );
    }
}

function boolToInt(value) {
    return value ? 1 : 0;
}

function intToBool(value) {
    return Number(value) === 1;
}

function jsonStringify(value, fallback) {
    return JSON.stringify(value ?? fallback);
}

function jsonParse(value, fallback) {
    if (typeof value !== 'string' || value.length === 0) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeGuildSeasonConfig(config) {
    const cutoff = Number(config?.seasonCutoffMs ?? 0);
    return {
        ...(config && typeof config === 'object' ? config : {}),
        seasonCutoffMs: Number.isFinite(cutoff) && cutoff > 0 ? cutoff : null,
    };
}

function defaultTrackingState() {
    return {
        enabled: false,
        lastMatchId: null,
        lastMatchAt: null,
        lastRankByQueue: {},
        recapEvents: [],
    };
}

function pickNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function pickPositiveNumber(value) {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeOptionalPrimitive(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value.trim() ? value : null;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    return null;
}

function normalizeTrackingState(state) {
    const safe = state && typeof state === 'object' ? state : {};
    const lastMatchAt = Number(safe.lastMatchAt ?? 0);
    return {
        enabled: Boolean(safe.enabled),
        lastMatchId: typeof safe.lastMatchId === 'string' && safe.lastMatchId.trim() ? safe.lastMatchId : null,
        lastMatchAt: Number.isFinite(lastMatchAt) && lastMatchAt > 0 ? lastMatchAt : null,
        lastRankByQueue: safe.lastRankByQueue && typeof safe.lastRankByQueue === 'object' && !Array.isArray(safe.lastRankByQueue)
            ? safe.lastRankByQueue
            : {},
        recapEvents: Array.isArray(safe.recapEvents) ? safe.recapEvents : [],
        inGame: safe.inGame === true,
        lastSpectatorCheckAt: pickPositiveNumber(safe.lastSpectatorCheckAt),
        activeGameId: normalizeOptionalPrimitive(safe.activeGameId),
        activeQueueId: normalizeOptionalPrimitive(safe.activeQueueId),
        activeGameStartTime: pickPositiveNumber(safe.activeGameStartTime),
        lastAnnouncedInGameKey: pickNonEmptyString(safe.lastAnnouncedInGameKey),
        lastAnnouncedActiveGameId: normalizeOptionalPrimitive(safe.lastAnnouncedActiveGameId),
        lastInGameAnnouncementAt: pickPositiveNumber(safe.lastInGameAnnouncementAt),
        liveAnnouncementMessageId: pickNonEmptyString(safe.liveAnnouncementMessageId),
        liveAnnouncementChannelId: pickNonEmptyString(safe.liveAnnouncementChannelId),
        liveAnnouncementGameKey: pickNonEmptyString(safe.liveAnnouncementGameKey),
    };
}

function makeEmptyGuild() {
    return {
        accounts: [],
        channelId: null,
        announceQueues: [...DEFAULT_ANNOUNCE_QUEUES],
        tft: { seasonCutoffMs: null },
        lol: { seasonCutoffMs: null },
        recapConfigs: [normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID)],
    };
}

function ensureGuildInView(db, guildId) {
    if (!db[guildId]) db[guildId] = makeEmptyGuild();
    return db[guildId];
}

function ensureGuildRow(sqliteDb, guildId) {
    const result = sqliteDb.prepare('INSERT OR IGNORE INTO guilds (guild_id, channel_id) VALUES (?, NULL)').run(guildId);
    if (Number(result?.changes ?? 0) === 0) return;

    const insertQueue = sqliteDb.prepare(`
        INSERT OR IGNORE INTO guild_announce_queues (guild_id, queue_type)
        VALUES (?, ?)
    `);
    for (const queueType of DEFAULT_ANNOUNCE_QUEUES) {
        insertQueue.run(guildId, queueType);
    }

    const insertGameConfig = sqliteDb.prepare(`
        INSERT OR IGNORE INTO guild_game_config (guild_id, game_key, season_cutoff_ms)
        VALUES (?, ?, NULL)
    `);
    for (const gameKey of Object.values(TRACKED_GAMES)) {
        insertGameConfig.run(guildId, gameKey);
    }

    upsertRecapConfigRow(sqliteDb, guildId, normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID));
}

function rowToRecapConfig(row, fallbackId = DEFAULT_RECAP_CONFIG_ID) {
    return normalizeRecapConfig({
        id: row?.config_id,
        enabled: intToBool(row?.enabled),
        mode: row?.mode,
        game: row?.game,
        queue: row?.queue,
        lastSentYmdByMode: jsonParse(row?.last_sent_ymd_by_mode, {}),
    }, fallbackId);
}

function upsertRecapConfigRow(sqliteDb, guildId, config) {
    const normalized = normalizeRecapConfig(config, config?.id ?? DEFAULT_RECAP_CONFIG_ID);
    sqliteDb.prepare(`
        INSERT INTO guild_recap_configs (
            guild_id, config_id, enabled, mode, game, queue, last_sent_ymd_by_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, config_id) DO UPDATE SET
            enabled = excluded.enabled,
            mode = excluded.mode,
            game = excluded.game,
            queue = excluded.queue,
            last_sent_ymd_by_mode = excluded.last_sent_ymd_by_mode
    `).run(
        guildId,
        normalized.id,
        boolToInt(normalized.enabled),
        normalized.mode,
        normalized.game,
        normalized.queue,
        jsonStringify(normalized.lastSentYmdByMode, {})
    );
    return normalized;
}

function mergeAccountForUpsert(previous, account, key) {
    if (!previous) return { ...account, key };
    const safeAccount = account && typeof account === 'object' ? account : {};
    return {
        ...previous,
        ...safeAccount,
        key,
        identity: {
            ...(previous.identity ?? {}),
            ...(safeAccount.identity ?? {}),
        },
        trackedGames: {
            ...(previous.trackedGames ?? {}),
            ...(safeAccount.trackedGames ?? {}),
        },
        notifications: {
            ...(previous.notifications ?? {}),
            ...(safeAccount.notifications ?? {}),
        },
    };
}

function accountFromRows(accountRow, identityRows, trackingRows, notificationRow) {
    const account = {
        key: accountRow.account_key,
        gameName: accountRow.game_name,
        tagLine: accountRow.tag_line,
        region: accountRow.region,
        platform: accountRow.platform,
        regional: accountRow.regional,
        identity: {},
        trackedGames: {},
        notifications: {
            lolAnnouncements: notificationRow ? intToBool(notificationRow.lol_announcements) : true,
            tftAnnouncements: notificationRow ? intToBool(notificationRow.tft_announcements) : true,
        },
    };

    for (const gameKey of Object.values(TRACKED_GAMES)) {
        const identityRow = identityRows.find((row) => row.game_key === gameKey);
        const trackingRow = trackingRows.find((row) => row.game_key === gameKey);
        account.identity[gameKey] = { puuid: identityRow?.puuid ?? null };
        account.trackedGames[gameKey] = trackingRow
            ? normalizeTrackingState({
                enabled: intToBool(trackingRow.enabled),
                lastMatchId: trackingRow.last_match_id,
                lastMatchAt: trackingRow.last_match_at,
                lastRankByQueue: jsonParse(trackingRow.last_rank_by_queue, {}),
                recapEvents: jsonParse(trackingRow.recap_events, []),
                inGame: intToBool(trackingRow.in_game),
                lastSpectatorCheckAt: trackingRow.last_spectator_check_at,
                activeGameId: trackingRow.active_game_id,
                activeQueueId: trackingRow.active_queue_id,
                activeGameStartTime: trackingRow.active_game_start_time,
                lastAnnouncedInGameKey: trackingRow.last_announced_in_game_key,
                lastAnnouncedActiveGameId: trackingRow.last_announced_active_game_id,
                lastInGameAnnouncementAt: trackingRow.last_in_game_announcement_at,
                liveAnnouncementMessageId: trackingRow.live_announcement_message_id,
                liveAnnouncementChannelId: trackingRow.live_announcement_channel_id,
                liveAnnouncementGameKey: trackingRow.live_announcement_game_key,
            })
            : defaultTrackingState();
    }

    return account;
}

function getAccountFromDb(sqliteDb, guildId, accountKey) {
    const accountRow = sqliteDb.prepare(`
        SELECT guild_id, account_key, game_name, tag_line, region, platform, regional
        FROM accounts
        WHERE guild_id = ? AND account_key = ?
    `).get(guildId, accountKey);
    if (!accountRow) return null;

    const identityRows = sqliteDb.prepare(`
        SELECT game_key, puuid
        FROM account_game_identity
        WHERE guild_id = ? AND account_key = ?
    `).all(guildId, accountKey);
    const trackingRows = sqliteDb.prepare(`
        SELECT
            game_key, enabled, last_match_id, last_match_at, last_rank_by_queue, recap_events,
            in_game, last_spectator_check_at, active_game_id, active_queue_id, active_game_start_time,
            last_announced_in_game_key, last_announced_active_game_id, last_in_game_announcement_at,
            live_announcement_message_id, live_announcement_channel_id, live_announcement_game_key
        FROM account_game_tracking
        WHERE guild_id = ? AND account_key = ?
    `).all(guildId, accountKey);
    const notificationRow = sqliteDb.prepare(`
        SELECT lol_announcements, tft_announcements
        FROM account_notifications
        WHERE guild_id = ? AND account_key = ?
    `).get(guildId, accountKey);

    return accountFromRows(accountRow, identityRows, trackingRows, notificationRow);
}

function groupRowsByAccountKey(rows) {
    const rowsByAccountKey = new Map();
    for (const row of rows) {
        if (!rowsByAccountKey.has(row.account_key)) rowsByAccountKey.set(row.account_key, []);
        rowsByAccountKey.get(row.account_key).push(row);
    }
    return rowsByAccountKey;
}

function listGuildAccountsFromRows(accountRows, identityRows, trackingRows, notificationRows) {
    const identityRowsByAccountKey = groupRowsByAccountKey(identityRows);
    const trackingRowsByAccountKey = groupRowsByAccountKey(trackingRows);
    const notificationRowsByAccountKey = new Map(notificationRows.map((row) => [row.account_key, row]));

    return accountRows.map((accountRow) => accountFromRows(
        accountRow,
        identityRowsByAccountKey.get(accountRow.account_key) ?? [],
        trackingRowsByAccountKey.get(accountRow.account_key) ?? [],
        notificationRowsByAccountKey.get(accountRow.account_key) ?? null
    ));
}

function listGuildAccountsFromDb(sqliteDb, guildId) {
    const accountRows = sqliteDb.prepare(`
        SELECT guild_id, account_key, game_name, tag_line, region, platform, regional
        FROM accounts
        WHERE guild_id = ?
        ORDER BY account_key
    `).all(guildId);
    const identityRows = sqliteDb.prepare(`
        SELECT account_key, game_key, puuid
        FROM account_game_identity
        WHERE guild_id = ?
    `).all(guildId);
    const trackingRows = sqliteDb.prepare(`
        SELECT
            account_key, game_key, enabled, last_match_id, last_match_at, last_rank_by_queue, recap_events,
            in_game, last_spectator_check_at, active_game_id, active_queue_id, active_game_start_time,
            last_announced_in_game_key, last_announced_active_game_id, last_in_game_announcement_at,
            live_announcement_message_id, live_announcement_channel_id, live_announcement_game_key
        FROM account_game_tracking
        WHERE guild_id = ?
    `).all(guildId);
    const notificationRows = sqliteDb.prepare(`
        SELECT account_key, lol_announcements, tft_announcements
        FROM account_notifications
        WHERE guild_id = ?
    `).all(guildId);

    return listGuildAccountsFromRows(accountRows, identityRows, trackingRows, notificationRows);
}

function upsertGuildAccount(sqliteDb, guildId, account) {
    ensureGuildRow(sqliteDb, guildId);

    const key = account?.key ?? makeAccountKey(account ?? {});
    const existed = Boolean(sqliteDb.prepare(`
        SELECT 1 FROM accounts WHERE guild_id = ? AND account_key = ?
    `).get(guildId, key));
    const previous = existed ? getAccountFromDb(sqliteDb, guildId, key) : null;
    const merged = mergeAccountForUpsert(previous, account, key);

    sqliteDb.prepare(`
        INSERT INTO accounts (guild_id, account_key, game_name, tag_line, region, platform, regional)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, account_key) DO UPDATE SET
            game_name = excluded.game_name,
            tag_line = excluded.tag_line,
            region = excluded.region,
            platform = excluded.platform,
            regional = excluded.regional
    `).run(
        guildId,
        key,
        merged.gameName ?? null,
        merged.tagLine ?? null,
        merged.region ?? null,
        merged.platform ?? null,
        merged.regional ?? null
    );

    const upsertIdentity = sqliteDb.prepare(`
        INSERT INTO account_game_identity (guild_id, account_key, game_key, puuid)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, account_key, game_key) DO UPDATE SET
            puuid = excluded.puuid
    `);
    const upsertTracking = sqliteDb.prepare(`
        INSERT INTO account_game_tracking (
            guild_id, account_key, game_key, enabled, last_match_id, last_match_at, last_rank_by_queue, recap_events,
            in_game, last_spectator_check_at, active_game_id, active_queue_id, active_game_start_time,
            last_announced_in_game_key, last_announced_active_game_id, last_in_game_announcement_at,
            live_announcement_message_id, live_announcement_channel_id, live_announcement_game_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, account_key, game_key) DO UPDATE SET
            enabled = excluded.enabled,
            last_match_id = excluded.last_match_id,
            last_match_at = excluded.last_match_at,
            last_rank_by_queue = excluded.last_rank_by_queue,
            recap_events = excluded.recap_events,
            in_game = excluded.in_game,
            last_spectator_check_at = excluded.last_spectator_check_at,
            active_game_id = excluded.active_game_id,
            active_queue_id = excluded.active_queue_id,
            active_game_start_time = excluded.active_game_start_time,
            last_announced_in_game_key = excluded.last_announced_in_game_key,
            last_announced_active_game_id = excluded.last_announced_active_game_id,
            last_in_game_announcement_at = excluded.last_in_game_announcement_at,
            live_announcement_message_id = excluded.live_announcement_message_id,
            live_announcement_channel_id = excluded.live_announcement_channel_id,
            live_announcement_game_key = excluded.live_announcement_game_key
    `);

    for (const gameKey of Object.values(TRACKED_GAMES)) {
        const identity = merged.identity?.[gameKey] ?? {};
        const tracking = normalizeTrackingState(merged.trackedGames?.[gameKey]);
        upsertIdentity.run(guildId, key, gameKey, identity.puuid ?? null);
        upsertTracking.run(
            guildId,
            key,
            gameKey,
            boolToInt(tracking.enabled),
            tracking.lastMatchId,
            tracking.lastMatchAt,
            jsonStringify(tracking.lastRankByQueue, {}),
            jsonStringify(tracking.recapEvents, []),
            boolToInt(tracking.inGame),
            tracking.lastSpectatorCheckAt,
            tracking.activeGameId,
            tracking.activeQueueId,
            tracking.activeGameStartTime,
            tracking.lastAnnouncedInGameKey,
            tracking.lastAnnouncedActiveGameId,
            tracking.lastInGameAnnouncementAt,
            tracking.liveAnnouncementMessageId,
            tracking.liveAnnouncementChannelId,
            tracking.liveAnnouncementGameKey
        );
    }
    const notifications = merged.notifications && typeof merged.notifications === 'object' ? merged.notifications : {};
    sqliteDb.prepare(`
        INSERT INTO account_notifications (guild_id, account_key, lol_announcements, tft_announcements)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, account_key) DO UPDATE SET
            lol_announcements = excluded.lol_announcements,
            tft_announcements = excluded.tft_announcements
    `).run(
        guildId,
        key,
        boolToInt(notifications.lolAnnouncements !== false),
        boolToInt(notifications.tftAnnouncements !== false)
    );

    return { account: getAccountFromDb(sqliteDb, guildId, key), existed };
}

export async function loadDb() {
    const sqliteDb = await getSqliteDb();
    const db = {};

    for (const row of sqliteDb.prepare('SELECT guild_id, channel_id FROM guilds ORDER BY guild_id').all()) {
        const guild = ensureGuildInView(db, row.guild_id);
        guild.channelId = row.channel_id ?? null;
        guild.announceQueues = [];
        guild.recapConfigs = [];
    }
    for (const row of sqliteDb.prepare('SELECT guild_id, queue_type FROM guild_announce_queues ORDER BY guild_id, queue_type').all()) {
        ensureGuildInView(db, row.guild_id).announceQueues.push(row.queue_type);
    }

    for (const row of sqliteDb.prepare('SELECT guild_id, game_key, season_cutoff_ms FROM guild_game_config ORDER BY guild_id, game_key').all()) {
        const guild = ensureGuildInView(db, row.guild_id);
        guild[row.game_key] = normalizeGuildSeasonConfig({ seasonCutoffMs: row.season_cutoff_ms });
    }

    for (const row of sqliteDb.prepare(`
        SELECT guild_id, config_id, enabled, mode, game, queue, last_sent_ymd_by_mode
        FROM guild_recap_configs
        ORDER BY guild_id, CASE WHEN config_id = ? THEN 0 ELSE 1 END, config_id
    `).all(DEFAULT_RECAP_CONFIG_ID)) {
        const guild = ensureGuildInView(db, row.guild_id);
        guild.recapConfigs.push(rowToRecapConfig(row, row.config_id));
    }

    for (const guild of Object.values(db)) {
        if (guild.recapConfigs.length === 0) guild.recapConfigs = [normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID)];
    }

    for (const row of sqliteDb.prepare('SELECT DISTINCT guild_id FROM accounts ORDER BY guild_id').all()) {
        ensureGuildInView(db, row.guild_id).accounts = listGuildAccountsFromDb(sqliteDb, row.guild_id);
    }

    return db;
}

function getTrackedGameIdentity(account, gameKey) {
    return account?.identity?.[gameKey] ?? {};
}

export function getTftIdentity(account) {
    return getTrackedGameIdentity(account, TRACKED_GAMES.TFT);
}

export function getLolIdentity(account) {
    return getTrackedGameIdentity(account, TRACKED_GAMES.LOL);
}

function getTrackedGameState(account, gameKey) {
    return account?.trackedGames?.[gameKey] ?? {};
}

export function getTftTracking(account) {
    return getTrackedGameState(account, TRACKED_GAMES.TFT);
}

export function getLolTracking(account) {
    return getTrackedGameState(account, TRACKED_GAMES.LOL);
}

// Build a stable key used to deduplicate accounts.
export function makeAccountKey({ gameName, tagLine, platform }) {
    return `${gameName}#${tagLine}@${platform}`.toLowerCase();
}

export async function getGuildAccountByKey(guildId, key) {
    assertValidGuildId(guildId, 'getGuildAccountByKey');
    const sqliteDb = await getSqliteDb();
    return getAccountFromDb(sqliteDb, guildId, key);
}

// === Account Creation, Read, Update, Deletion ===
export async function listGuildAccounts(guildId) {
    assertValidGuildId(guildId, 'listGuildAccounts');
    const sqliteDb = await getSqliteDb();
    return listGuildAccountsFromDb(sqliteDb, guildId);
}

export async function upsertGuildAccountInStore(guildId, account) {
    assertValidGuildId(guildId, 'upsertGuildAccountInStore');
    return withSqliteTransaction((sqliteDb) => {
        const upserted = upsertGuildAccount(sqliteDb, guildId, account);
        return { ...upserted, didChange: true };
    });
}

export async function updateGuildAccountNotificationsInStore(guildId, key, notifications) {
    assertValidGuildId(guildId, 'updateGuildAccountNotificationsInStore');
    return withSqliteTransaction((sqliteDb) => {
        const account = getAccountFromDb(sqliteDb, guildId, key);
        if (!account) return null;
        const nextNotifications = {
            ...(account.notifications ?? {}),
            ...(notifications && typeof notifications === 'object' ? notifications : {}),
        };
        sqliteDb.prepare(`
            INSERT INTO account_notifications (guild_id, account_key, lol_announcements, tft_announcements)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, account_key) DO UPDATE SET
                lol_announcements = excluded.lol_announcements,
                tft_announcements = excluded.tft_announcements
        `).run(
            guildId,
            key,
            boolToInt(nextNotifications.lolAnnouncements !== false),
            boolToInt(nextNotifications.tftAnnouncements !== false)
        );
        return getAccountFromDb(sqliteDb, guildId, key);
    });
}

export async function removeGuildAccountByKey(guildId, key) {
    assertValidGuildId(guildId, 'removeGuildAccountByKey');
    return withSqliteTransaction((sqliteDb) => {
        const removed = getAccountFromDb(sqliteDb, guildId, key);
        if (!removed) return null;
        sqliteDb.prepare('DELETE FROM accounts WHERE guild_id = ? AND account_key = ?').run(guildId, key);
        return removed;
    });
}

// === Guild-level settings ===
export function getGuildRecapConfigs(db, guildId) {
    const recapConfigs = db?.[guildId]?.recapConfigs;
    if (!Array.isArray(recapConfigs) || recapConfigs.length === 0) {
        return [normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID)];
    }
    return recapConfigs;
}

export function getGuildTftConfig(db, guildId) {
    return normalizeGuildSeasonConfig(db?.[guildId]?.tft);
}

export function getGuildLolConfig(db, guildId) {
    return normalizeGuildSeasonConfig(db?.[guildId]?.lol);
}

export async function updateGuildRecapConfigsInStore(guildId, patch) {
    assertValidGuildId(guildId, 'updateGuildRecapConfigsInStore');
    return withSqliteTransaction((sqliteDb) => {
        ensureGuildRow(sqliteDb, guildId);
        if (Array.isArray(patch?.recapConfigs)) {
            sqliteDb.prepare('DELETE FROM guild_recap_configs WHERE guild_id = ?').run(guildId);
            const recapConfigs = patch.recapConfigs.map((cfg, idx) =>
                normalizeRecapConfig(cfg, idx === 0 ? DEFAULT_RECAP_CONFIG_ID : `cfg-${idx + 1}`)
            );
            for (const recapConfig of recapConfigs) upsertRecapConfigRow(sqliteDb, guildId, recapConfig);
            return recapConfigs;
        }

        const currentRow = sqliteDb.prepare(`
            SELECT config_id, enabled, mode, game, queue, last_sent_ymd_by_mode
            FROM guild_recap_configs
            WHERE guild_id = ? AND config_id = ?
        `).get(guildId, DEFAULT_RECAP_CONFIG_ID);
        const current = currentRow ? rowToRecapConfig(currentRow) : normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID);

        const defaultPatch = patch?.defaultRecapPatch ?? patch ?? {};
        const recap = upsertRecapConfigRow(sqliteDb, guildId, { ...current, ...defaultPatch, id: current.id });
        const otherRows = sqliteDb.prepare(`
            SELECT config_id, enabled, mode, game, queue, last_sent_ymd_by_mode
            FROM guild_recap_configs
            WHERE guild_id = ? AND config_id <> ?
            ORDER BY config_id
        `).all(guildId, DEFAULT_RECAP_CONFIG_ID);
        return [recap, ...otherRows.map((row) => rowToRecapConfig(row, row.config_id))];
    });
}

export async function updateGuildRecapLastSentYmdByIdInStore(guildId, configId, lastSentYmd, mode) {
    assertValidGuildId(guildId, 'updateGuildRecapLastSentYmdByIdInStore');
    const normalizedMode = typeof mode === 'string' ? mode.trim().toUpperCase() : '';
    if (!normalizedMode) throw new Error('[updateGuildRecapLastSentYmdByIdInStore] mode is required.');

    return withSqliteTransaction((sqliteDb) => {
        ensureGuildRow(sqliteDb, guildId);
        const row = sqliteDb.prepare(`
            SELECT config_id, enabled, mode, game, queue, last_sent_ymd_by_mode
            FROM guild_recap_configs
            WHERE guild_id = ? AND config_id = ?
        `).get(guildId, configId);
        if (!row) return false;

        const current = rowToRecapConfig(row, configId);
        const currentByMode = current.lastSentYmdByMode && typeof current.lastSentYmdByMode === 'object'
            ? current.lastSentYmdByMode
            : {};
        if (currentByMode[normalizedMode] === lastSentYmd) return false;

        upsertRecapConfigRow(sqliteDb, guildId, {
            ...current,
            lastSentYmdByMode: {
                ...currentByMode,
                [normalizedMode]: lastSentYmd,
            },
        });
        return true;
    });
}

function isSameSeasonConfig(a, b) {
    const left = a && typeof a === 'object' ? a : {};
    const right = b && typeof b === 'object' ? b : {};

    return (left.seasonCutoffMs ?? null) === (right.seasonCutoffMs ?? null);
}

async function updateGuildSeasonConfigInStore(guildId, guildKey, patch) {
    assertValidGuildId(guildId, 'updateGuildSeasonConfigInStore');
    return withSqliteTransaction((sqliteDb) => {
        ensureGuildRow(sqliteDb, guildId);
        const row = sqliteDb.prepare(`
            SELECT season_cutoff_ms
            FROM guild_game_config
            WHERE guild_id = ? AND game_key = ?
        `).get(guildId, guildKey);
        const current = normalizeGuildSeasonConfig({ seasonCutoffMs: row?.season_cutoff_ms });
        const nextCutoff = Number(patch?.seasonCutoffMs ?? 0);
        const normalizedPatch = {
            ...patch,
            seasonCutoffMs: Number.isFinite(nextCutoff) && nextCutoff > 0 ? nextCutoff : null,
        };
        const next = normalizeGuildSeasonConfig({ ...current, ...normalizedPatch });

        if (!isSameSeasonConfig(next, current)) {
            sqliteDb.prepare(`
                INSERT INTO guild_game_config (guild_id, game_key, season_cutoff_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(guild_id, game_key) DO UPDATE SET
                    season_cutoff_ms = excluded.season_cutoff_ms
            `).run(guildId, guildKey, next.seasonCutoffMs);
        }
        return next;
    });
}

async function updateGuildTftConfigInStore(guildId, patch) {
    return updateGuildSeasonConfigInStore(guildId, TRACKED_GAMES.TFT, patch);
}

async function updateGuildLolConfigInStore(guildId, patch) {
    return updateGuildSeasonConfigInStore(guildId, TRACKED_GAMES.LOL, patch);
}

export async function updateGuildGameConfigInStore(guildId, gameType, patch) {
    return gameType === GAME_TYPES.LOL
        ? updateGuildLolConfigInStore(guildId, patch)
        : updateGuildTftConfigInStore(guildId, patch);
}

export async function updateGuildChannelAndQueueConfigInStore(guildId, { channelId, queues }) {
    assertValidGuildId(guildId, 'updateGuildChannelAndQueueConfigInStore');
    return withSqliteTransaction((sqliteDb) => {
        ensureGuildRow(sqliteDb, guildId);
        sqliteDb.prepare('UPDATE guilds SET channel_id = ? WHERE guild_id = ?').run(channelId ?? null, guildId);
        sqliteDb.prepare('DELETE FROM guild_announce_queues WHERE guild_id = ?').run(guildId);
        const insertQueue = sqliteDb.prepare(`
            INSERT INTO guild_announce_queues (guild_id, queue_type)
            VALUES (?, ?)
        `);
        for (const queueType of queues ?? []) {
            insertQueue.run(guildId, queueType);
        }
        return { didChange: true, channelId: channelId ?? null, announceQueues: queues ?? [] };
    });
}

export function getKnownGuildIds(db) {
    if (!db || typeof db !== 'object') return [];

    return Object.keys(db)
        .filter((guildId) => isValidGuildId(guildId));
}

function pruneExpiredRecapEventsForGuild(sqliteDb, guildId, nowMs = Date.now()) {
    const cutoffMs = nowMs - RECAP_EVENT_RETENTION_MS;
    let didChange = false;
    let prunedEvents = 0;
    const touchedAccounts = new Set();

    const rows = sqliteDb.prepare(`
        SELECT guild_id, account_key, game_key, enabled, last_match_id, last_match_at, last_rank_by_queue, recap_events
        FROM account_game_tracking
        WHERE guild_id = ?
    `).all(guildId);
    const updateTracking = sqliteDb.prepare(`
        UPDATE account_game_tracking
        SET recap_events = ?
        WHERE guild_id = ? AND account_key = ? AND game_key = ?
    `);

    for (const row of rows) {
        const recapEvents = jsonParse(row.recap_events, []);
        if (!Array.isArray(recapEvents) || recapEvents.length === 0) continue;
        const nextRecapEvents = recapEvents.filter((event) => Number(event?.at ?? 0) > cutoffMs);
        const removedCount = recapEvents.length - nextRecapEvents.length;
        if (removedCount <= 0) continue;

        updateTracking.run(jsonStringify(nextRecapEvents, []), row.guild_id, row.account_key, row.game_key);
        didChange = true;
        prunedEvents += removedCount;
        touchedAccounts.add(row.account_key);
    }
    return { didChange, prunedEvents, touchedAccounts: touchedAccounts.size };
}

export async function pruneExpiredRecapEventsInStore(nowMs = Date.now()) {
    return withSqliteTransaction((sqliteDb) => {
        let didChange = false;
        let prunedEvents = 0;
        let touchedAccounts = 0;

        const rows = sqliteDb.prepare('SELECT guild_id FROM guilds').all();
        for (const row of rows) {
            const result = pruneExpiredRecapEventsForGuild(sqliteDb, row.guild_id, nowMs);
            didChange = didChange || result.didChange;
            prunedEvents += result.prunedEvents;
            touchedAccounts += result.touchedAccounts;
        }

        return { didChange, prunedEvents, touchedAccounts };
    });
}

export async function resetGuildAccountProgressInStore(guildId, options = {}) {
    return resetGuildAccountProgressBeforeInStore(guildId, null, options);
}

export async function resetGuildAccountProgressBeforeInStore(guildId, cutoffMs, options = {}) {
    assertValidGuildId(guildId, 'resetGuildAccountProgressBeforeInStore');
    const hasCutoff = Number.isFinite(cutoffMs) && cutoffMs > 0;
    const clearMatchCursor = options?.clearMatchCursor === true;
    const requestedScope = Array.isArray(options?.gameScope) ? options.gameScope : [];
    if (requestedScope.length === 0) {
        throw new Error('[resetGuildAccountProgressBeforeInStore] options.gameScope must be a non-empty array of tracked game keys.');
    }
    return withSqliteTransaction((sqliteDb) => {
        const accounts = listGuildAccountsFromDb(sqliteDb, guildId);
        if (accounts.length === 0) {
            return { didChange: false, totalAccounts: 0, resetAccounts: 0 };
        }

        let resetAccounts = 0;
        let skippedAccounts = 0;
        const updateTracking = sqliteDb.prepare(`
            UPDATE account_game_tracking
            SET last_match_id = ?, last_match_at = ?, last_rank_by_queue = ?, recap_events = ?
            WHERE guild_id = ? AND account_key = ? AND game_key = ?
        `);

        for (const account of accounts) {
            let accountReset = false;
            let accountSkippedByCutoff = false;

            for (const gameKey of requestedScope) {
                const tracking = gameKey === TRACKED_GAMES.LOL ? getLolTracking(account) : getTftTracking(account);
                const lastMatchAt = Number(tracking?.lastMatchAt ?? 0);
                const shouldResetForCutoff =
                    !hasCutoff ||
                    !Number.isFinite(lastMatchAt) ||
                    lastMatchAt <= 0 ||
                    lastMatchAt < cutoffMs;
                if (!shouldResetForCutoff) {
                    accountSkippedByCutoff = true;
                    continue;
                }

                const hadRankSnapshot =
                    tracking?.lastRankByQueue && Object.keys(tracking.lastRankByQueue).length > 0;
                const hadRecapEvents = Array.isArray(tracking?.recapEvents) && tracking.recapEvents.length > 0;
                const hadMatchCursor = Boolean(tracking?.lastMatchId) || Number(tracking?.lastMatchAt ?? 0) > 0;

                const nextLastMatchId = clearMatchCursor ? null : tracking.lastMatchId;
                const nextLastMatchAt = clearMatchCursor ? null : tracking.lastMatchAt;
                updateTracking.run(
                    nextLastMatchId,
                    nextLastMatchAt,
                    jsonStringify({}, {}),
                    jsonStringify([], []),
                    guildId,
                    account.key,
                    gameKey
                );

                if (hadRankSnapshot || hadRecapEvents || (clearMatchCursor && hadMatchCursor)) {
                    accountReset = true;
                }
            }
            if (accountSkippedByCutoff && !accountReset) skippedAccounts += 1;
            if (accountReset) resetAccounts += 1;
        }

        return {
            didChange: resetAccounts > 0,
            totalAccounts: accounts.length,
            resetAccounts,
            skippedAccounts,
            cutoffMs: hasCutoff ? cutoffMs : null,
            clearMatchCursor,
        };
    });
}
