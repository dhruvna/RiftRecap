// Shape-normalization layer: pure helpers for coercing storage payloads into stable in-memory shapes.
// Keep this module side-effect free (no file I/O, no mutation queue, no env reads).

export const TRACKED_GAMES = {
    TFT: 'tft',
    LOL: 'lol',
};

export const DEFAULT_RECAP_CONFIG_ID = 'default';

export function normalizeRecapConfig(config, fallbackId = DEFAULT_RECAP_CONFIG_ID) {
    const safe = config && typeof config === 'object' ? config : {};
    const rawByMode =
        safe.lastSentYmdByMode && typeof safe.lastSentYmdByMode === 'object'
            ? safe.lastSentYmdByMode
            : {};

    return {
        id: typeof safe.id === 'string' && safe.id.trim() ? safe.id : fallbackId,
        enabled: Boolean(safe.enabled),
        mode: safe.mode ?? 'DAILY',
        game: safe.game ?? 'TFT',
        queue: safe.queue ?? 'RANKED_TFT',
        lastSentYmdByMode: rawByMode,
    };
}
