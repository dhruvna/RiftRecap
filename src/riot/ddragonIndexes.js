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

const lolChampionLookup = createLookupIndex({
    loadDataset: loadLolChampions,
    normalizeEntryId: (id) => String(id),
});

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
    const imageUrl = await lolChampionLookup.getImageById(championId, 'champion');
    if (!imageUrl) return null;

    const fileName = imageUrl.split('/').pop();
    if (!fileName) return null;
    return fileName.replace(/\.png$/i, '');
}

export function getLolChampionImageById(championId) {
    return lolChampionLookup.getImageById(championId, 'champion');
}
