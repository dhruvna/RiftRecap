// === Environment bootstrap ===
// Load .env values into process.env early so all reads below are consistent.
import 'dotenv/config';

// === Configuration schema ===
// Documenting the config shape keeps the rest of the app self-describing.
/**
 * @typedef {Object} AppConfig
 * @property {string} discordBotToken
 * @property {string} discordClientId
 * @property {string} riotTftApiKey
 * @property {string} riotLolApiKey
 * @property {string} defaultRegion
 * @property {number} matchPollIntervalSeconds
 * @property {number} matchPollPerAccountDelayMs
 * @property {number} rankRefreshIntervalMinutes
 * @property {number} recapAutopostHour
 * @property {number} recapAutopostMinute
 * @property {string} lolPostMatchAnnouncementStrategy
 * @property {boolean} liveAnnounceRankedOnly
 */

// === Defaults and validation sets ===
// These constants centralize valid region values and fallback behavior.
const DEFAULT_REGION = 'NA';
const VALID_REGIONS = new Set([
    'NA',
    'EUW',
    'EUNE',
    'KR',
    'BR',
    'LAN',
    'LAS',
    'OCE',
    'JP',
    'RU',
    'TR',
    'VN',
    'SG',
    'PH',
    'TH',
    'TW',
]);

// === Environment helpers ===
// Small helpers give us consistent error messages and type conversions.
function readEnv(name) {
    return process.env[name];
}

function requireString(name) {
    const value = readEnv(name);
    if (!value) {
        throw new Error(`Environment variable ${name} is required`);
    }
    return value;
}

/**
 * Parses an integer env var with defaults and inclusive bounds so runtime knobs fail fast.
 */
function readInt(name, { defaultValue, min = -Infinity, max = Infinity }) {
    const raw = readEnv(name);
    if (raw === undefined || raw === '') {
        return defaultValue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Environment variable ${name} must be an integer`);
    }
    if (parsed < min || parsed > max) {
        throw new Error(
        `Environment variable ${name} must be between ${min} and ${max}, got ${parsed}`
        );
    }
    return parsed;
}

function readBool(name, { defaultValue = false } = {}) {
    const raw = readEnv(name);
    if (raw === undefined || raw === '') return defaultValue;
    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`Environment variable ${name} must be a boolean`);
}

/**
 * Normalizes DEFAULT_REGION and rejects unsupported values to keep downstream API routing predictable.
 */
function readRegion() {
    const raw = readEnv('DEFAULT_REGION') ?? DEFAULT_REGION;
    const normalized = String(raw).toUpperCase();
    if (!VALID_REGIONS.has(normalized)) {
    throw new Error(`Environment variable DEFAULT_REGION must be one of: ${[
        ...VALID_REGIONS,
    ].join(', ')}`);
    }
    return normalized;
}

function readLolPostMatchAnnouncementStrategy() {
    const raw = readEnv('LOL_POST_MATCH_ANNOUNCEMENT_STRATEGY') ?? 'edit';
    const normalized = String(raw).toLowerCase();
    const valid = new Set(['edit', 'delete_and_send']);
    if (!valid.has(normalized)) {
        throw new Error(`Environment variable LOL_POST_MATCH_ANNOUNCEMENT_STRATEGY must be one of: ${[...valid].join(', ')}`);
    }
    return normalized;
}

// === Final config ===
// Freeze the config so accidental mutations don't create confusing runtime bugs.
/** @type {AppConfig} */
export const config = Object.freeze({
    discordBotToken: requireString('DISCORD_BOT_TOKEN'),
    discordClientId: requireString('DISCORD_CLIENT_ID'),
    riotTftApiKey: requireString('RIOT_TFT_API_KEY'),
    riotLolApiKey: requireString('RIOT_LOL_API_KEY'),
    defaultRegion: readRegion(),
    matchPollIntervalSeconds: readInt('MATCH_POLL_INTERVAL_SECONDS', {
        defaultValue: 60,
        min: 10,
        max: 3600,
    }),
    matchPollPerAccountDelayMs: readInt('MATCH_POLL_PER_ACCOUNT_DELAY_MS', {
        defaultValue: 250,
        min: 0,             
        max: 10000,
    }),
    rankRefreshIntervalMinutes: readInt('RANK_REFRESH_INTERVAL_MINUTES', {
        defaultValue: 180,
        min: 5,
        max: 24 * 60,
    }),
    recapAutopostHour: readInt('RECAP_AUTOPOST_HOUR', {
        defaultValue: 9,
        min: 0,
        max: 23,
    }),
    recapAutopostMinute: readInt('RECAP_AUTOPOST_MINUTE', {
        defaultValue: 0,
        min: 0,
        max: 59,
    }),
    lolPostMatchAnnouncementStrategy: readLolPostMatchAnnouncementStrategy(),
    liveAnnounceRankedOnly: readBool('LIVE_ANNOUNCE_RANKED_ONLY', {
        defaultValue: true,
    }),

});

// Export a default for convenience so imports stay concise.
export default config;
