// === Imports ===
// We rely on the filesystem to persist registrations and per-guild settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ANNOUNCE_QUEUES } from './constants/queues.js';
import {
    DEFAULT_RECAP_CONFIG_ID,
    TRACKED_GAMES,
    normalizeAccountTracking,
    normalizeIdentityNamespace,
    normalizeAccountIdentity,
    normalizeRecapConfig,
} from './storage/normalize.js';

// === File locations ===
// Use a default path in the repo while allowing overrides via env vars.
const DEFAULT_DATA_PATH = path.join(process.cwd(), 'user_data', 'registrations.json');
const DATA_PATH = process.env.DATA_PATH
    ? path.resolve(process.env.DATA_PATH)
    : path.join(process.env.DATA_DIR ?? path.dirname(DEFAULT_DATA_PATH), 'registrations.json');

/**
 * Storage module contract for guild data:
 * - Read helpers (`get*`, `list*`) return normalized views and do not mutate caller-owned objects.
 * - Update helpers (`update*InStore`) enqueue read-modify-write transactions and persist to disk.
 *
 * Guild operations cover accounts, channel/queue settings, recap configs, and TFT config.
 */
// I/O + mutation orchestration layer: file access, queueing, and store-level state transitions.
// Keep pure shape-normalization logic in ./storage/normalize.js.
// Serialize write operations so RMW cycles don't collide.
let writeQueue = Promise.resolve();
const DISCORD_SNOWFLAKE_REGEX = /^\d{17,20}$/;
const RECAP_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export { DEFAULT_RECAP_CONFIG_ID, TRACKED_GAMES, normalizeAccountTracking, normalizeIdentityNamespace, normalizeAccountIdentity, normalizeRecapConfig };

function enqueueWrite(operation) {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.then(() => undefined, () => undefined); // Prevent unhandled rejections from blocking the queue
    return run;
}

// === File initialization ===
// Ensure the data file exists so callers can assume read/write will work.
async function ensureDataFile() {
    const dir = path.dirname(DATA_PATH);

    // Ensure ./data directory exists
    await fs.mkdir(dir, { recursive: true });

    // Ensure registrations.json exists
    try {
        await fs.access(DATA_PATH);
    } catch {
        await fs.writeFile(DATA_PATH, '{}', 'utf8');
    }
}

