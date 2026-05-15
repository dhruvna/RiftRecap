export function collectUnseenMatchIds({ ids, lastMatchId, unseenMatchIds, limit }) {
    let foundLast = false;

    for (const id of ids) {
        if (id === lastMatchId) {
            foundLast = true;
            break;
        }
        unseenMatchIds.push(id);
        if (unseenMatchIds.length >= limit) {
            break;
        }
    }

    return { unseenMatchIds, foundLast };
}

export async function detectUnseenMatchIds({ tracking, matchBackfillLimit, fetchMatchIdsByAccount }) {
    if (!tracking?.lastMatchId) {
        const ids = await fetchMatchIdsByAccount({ count: 1, start: 0 });
        return Array.isArray(ids) ? ids.slice(0, 1) : [];
    }

    let unseenMatchIds = [];
    let start = 0;
    let foundLast = false;

    while (unseenMatchIds.length < matchBackfillLimit && !foundLast) {
        const remaining = matchBackfillLimit - unseenMatchIds.length;
        const count = Math.min(20, remaining);
        const ids = await fetchMatchIdsByAccount({ count, start });
        if (!Array.isArray(ids) || ids.length === 0) {
            break;
        }

        ({ unseenMatchIds, foundLast } = collectUnseenMatchIds({
            ids,
            lastMatchId: tracking.lastMatchId,
            unseenMatchIds,
            limit: matchBackfillLimit,
        }));

        if (foundLast || ids.length < count) {
            break;
        }

        start += ids.length;
    }

    return unseenMatchIds;
}
