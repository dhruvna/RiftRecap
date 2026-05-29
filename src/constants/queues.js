// Single source of truth for queue IDs, labels, ranked sets, and Riot queue-type mapping.
// Keep queue identifiers scoped by game so semantics stay explicit.

export const GAME_TYPES = Object.freeze({
    TFT: 'TFT',
    LOL: 'LOL',
});

export const TRACKING_GAME_CHOICES = Object.freeze([
    { name: 'TFT', value: 'TFT' },
    { name: 'LoL', value: 'LOL' },
    { name: 'Both', value: 'BOTH' },
]);

export const TFT_QUEUE_TYPES = Object.freeze({
    RANKED: 'RANKED_TFT',
    RANKED_DOUBLE_UP: 'RANKED_TFT_DOUBLE_UP',
    UNKNOWN: 'UNKNOWN_TFT',
});

export const LOL_QUEUE_TYPES = Object.freeze({
    RANKED_SOLO_DUO: 'RANKED_SOLO_DUO',
    RANKED_FLEX: 'RANKED_FLEX',
    UNKNOWN: 'UNKNOWN_LOL',
});

const LOL_QUEUE_TYPE_SET = new Set(Object.values(LOL_QUEUE_TYPES));

export const GAME_TYPE_CHOICES = Object.freeze([
    { name: 'TFT', value: GAME_TYPES.TFT },
    { name: 'LoL', value: GAME_TYPES.LOL },
]);

const QUEUE_ID_TO_QUEUE_TYPE = Object.freeze({
    1100: TFT_QUEUE_TYPES.RANKED,
    1160: TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
    420: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
    440: LOL_QUEUE_TYPES.RANKED_FLEX,
});

const LOL_RIOT_QUEUE_TYPE_TO_BOT_QUEUE_TYPE = Object.freeze({
    RANKED_SOLO_5x5: LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
    RANKED_FLEX_SR: LOL_QUEUE_TYPES.RANKED_FLEX,
});

const QUEUE_LABELS_BY_GAME = Object.freeze({
    [GAME_TYPES.TFT]: Object.freeze({
        [TFT_QUEUE_TYPES.RANKED]: 'Ranked TFT',
        [TFT_QUEUE_TYPES.RANKED_DOUBLE_UP]: 'Double Up TFT',
        [TFT_QUEUE_TYPES.UNKNOWN]: 'Unknown',
    }),
    [GAME_TYPES.LOL]: Object.freeze({
        [LOL_QUEUE_TYPES.RANKED_SOLO_DUO]: 'Ranked Solo/Duo',
        [LOL_QUEUE_TYPES.RANKED_FLEX]: 'Ranked Flex',
        [LOL_QUEUE_TYPES.UNKNOWN]: 'Unknown',
    }),
});

export const RANKED_QUEUES_BY_GAME = Object.freeze({
    [GAME_TYPES.TFT]: new Set([
        TFT_QUEUE_TYPES.RANKED,
        TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
    ]),
    [GAME_TYPES.LOL]: new Set([
        LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
        LOL_QUEUE_TYPES.RANKED_FLEX,
    ]),
});

// Default queues to announce when a user has not customized their settings.
export const DEFAULT_ANNOUNCE_QUEUES = [
    TFT_QUEUE_TYPES.RANKED,
    TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
    LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
    LOL_QUEUE_TYPES.RANKED_FLEX,
];

const TFT_QUEUE_CHOICES = Object.freeze([
    { name: 'Ranked TFT', value: TFT_QUEUE_TYPES.RANKED },
    { name: 'Double Up TFT', value: TFT_QUEUE_TYPES.RANKED_DOUBLE_UP },
]);

const LOL_QUEUE_CHOICES = Object.freeze([
    { name: 'LoL Ranked Solo/Duo', value: LOL_QUEUE_TYPES.RANKED_SOLO_DUO },
    { name: 'LoL Ranked Flex', value: LOL_QUEUE_TYPES.RANKED_FLEX },
]);

export const ALL_QUEUE_CHOICES = Object.freeze([
    ...TFT_QUEUE_CHOICES,
    ...LOL_QUEUE_CHOICES,
]);

export const VALID_RECAP_QUEUES = new Set(ALL_QUEUE_CHOICES.map((choice) => choice.value));

export function defaultRankedQueueForGame(game) {
    return game === GAME_TYPES.LOL ? LOL_QUEUE_TYPES.RANKED_SOLO_DUO : TFT_QUEUE_TYPES.RANKED;
}

export function gameFromQueue(queueType) {
    if (!queueType) return GAME_TYPES.TFT;
    const isLolQueue = LOL_QUEUE_TYPE_SET.has(queueType);
    return isLolQueue ? GAME_TYPES.LOL : GAME_TYPES.TFT;
}

export function queueChoicesForRecap(game = GAME_TYPES.TFT) {
    return game === GAME_TYPES.LOL ? LOL_QUEUE_CHOICES : TFT_QUEUE_CHOICES;
}

// === Queue helpers ===
// Provide a single spot to adjust labeling or ranked logic later.
export function queueLabel(game, queueType) {
    if (!queueType) return game === GAME_TYPES.LOL ? 'LoL' : 'TFT';
    const labels = QUEUE_LABELS_BY_GAME[game] ?? {};
    return labels[queueType] ?? queueType;
}

export function isRankedQueue(game, queueType) {
    const ranked = RANKED_QUEUES_BY_GAME[game];
    return ranked ? ranked.has(queueType) : false;
}

export function queueTypeFromQueueId(queueId, game = GAME_TYPES.TFT) {
    const mapped = QUEUE_ID_TO_QUEUE_TYPE[Number(queueId)];
    return mapped ?? (game === GAME_TYPES.LOL ? LOL_QUEUE_TYPES.UNKNOWN : TFT_QUEUE_TYPES.UNKNOWN);
}

export function mapRiotLolQueueType(queueType) {
    if (!queueType) return null;
    if (LOL_QUEUE_TYPE_SET.has(queueType)) return queueType;
    return LOL_RIOT_QUEUE_TYPE_TO_BOT_QUEUE_TYPE[queueType] ?? null;
}

export function resolveLolQueueContext({ match = null, queueId = null, rawQueueType = null } = {}) {
    const inferredQueueId = queueId ?? match?.info?.queueId ?? null;
    const mappedFromQueueId = queueTypeFromQueueId(inferredQueueId, GAME_TYPES.LOL);
    const mappedFromRawQueueType = mapRiotLolQueueType(rawQueueType);
    const queueType = mappedFromRawQueueType ?? mappedFromQueueId;
    return {
        queueType,
        queueLabel: queueLabel(GAME_TYPES.LOL, queueType),
        isRanked: isRankedQueue(GAME_TYPES.LOL, queueType),
    };
}
