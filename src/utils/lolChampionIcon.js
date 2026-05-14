export function resolveChampionIcon({ participant, championImagesById = new Map() }) {
    const championId = participant?.championId;
    let resolvedImageKey = null;

    const championIconUrl = championId != null
        ? (championImagesById.get(String(championId)) ?? null)
        : null;

    if (championIconUrl) {
        const fileName = championIconUrl.split('/').pop();
        resolvedImageKey = fileName ? fileName.replace(/\.png$/i, '') : null;
    }

    return { resolvedImageKey, championIconUrl };
}
