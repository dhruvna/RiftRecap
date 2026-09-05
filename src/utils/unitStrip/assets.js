import { loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { getTftChampionImageById, getTftItemImageById, getTftTraitImageById } from '../../riot.js';
import { getUnitCost } from './model.js';

const IMAGE_CACHE_MAX_SIZE = 512;

const COST_STAR_PATHS = {
    1: 'assets/1CostStar.svg',
    2: 'assets/2CostStar.svg',
    3: 'assets/3CostStar.svg',
    4: 'assets/4CostStar.svg',
    5: 'assets/5CostStar.svg',
};

const starAssetCache = new Map();
const championImageCache = new Map();
const itemImageCache = new Map();
const traitImageCache = new Map();

function touchCacheEntry(cache, key) {
    const value = cache.get(key);
    if (value === undefined) return;
    cache.delete(key);
    cache.set(key, value);
}

function setWithLimit(cache, key, value, maxSize = IMAGE_CACHE_MAX_SIZE) {
    cache.set(key, value);
    while (cache.size > maxSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

function memoizeImageLoad(cache, key, loader) {
    if (!key) return loader();

    if (cache.has(key)) {
        touchCacheEntry(cache, key);
        return cache.get(key);
    }

    const imagePromise = loader().catch(() => null);
    setWithLimit(cache, key, imagePromise);
    return imagePromise;
}

async function fetchImageFromUrl(url) {
    if (!url) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buffer = Buffer.from(await res.arrayBuffer());
        return await loadImage(buffer);
    } catch {
        return null;
    }
}

function getCostStarAssetPath(unit) {
    const cost = getUnitCost(unit);
    return COST_STAR_PATHS[cost >= 5 ? 5 : cost];
}

export async function loadCostStarImage(unit) {
    const assetPath = getCostStarAssetPath(unit);
    if (!assetPath) return null;

    if (!starAssetCache.has(assetPath)) {
        const filePath = fileURLToPath(new URL(`../../../${assetPath}`, import.meta.url));
        const imagePromise = loadImage(filePath).catch(() => null);
        starAssetCache.set(assetPath, imagePromise);
    }

    return starAssetCache.get(assetPath);
}

export async function loadUnitImage(characterId) {
    if (!characterId) return undefined;

    return memoizeImageLoad(championImageCache, characterId, async () => {
        const url = await getTftChampionImageById(characterId);
        return fetchImageFromUrl(url);
    });
}

export async function loadItemImage(itemId) {
    if (!itemId) return null;

    return memoizeImageLoad(itemImageCache, itemId, async () => {
        const url = await getTftItemImageById(itemId);
        return fetchImageFromUrl(url);
    });
}

export async function loadTraitImage(traitId) {
    if (!traitId) return null;

    return memoizeImageLoad(traitImageCache, traitId, async () => {
        const url = await getTftTraitImageById(traitId);
        return fetchImageFromUrl(url);
    });
}
