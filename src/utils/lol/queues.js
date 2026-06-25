import { GAME_TYPES, resolveLolQueueContext } from '../../constants/queues.js';
import { resolveQueuePresentation } from '../matchEmbedShared.js';

// Extract the queue id from a match payload while handling API variations.
function getQueueIdFromLolMatch(match) {
    const info = match?.info;
    const q = info?.queueId ?? info?.queue_id ?? null;
    const parsed = typeof q === 'number' ? q : (q ? Number(q) : null);
    return Number.isFinite(parsed) ? parsed : null;
}

// Convert queue id into human-friendly metadata.
export function detectLolQueueMetaFromMatch(match) {
    const queueId = getQueueIdFromLolMatch(match);
    const resolved = resolveQueuePresentation({
        game: GAME_TYPES.LOL,
        queueId,
        queueResolver: ({ queueId: resolvedQueueId }) => resolveLolQueueContext({ match, queueId: resolvedQueueId }),
    });
    return { queueId, queueType: resolved.queueType, label: resolved.queueLabel, isRanked: resolved.isRanked };
}