async function writeDbAtomically(db) {
    await ensureDataFile();
    const tmp = `${DATA_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf-8');
    await fs.rename(tmp, DATA_PATH);
}

// === Database IO ===
// Read the JSON file into an object, falling back to an empty object on error.
function assertCanonicalGuildShape(guildId, guild) {
    const context = `[loadDb] Malformed guild record for ${guildId}:`;
    if (!guild || typeof guild !== 'object' || Array.isArray(guild)) throw new Error(`${context} expected object.`);
    if (!Array.isArray(guild.accounts)) throw new Error(`${context} accounts must be an array.`);
    if (!('channelId' in guild)) throw new Error(`${context} channelId is required.`);
    if (!Array.isArray(guild.announceQueues)) throw new Error(`${context} announceQueues must be an array.`);
    if (!guild.tft || typeof guild.tft !== 'object' || Array.isArray(guild.tft)) throw new Error(`${context} tft must be an object.`);
    if (!Array.isArray(guild.recapConfigs) || guild.recapConfigs.length === 0) throw new Error(`${context} recapConfigs must be a non-empty array.`);
    for (let idx = 0; idx < guild.accounts.length; idx += 1) {
        assertCanonicalAccountShape(guildId, guild.accounts[idx], idx);
    }
}

function assertCanonicalTrackingNamespace(guildId, accountIndex, gameKey, namespace) {
    const context = `[loadDb] Malformed guild record for ${guildId}: accounts[${accountIndex}].trackedGames.${gameKey}`;
    if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
        throw new Error(`${context} must be an object.`);
    }
    if (typeof namespace.enabled !== 'boolean') throw new Error(`${context}.enabled must be boolean.`);
    if (!(namespace.lastMatchId === null || typeof namespace.lastMatchId === 'string')) {
        throw new Error(`${context}.lastMatchId must be string|null.`);
    }
    if (!(namespace.lastMatchAt === null || Number.isFinite(namespace.lastMatchAt))) {
        throw new Error(`${context}.lastMatchAt must be number|null.`);
    }
    if (!namespace.lastRankByQueue || typeof namespace.lastRankByQueue !== 'object' || Array.isArray(namespace.lastRankByQueue)) {
        throw new Error(`${context}.lastRankByQueue must be an object.`);
    }
    if (!Array.isArray(namespace.recapEvents)) throw new Error(`${context}.recapEvents must be an array.`);
}

function assertCanonicalAccountShape(guildId, account, accountIndex) {
    const context = `[loadDb] Malformed guild record for ${guildId}: accounts[${accountIndex}]`;
    if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error(`${context} must be an object.`);
    if (typeof account.key !== 'string' || !account.key.trim()) throw new Error(`${context}.key must be a non-empty string.`);
    if (!account.identity || typeof account.identity !== 'object' || Array.isArray(account.identity)) {
        throw new Error(`${context}.identity must be an object.`);
    }
    if (!account.trackedGames || typeof account.trackedGames !== 'object' || Array.isArray(account.trackedGames)) {
        throw new Error(`${context}.trackedGames must be an object.`);
    }

    for (const gameKey of Object.values(TRACKED_GAMES)) {
        const identityNs = account.identity?.[gameKey];
        if (!identityNs || typeof identityNs !== 'object' || Array.isArray(identityNs)) {
            throw new Error(`${context}.identity.${gameKey} must be an object.`);
        }
        if (!(identityNs.puuid === null || typeof identityNs.puuid === 'string')) {
            throw new Error(`${context}.identity.${gameKey}.puuid must be string|null.`);
        }
        assertCanonicalTrackingNamespace(guildId, accountIndex, gameKey, account.trackedGames?.[gameKey]);
    }
}

/**
 * Canonical registrations.json schema (steady-state):
 * {
 *   [guildId: string]: {
 *     accounts: AccountTracking[],
 *     channelId: string | null,
 *     announceQueues: string[],
 *     tft: { seasonCutoffMs: number | null, ... },
 *     recapConfigs: RecapConfig[]
 *   }
 * }
 */

export async function loadDb() {
    await ensureDataFile();
    let parsed;
    try {
        const raw = await fs.readFile(DATA_PATH, 'utf-8');
        parsed = JSON.parse(raw);
    } catch (error) {
        console.error('[loadDb] Failed reading/parsing registrations.json', error);
        throw error;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[loadDb] registrations.json root must be an object keyed by guildId.');
    }

    for (const guildId of Object.keys(parsed)) {
        if (!isValidGuildId(guildId)) continue;
        assertCanonicalGuildShape(guildId, parsed[guildId]);
    }

    return parsed;
}

// Queue-backed read-modify-write transaction.
async function mutateDb(mutator) {
    return enqueueWrite(async () => {
        const db = await loadDb();
        const result = await mutator(db);
        const didChange = result?.didChange ?? true;
        if (didChange) {
            await writeDbAtomically(db);
        }
        return result;
    });
}

async function mutateGuild(guildId, mutator) {
    assertValidGuildId(guildId, 'mutateGuild');
    return mutateDb((db) => {
        const guild = ensureGuildMutable(db, guildId);
        return mutator({ db, guild });
    });
}

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

function ensureGuildMutable(db, guildId) {
    if (!db[guildId]) {
        db[guildId] = {
            accounts: [],
            channelId: null,
            announceQueues: [...DEFAULT_ANNOUNCE_QUEUES],
            tft: { seasonCutoffMs: null },
            recapConfigs: [normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID)],
        };
    }
    return db[guildId];
}

export function getTrackedGameIdentity(account, gameKey) {
    return account?.identity?.[gameKey] ?? {};
}

export function getTftIdentity(account) {
    return getTrackedGameIdentity(account, TRACKED_GAMES.TFT);
}

export function getLolIdentity(account) {
    return getTrackedGameIdentity(account, TRACKED_GAMES.LOL);
}

export function getTrackedGameState(account, gameKey) {
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

// === Account Creation, Read, Update, Deletion ===
export async function listGuildAccounts(guildId) {
    const db = await loadDb();
    const guild = db?.[guildId];
    return guild?.accounts ?? [];
}

async function upsertGuildAccount(db, guildId, account) {
    const guild = ensureGuildMutable(db, guildId);

    const idx = guild.accounts.findIndex((a) => a.key === account.key);
    const existed = idx >= 0;

    if (existed) guild.accounts[idx] = { ...guild.accounts[idx], ...account };
    else guild.accounts.push(account);

    return { account, existed };
}

export async function upsertGuildAccountInStore(guildId, account) {
    return mutateGuild(guildId, async ({ db }) => {
        const upserted = await upsertGuildAccount(db, guildId, account);
        return { ...upserted, didChange: true };
    });
}

export async function removeGuildAccountByKey(guildId, key) {
    return mutateGuild(guildId, ({ guild }) => {
        if (!guild?.accounts?.length) return { removed: null, didChange: false };
        const idx = guild.accounts.findIndex((a) => a.key === key);
        if (idx === -1) return { removed: null, didChange: false };
        const [removed] = guild.accounts.splice(idx, 1);
        return { removed, didChange: true };
    }).then((result) => result?.removed ?? null);
}

// === Guild-level settings ===
function updateGuildChannelInDb(db, guildId, channelId) {
    const g = ensureGuildMutable(db, guildId);
    g.channelId = channelId;
    return { channelId };
}

export function getGuildRecapConfigs(db, guildId) {
    return db[guildId].recapConfigs;
}

export function getGuildTftConfig(db, guildId) {
    return db[guildId].tft;
}

function updateGuildDefaultRecapConfigInDb(db, guildId, patch) {
    const g = ensureGuildMutable(db, guildId);
    const current = g.recapConfigs[0] ?? normalizeRecapConfig(null, DEFAULT_RECAP_CONFIG_ID);
    g.recapConfigs[0] = normalizeRecapConfig({ ...current, ...patch }, current.id);
    return g.recapConfigs[0];
}

export async function updateGuildRecapConfigsInStore(guildId, patch) {
    return mutateGuild(guildId, ({ db, guild }) => {
        if (Array.isArray(patch?.recapConfigs)) {
            guild.recapConfigs = patch.recapConfigs.map((cfg, idx) =>
                normalizeRecapConfig(cfg, idx === 0 ? DEFAULT_RECAP_CONFIG_ID : `cfg-${idx + 1}`)
            );
            return { didChange: true, recapConfigs: guild.recapConfigs };
        }
        const defaultPatch = patch?.defaultRecapPatch ?? patch ?? {};
        const recap = updateGuildDefaultRecapConfigInDb(db, guildId, defaultPatch);
        return { didChange: true, recapConfigs: [recap, ...guild.recapConfigs.slice(1)] };
    }).then((result) => result?.recapConfigs ?? []);
}

export async function updateGuildRecapLastSentYmdInStore(guildId, lastSentYmd) {
    return mutateGuild(guildId, ({ guild }) => {
        const current = guild?.recapConfigs?.[0]?.lastSentYmd ?? null;
        if (current === lastSentYmd) {
            return { didChange: false, updated: false };
        }
        guild.recapConfigs[0].lastSentYmd = lastSentYmd;
        return { didChange: true, updated: true };
    }).then((result) => result?.updated ?? false);
}

export async function updateGuildRecapLastSentYmdByIdInStore(guildId, configId, lastSentYmd, mode = null) {
    return mutateGuild(guildId, ({ guild }) => {
        const recapConfigs = Array.isArray(guild?.recapConfigs) ? guild.recapConfigs : [];
        const idx = recapConfigs.findIndex((cfg) => cfg?.id === configId);
        if (idx < 0) return { didChange: false, updated: false };
        const current = recapConfigs[idx]?.lastSentYmd ?? null;
        // Mode keys are stored uppercased; null/empty mode updates the default lastSentYmd field.
        const normalizedMode = typeof mode === 'string' ? mode.trim().toUpperCase() : null;
        if (!normalizedMode) {
            if (current === lastSentYmd) return { didChange: false, updated: false };
            recapConfigs[idx].lastSentYmd = lastSentYmd;
            return { didChange: true, updated: true };
        }

        const currentByMode = recapConfigs[idx]?.lastSentYmdByMode && typeof recapConfigs[idx].lastSentYmdByMode === 'object'
            ? recapConfigs[idx].lastSentYmdByMode
            : {};
        if (currentByMode[normalizedMode] === lastSentYmd) return { didChange: false, updated: false };

        recapConfigs[idx].lastSentYmdByMode = {
            ...currentByMode,
            [normalizedMode]: lastSentYmd,
        };
        return { didChange: true, updated: true };
    }).then((result) => result?.updated ?? false);
}

function isSameTftConfig(a, b) {
    const left = a && typeof a === 'object' ? a : {};
    const right = b && typeof b === 'object' ? b : {};

    return (left.seasonCutoffMs ?? null) === (right.seasonCutoffMs ?? null);
}

export async function updateGuildTftConfigInStore(guildId, patch) {
    return mutateGuild(guildId, ({ guild }) => {
        const current = guild?.tft && typeof guild.tft === 'object'
            ? guild.tft
            : { seasonCutoffMs: null };
        const nextCutoff = Number(patch?.seasonCutoffMs ?? 0);
        const normalizedPatch = {
            ...patch,
            seasonCutoffMs: Number.isFinite(nextCutoff) && nextCutoff > 0 ? nextCutoff : null,
        };
        const next = { ...current, ...normalizedPatch };

        if (isSameTftConfig(next, current)) {
            return { didChange: false, tft: current };
        }

        guild.tft = next;
        return { didChange: true, tft: next };
    }).then((result) => result?.tft ?? null);
}

function updateGuildQueueConfigInDb(db, guildId, queues) {
    const g = ensureGuildMutable(db, guildId);
    g.announceQueues = queues;
    return g.announceQueues;
}

export async function updateGuildChannelAndQueueConfigInStore(guildId, { channelId, queues }) {
    return mutateGuild(guildId, ({ db }) => {
        updateGuildChannelInDb(db, guildId, channelId);
        const announceQueues = updateGuildQueueConfigInDb(db, guildId, queues);
        return { didChange: true, channelId, announceQueues };
    });
}

export function getKnownGuildIds(db) {
    if (!db || typeof db !== 'object') return [];

    return Object.keys(db)
        .filter((guildId) => isValidGuildId(guildId));
}

export function pruneExpiredRecapEventsInDb(db, nowMs = Date.now()) {
    if (!db || typeof db !== 'object') {
        return {
            didChange: false,
            prunedEvents: 0,
            touchedAccounts: 0
        };        
    }

    const cutoffMs = nowMs - RECAP_EVENT_RETENTION_MS;
    let didChange = false;
    let prunedEvents = 0;
    let touchedAccounts = 0;

    for (const guildId of getKnownGuildIds(db)) {
        const guild = ensureGuildMutable(db, guildId);
        for (const account of guild.accounts) {
            const tftTracking = getTftTracking(account);
            const lolTracking = getLolTracking(account);
            let accountTouched = false;

            for (const tracking of [tftTracking, lolTracking]) {
                const recapEvents = Array.isArray(tracking?.recapEvents) ? tracking.recapEvents : [];
                if (recapEvents.length === 0) continue;
                const nextRecapEvents = recapEvents.filter((event) => Number(event?.at ?? 0) > cutoffMs);
                const removedCount = recapEvents.length - nextRecapEvents.length;
                if (removedCount <= 0) continue;

                tracking.recapEvents = nextRecapEvents;
                didChange = true;
                prunedEvents += removedCount;
                accountTouched = true;
            }
            if (accountTouched) touchedAccounts += 1;
        }
    }

    return { didChange, prunedEvents, touchedAccounts };
}

export async function pruneExpiredRecapEventsInStore(nowMs = Date.now()) {
    return mutateDb((db) => pruneExpiredRecapEventsInDb(db, nowMs));
}

export async function resetGuildAccountProgressInStore(guildId, options = {}) {
    return resetGuildAccountProgressBeforeInStore(guildId, null, options);
}

export async function resetGuildAccountProgressBeforeInStore(guildId, cutoffMs, options = {}) {
    const hasCutoff = Number.isFinite(cutoffMs) && cutoffMs > 0;
    const clearMatchCursor = options?.clearMatchCursor === true;
    const requestedScope = Array.isArray(options?.gameScope) ? options.gameScope : [];
    if (requestedScope.length === 0) {
        throw new Error("[resetGuildAccountProgressBeforeInStore] options.gameScope must be a non-empty array of tracked game keys.");
    }
    return mutateGuild(guildId, ({ guild }) => {
        const accounts = Array.isArray(guild?.accounts) ? guild.accounts : [];
        if (accounts.length === 0) {
            return { didChange: false, totalAccounts: 0, resetAccounts: 0 };
        }

        let resetAccounts = 0;
        let skippedAccounts = 0;

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

                const hadLastMatchId = Boolean(tracking?.lastMatchId);
                const hadRankSnapshot = 
                    tracking?.lastRankByQueue && Object.keys(tracking.lastRankByQueue).length > 0;
                const hadRecapEvents = Array.isArray(tracking?.recapEvents) && tracking.recapEvents.length > 0;
                const hadMatchCursor = Boolean(tracking?.lastMatchId) || Number(tracking?.lastMatchAt ?? 0) > 0;

                if (clearMatchCursor) {
                    tracking.lastMatchId = null;
                    tracking.lastMatchAt = null;
                }

                tracking.lastRankByQueue = {};
                tracking.recapEvents = [];

                if (hadLastMatchId || hadRankSnapshot || hadRecapEvents || (clearMatchCursor && hadMatchCursor)) {
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
