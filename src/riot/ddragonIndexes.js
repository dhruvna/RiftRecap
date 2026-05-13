import {
    getLatestDDragonVersion,
    loadTFTChampions,
    loadTFTItems,
    loadTFTTraits,
    loadLolChampions,
} from './ddragon.js';

function createLookupIndex({ loadDataset, normalizeEntryId = (id) => id }) {
    let nameById = null;
    let imageById = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getLatestDDragonVersion();
        if (nameById && imageById && cachedVersion === latestVersion) {
            return { nameById, imageById, version: cachedVersion };
        }

        const dataset = await loadDataset();
        const entries = Object.values(dataset?.data ?? {});
        const nextNameById = new Map();
        const nextImageById = new Map();

        for (const entry of entries) {
            if (!entry?.id) continue;
            const normalizedId = normalizeEntryId(entry.id);
            if (entry?.name) {
                nextNameById.set(normalizedId, entry.name);
            }
            if (entry?.image?.full) {
                nextImageById.set(normalizedId, entry.image.full);
            }
        }

        nameById = nextNameById;
        imageById = nextImageById;
        cachedVersion = latestVersion;
        return { nameById, imageById, version: cachedVersion };
    }

    return {
        async getNameById(id) {
            const key = normalizeEntryId(id);
            if (!key) return null;
            const { nameById: map } = await loadIndexes();
            return map.get(key) ?? null;
        },
        async getImageById(id, imageFolder) {
            const key = normalizeEntryId(id);
            if (!key) return null;
            const { imageById: map, version } = await loadIndexes();
            const file = map.get(key);
            if (!file) return null;
            return `https://ddragon.leagueoflegends.com/cdn/${version}/img/${imageFolder}/${file}`;
        },
    };
}

function createLolChampionLookup() {
    let imageByChampionId = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getLatestDDragonVersion();
        if (imageByChampionId && cachedVersion === latestVersion) {
            return { imageByChampionId, version: cachedVersion };
        }

        const dataset = await loadLolChampions();
        const entries = Object.values(dataset?.data ?? {});
        const nextImageByChampionId = new Map();

        for (const entry of entries) {
            const imageFile = entry?.image?.full;
            if (!imageFile) continue;

            const championKey = String(entry?.key ?? '').trim();
            const championId = String(entry?.id ?? '').trim();

            if (championKey) {
                nextImageByChampionId.set(championKey, imageFile);
            }
            if (championId) {
                nextImageByChampionId.set(championId, imageFile);
            }
        }

        imageByChampionId = nextImageByChampionId;
        cachedVersion = latestVersion;
        return { imageByChampionId, version: cachedVersion };
    }

    return {
        async getImageById(championId) {
            const key = String(championId ?? '').trim();
            if (!key) return null;
            const { imageByChampionId: map, version } = await loadIndexes();
            const file = map.get(key);
            if (!file) return null;
            return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${file}`;
        },
    };
}

const lolChampionLookup = createLolChampionLookup();

const championLookup = createLookupIndex({
    loadDataset: loadTFTChampions,
});

const itemLookup = createLookupIndex({
    loadDataset: loadTFTItems,
    normalizeEntryId: (id) => String(id),
});

const traitLookup = createLookupIndex({
    loadDataset: loadTFTTraits,
    normalizeEntryId: (id) => String(id),
});

export function getTftChampionNameById(characterId) {
    return championLookup.getNameById(characterId);
}

export function getTftChampionImageById(characterId) {
    return championLookup.getImageById(characterId, 'tft-champion');
}

export function getTftItemNameById(itemId) {
    return itemLookup.getNameById(itemId);
}

export function getTftItemImageById(itemId) {
    return itemLookup.getImageById(itemId, 'tft-item');
}

export function getTftTraitNameById(traitId) {
    return traitLookup.getNameById(traitId);
}

export function getTftTraitImageById(traitId) {
    return traitLookup.getImageById(traitId, 'tft-trait');
}

export async function getLolChampionImageKeyById(championId) {
    const imageUrl = await lolChampionLookup.getImageById(championId);
    if (!imageUrl) return null;

    const fileName = imageUrl.split('/').pop();
    if (!fileName) return null;
    return fileName.replace(/\.png$/i, '');
}

export function getLolChampionImageById(championId) {
    return lolChampionLookup.getImageById(championId);
}

export async function getLolChampionImagesByIds(ids) {
    const championIds = Array.isArray(ids) ? ids : [];
    const resolved = new Map();

    await Promise.all(championIds.map(async (championId) => {
        const key = String(championId ?? '').trim();
        if (!key || resolved.has(key)) return;

        const imageUrl = await lolChampionLookup.getImageById(key);
        if (imageUrl) {
            resolved.set(key, imageUrl);
        }
    }));

    return resolved;
}
