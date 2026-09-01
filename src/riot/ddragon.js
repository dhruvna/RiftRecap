import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DDRAGON_CACHE_DIR = join('debug', 'ddragon');

function toTitleCaseTier(tier) {
    if (!tier) return null;
    const lower = tier.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

async function fetchJsonOrThrow(url, label, cacheFile) {
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`${label} fetch failed: ${res.status}: ${body}`);
    }
    const data = await res.json();
    await mkdir(DDRAGON_CACHE_DIR, { recursive: true });
    await writeFile(join(DDRAGON_CACHE_DIR, cacheFile), JSON.stringify(data, null, 2));
    return data;
}

const DDRAGON_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

let ddragonVersionCache = {
    value: null,
    fetchedAt: 0,
};

export async function getLatestDDragonVersion() {
    const cacheIsFresh =
        ddragonVersionCache.value &&
        Date.now() - ddragonVersionCache.fetchedAt < DDRAGON_VERSION_TTL_MS;

    if (cacheIsFresh) return ddragonVersionCache.value;

    const versions = await fetchJsonOrThrow(
        'https://ddragon.leagueoflegends.com/api/versions.json',
        'Data Dragon versions',
        'versions.json'
    );

    ddragonVersionCache = {
        value: versions[0],
        fetchedAt: Date.now(),
    };

    return ddragonVersionCache.value;
}

function createDatasetLoader({ cacheKey, path }) {
    let cache = {
        version: null,
        value: null,
    };

    return async function loadDataset() {
        const version = await getLatestDDragonVersion();
        if (cache.version === version && cache.value) return cache.value;
        const url = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/${path}`;
        cache = {
            version,
            value: await fetchJsonOrThrow(url, `Data Dragon ${cacheKey}`, path),
        };

        return cache.value;
    };
}

const loadTFTRegalia = createDatasetLoader({
    cacheKey: 'TFT regalia',
    path: 'tft-regalia.json',
});

export const loadTFTChampions = createDatasetLoader({
    cacheKey: 'TFT champion',
    path: 'tft-champion.json',
});

export const loadTFTItems = createDatasetLoader({
    cacheKey: 'TFT item',
    path: 'tft-item.json',
});

export const loadTFTTraits = createDatasetLoader({
    cacheKey: 'TFT trait',
    path: 'tft-trait.json',
});

export const loadLolChampions = createDatasetLoader({
    cacheKey: 'LoL champion',
    path: 'champion.json',  
});

export const loadLolSummonerSpells = createDatasetLoader({
    cacheKey: 'LoL summoner spells',
    path: 'summoner.json',
});

export const loadLolRunes = createDatasetLoader({
    cacheKey: 'LoL runes',
    path: 'runesReforged.json',
});

export async function getTftRegaliaThumbnailUrl({ queueType, tier }) {
    const regalia = await loadTFTRegalia();
    const version = await getLatestDDragonVersion();

    const tierKey = toTitleCaseTier(tier);
    if (!tierKey) return null;

    const entry = regalia?.data?.[queueType]?.[tierKey];
    const file = entry?.image?.full;
    if (!file) return null;

    return `https://ddragon.leagueoflegends.com/cdn/${version}/img/tft-regalia/${file}`;
}
