import {
    getLatestDDragonVersion,
    loadTFTChampions,
    loadTFTItems,
    loadTFTTraits,
    loadLolChampions,
    loadLolSummonerSpells,
    loadLolRunes,
} from './ddragon.js';

function createLookupIndex({ loadDataset, normalizeEntryId = (id) => id }) {
    let imageById = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getLatestDDragonVersion();
        if (imageById && cachedVersion === latestVersion) {
            return { imageById, version: cachedVersion };
        }

        const dataset = await loadDataset();
        const entries = Object.values(dataset?.data ?? {});
        const nextImageById = new Map();

        for (const entry of entries) {
            if (!entry?.id || !entry?.image?.full) continue;
            nextImageById.set(normalizeEntryId(entry.id), entry.image.full);
        }

        imageById = nextImageById;
        cachedVersion = latestVersion;
        return { imageById, version: cachedVersion };
    }

    return {
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

export function createLolChampionLookup({
    getVersion = getLatestDDragonVersion,
    loadChampions = loadLolChampions,
} = {}) {
    let imageByChampionId = null;
    let canonicalIdByChampionId = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getVersion();
        if (imageByChampionId && cachedVersion === latestVersion) {
            return { imageByChampionId, canonicalIdByChampionId, version: cachedVersion };
        }

        const dataset = await loadChampions();
        const entries = Object.values(dataset?.data ?? {});
        const nextImageByChampionId = new Map();
        const nextCanonicalIdByChampionId = new Map();

        for (const entry of entries) {
            const imageFile = entry?.image?.full;
            const championKey = String(entry?.key ?? '').trim();
            const championId = String(entry?.id ?? '').trim();

            if (championKey) {
                if (imageFile) nextImageByChampionId.set(championKey, imageFile);
                if (championId) nextCanonicalIdByChampionId.set(championKey, championId);
            }
            if (championId) {
                if (imageFile) nextImageByChampionId.set(championId, imageFile);
                nextCanonicalIdByChampionId.set(championId, championId);
            }
        }

        imageByChampionId = nextImageByChampionId;
        canonicalIdByChampionId = nextCanonicalIdByChampionId;
        cachedVersion = latestVersion;
        return { imageByChampionId, canonicalIdByChampionId, version: cachedVersion };
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
        async getSkinImage(championId, skinNum) {
            const championKey = String(championId ?? '').trim();
            if (!championKey || skinNum == null || (typeof skinNum === 'string' && skinNum.trim() === '')) return null;
            const normalizedSkinNum = Number(skinNum);
            if (!Number.isFinite(normalizedSkinNum) || normalizedSkinNum < 0) return null;

            const { canonicalIdByChampionId: map } = await loadIndexes();
            const canonicalChampionId = map.get(championKey);
            if (!canonicalChampionId) return null;
            // Splash-derived assets are served from Data Dragon's unversioned CDN
            // path. Only the champion icon endpoint is scoped to a patch version.
            return `https://ddragon.leagueoflegends.com/cdn/img/champion/tiles/${canonicalChampionId}_${normalizedSkinNum}.jpg`;
        },
    };
}

function createLolSummonerSpellLookup() {
    let imageBySpellId = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getLatestDDragonVersion();
        if (imageBySpellId && cachedVersion === latestVersion) {
            return { imageBySpellId, version: cachedVersion };
        }

        const dataset = await loadLolSummonerSpells();
        const entries = Object.values(dataset?.data ?? {});
        const nextImageBySpellId = new Map();

        for (const entry of entries) {
            const spellKey = String(entry?.key ?? '').trim();
            const imageFile = entry?.image?.full;
            if (spellKey && imageFile) {
                nextImageBySpellId.set(spellKey, imageFile);
            }
        }

        imageBySpellId = nextImageBySpellId;
        cachedVersion = latestVersion;
        return { imageBySpellId, version: cachedVersion };
    }

    return {
        async getImageById(spellId) {
            const key = String(spellId ?? '').trim();
            if (!key) return null;
            const { imageBySpellId: map, version } = await loadIndexes();
            const file = map.get(key);
            if (!file) return null;
            return `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${file}`;
        },
    };
}

function createLolRuneLookup() {
    let imageByRuneId = null;
    let cachedVersion = null;

    async function loadIndexes() {
        const latestVersion = await getLatestDDragonVersion();
        if (imageByRuneId && cachedVersion === latestVersion) {
            return { imageByRuneId, version: cachedVersion };
        }

        const runeTrees = await loadLolRunes();
        const nextImageByRuneId = new Map();

        for (const tree of Array.isArray(runeTrees) ? runeTrees : []) {
            for (const slot of Array.isArray(tree?.slots) ? tree.slots : []) {
                for (const rune of Array.isArray(slot?.runes) ? slot.runes : []) {
                    const runeId = String(rune?.id ?? '').trim();
                    const iconPath = String(rune?.icon ?? '').trim();
                    if (runeId && iconPath) {
                        nextImageByRuneId.set(runeId, iconPath);
                    }
                }
            }
        }

        imageByRuneId = nextImageByRuneId;
        cachedVersion = latestVersion;
        return { imageByRuneId, version: cachedVersion };
    }

    return {
        async getImageById(runeId) {
            const key = String(runeId ?? '').trim();
            if (!key) return null;
            const { imageByRuneId: map } = await loadIndexes();
            const iconPath = map.get(key);
            if (!iconPath) return null;
            return `https://ddragon.leagueoflegends.com/cdn/img/${iconPath}`;
        },
    };
}

const lolChampionLookup = createLolChampionLookup();
const lolSummonerSpellLookup = createLolSummonerSpellLookup();
const lolRuneLookup = createLolRuneLookup();

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

async function resolveImageMap(ids, lookup) {
    const resolved = new Map();
    const uniqueIds = Array.isArray(ids) ? ids : [];

    await Promise.all(uniqueIds.map(async (id) => {
        const key = String(id ?? '').trim();
        if (!key || resolved.has(key)) return;

        const imageUrl = await lookup.getImageById(key);
        if (imageUrl) {
            resolved.set(key, imageUrl);
        }
    }));

    return resolved;
}

export function getTftChampionImageById(characterId) {
    return championLookup.getImageById(characterId, 'tft-champion');
}

export function getTftItemImageById(itemId) {
    return itemLookup.getImageById(itemId, 'tft-item');
}

export function getTftTraitImageById(traitId) {
    return traitLookup.getImageById(traitId, 'tft-trait');
}

export function getLolChampionImagesByIds(ids) {
    return resolveImageMap(ids, lolChampionLookup);
}

export async function getLolChampionSkinImagesBySelections(selections, lookup = lolChampionLookup) {
    const resolved = new Map();
    await Promise.all((Array.isArray(selections) ? selections : []).map(async (selection) => {
        const championId = String(selection?.championId ?? '').trim();
        const skinValue = selection?.skinNum;
        if (!championId || skinValue == null || (typeof skinValue === 'string' && skinValue.trim() === '')) return;
        const skinNum = Number(skinValue);
        if (!Number.isFinite(skinNum) || skinNum < 0) return;
        const key = `${championId}:${skinNum}`;
        if (resolved.has(key)) return;
        const imageUrl = await lookup.getSkinImage(championId, skinNum);
        if (imageUrl) resolved.set(key, imageUrl);
    }));
    return resolved;
}

export function getLolSpellImagesByIds(ids) {
    return resolveImageMap(ids, lolSummonerSpellLookup);
}

export function getLolRuneImagesByIds(ids) {
    return resolveImageMap(ids, lolRuneLookup);
}
