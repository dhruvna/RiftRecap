import { loadCostStarImage, loadItemImage, loadTraitImage, loadUnitImage } from './unitStrip/assets.js';
import { drawBackground, drawTraitSection, drawUnitCard } from './unitStrip/draw.js';
import { calculateUnitStripLayout, getUnitCardPosition } from './unitStrip/layout.js';
import { normalizeTraits, normalizeUnits } from './unitStrip/model.js';
import { createHighResolutionCanvas } from './highResolutionCanvas.js';
import { getTftChampionDataById } from '../riot.js';

const DEFAULT_TILE_SIZE = 76;
const DEFAULT_PADDING = 10;
const DEFAULT_MAX_UNITS = 10;
const DEFAULT_COLUMNS = 6;
const DEFAULT_TRAIT_ICON_SIZE = 30;

async function loadUnitCardImages(unit) {
    const championImage = await loadUnitImage(unit?.character_id);
    const starImage = await loadCostStarImage(unit);
    const itemIds = Array.isArray(unit?.itemNames) && unit.itemNames.length > 0
        ? unit.itemNames
        : unit?.items;
    const itemImages = [];
    for (const itemId of (itemIds || []).slice(0, 3)) {
        const itemImage = await loadItemImage(itemId);
        if (itemImage) itemImages.push(itemImage);
    }
    return { championImage, starImage, itemImages };
}

export async function buildUnitStripImage(units, options = {}) {
    const renderOptions = {
        tileSize: options.tileSize ?? DEFAULT_TILE_SIZE,
        padding: options.padding ?? DEFAULT_PADDING,
        maxUnits: options.maxUnits ?? DEFAULT_MAX_UNITS,
        columns: options.columns ?? DEFAULT_COLUMNS,
        traits: options.traits ?? [],
        traitIconSize: options.traitIconSize ?? DEFAULT_TRAIT_ICON_SIZE,
    };

    const unitsWithStaticData = await Promise.all(
        (Array.isArray(units) ? units : []).map(async (unit) => {
            const champion = await getTftChampionDataById(unit?.character_id);
            return champion?.cost == null ? unit : { ...unit, cost: champion.cost };
        }),
    );
    const normalized = normalizeUnits(unitsWithStaticData, renderOptions.maxUnits);
    const normalizedTraits = normalizeTraits(renderOptions.traits);
    if (normalized.length === 0) return null;

    const layout = calculateUnitStripLayout(normalized.length, normalizedTraits.length, renderOptions);
    const { canvas, ctx } = createHighResolutionCanvas(layout.width, layout.height);
    
    drawBackground(ctx, layout.width, layout.height);
    const traitImages = await Promise.all(
        normalizedTraits.map((trait) => loadTraitImage(trait?.name)),
    );
    drawTraitSection(ctx, normalizedTraits, traitImages, layout, renderOptions);

    for (const [index, unit] of normalized.entries()) {
        const position = getUnitCardPosition(index, layout, renderOptions);
        const images = await loadUnitCardImages(unit);
        drawUnitCard(ctx, unit, images, position, layout);
    }
    return canvas.toBuffer('image/png');
}
