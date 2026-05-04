import {
    GAME_TYPES,
    LOL_QUEUE_TYPES,
    TFT_QUEUE_TYPES,
} from "../constants/queues.js";

const QUEUE_ID_TO_QUEUE_TYPE = Object.freeze({ 
    1100: TFT_QUEUE_TYPES.RANKED, 
    1160: TFT_QUEUE_TYPES.RANKED_DOUBLE_UP, 
    420: LOL_QUEUE_TYPES.RANKED_SOLO_DUO, 
    440: LOL_QUEUE_TYPES.RANKED_FLEX 
});
const QUEUE_LABELS_BY_GAME = Object.freeze({ 
    [GAME_TYPES.TFT]: Object.freeze({ 
        [TFT_QUEUE_TYPES.RANKED]: "Ranked TFT", 
        [TFT_QUEUE_TYPES.RANKED_DOUBLE_UP]: "Double Up TFT", 
        [TFT_QUEUE_TYPES.UNKNOWN]: "Unknown" 
    }), [GAME_TYPES.LOL]: Object.freeze({ 
        [LOL_QUEUE_TYPES.RANKED_SOLO_DUO]: "Ranked Solo/Duo", 
        [LOL_QUEUE_TYPES.RANKED_FLEX]: "Ranked Flex", 
        [LOL_QUEUE_TYPES.UNKNOWN]: "Unknown" 
    }) 
});

export const RANKED_QUEUES_BY_GAME = Object.freeze({ 
    [GAME_TYPES.TFT]: Object.freeze([TFT_QUEUE_TYPES.RANKED, TFT_QUEUE_TYPES.RANKED_DOUBLE_UP]),
    [GAME_TYPES.LOL]: Object.freeze([LOL_QUEUE_TYPES.RANKED_SOLO_DUO, LOL_QUEUE_TYPES.RANKED_FLEX]) 
});

export const RECAP_QUEUE_CHOICES_BY_GAME = Object.freeze({ 
    [GAME_TYPES.TFT]: Object.freeze([
        { name: "Ranked TFT", value: TFT_QUEUE_TYPES.RANKED }, 
        { name: "Double Up TFT", value: TFT_QUEUE_TYPES.RANKED_DOUBLE_UP }
    ]), 
    [GAME_TYPES.LOL]: Object.freeze([
        { name: "LoL Ranked Solo/Duo", value: LOL_QUEUE_TYPES.RANKED_SOLO_DUO }, 
        { name: "LoL Ranked Flex", value: LOL_QUEUE_TYPES.RANKED_FLEX }
    ]) 
});

export const LEADERBOARD_QUEUE_CHOICES_BY_GAME = RECAP_QUEUE_CHOICES_BY_GAME;
export const LOL_RIOT_QUEUE_TYPE_TO_BOT_QUEUE_TYPE = Object.freeze({ 
    RANKED_SOLO_5x5: LOL_QUEUE_TYPES.RANKED_SOLO_DUO, 
    RANKED_FLEX_SR: LOL_QUEUE_TYPES.RANKED_FLEX 
});

export function queueTypeFromQueueId(queueId, game = GAME_TYPES.TFT) { 
    const mapped = QUEUE_ID_TO_QUEUE_TYPE[Number(queueId)]; 
    return mapped ?? (game === GAME_TYPES.LOL ? LOL_QUEUE_TYPES.UNKNOWN : TFT_QUEUE_TYPES.UNKNOWN); 
}
export function resolveGameFromQueue(queueType) { 
    return RANKED_QUEUES_BY_GAME[GAME_TYPES.LOL].includes(queueType) || queueType === LOL_QUEUE_TYPES.UNKNOWN ? GAME_TYPES.LOL : GAME_TYPES.TFT; 
}
export function defaultRankedQueueByGame(game = GAME_TYPES.TFT) { 
    return game === GAME_TYPES.LOL ? LOL_QUEUE_TYPES.RANKED_SOLO_DUO : TFT_QUEUE_TYPES.RANKED; }
export function queueLabelForGame(game, queueType) { 
    if (!queueType) return game === GAME_TYPES.LOL ? "LoL" : "TFT"; return QUEUE_LABELS_BY_GAME[game]?.[queueType] ?? String(queueType); 
}
export function isRankedQueueForGame(game, queueType) { 
    return RANKED_QUEUES_BY_GAME[game]?.includes(queueType) ?? false; 
}
export function rankedQueueChoicesByGame(game = GAME_TYPES.TFT) { 
    return RECAP_QUEUE_CHOICES_BY_GAME[game] ?? RECAP_QUEUE_CHOICES_BY_GAME[GAME_TYPES.TFT]; 
}
export function recapQueueChoices(game = GAME_TYPES.TFT) { 
    return RECAP_QUEUE_CHOICES_BY_GAME[game] ?? RECAP_QUEUE_CHOICES_BY_GAME[GAME_TYPES.TFT]; 
}
export function leaderboardQueueChoices(game = GAME_TYPES.TFT) { 
    return LEADERBOARD_QUEUE_CHOICES_BY_GAME[game] ?? LEADERBOARD_QUEUE_CHOICES_BY_GAME[GAME_TYPES.TFT]; 
}
export function allRecapQueueChoices() { 
    return [...RECAP_QUEUE_CHOICES_BY_GAME[GAME_TYPES.TFT], ...RECAP_QUEUE_CHOICES_BY_GAME[GAME_TYPES.LOL]]; 
}
export function allLeaderboardQueueChoices() { 
    return [...LEADERBOARD_QUEUE_CHOICES_BY_GAME[GAME_TYPES.TFT], ...LEADERBOARD_QUEUE_CHOICES_BY_GAME[GAME_TYPES.LOL]]; 
}
export function validRecapQueuesSet() { 
    return new Set(allRecapQueueChoices().map((choice) => choice.value)); 
}
export function mapRiotLolQueueType(queueType) { 
    return LOL_RIOT_QUEUE_TYPE_TO_BOT_QUEUE_TYPE[queueType] ?? null; 
}
