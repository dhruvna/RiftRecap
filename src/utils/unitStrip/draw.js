import { createCanvas } from '@napi-rs/canvas';
import { STAR_ICON_SIZE, STAR_ICON_SPACING, STAR_ROW_HEIGHT } from './layout.js';

export function getUnitTierColor(unit) {
    // tier means star level
    // rarity seems to be a binary version of cost? 0, 1, 2, 4, 6, 7
    const rarity = Number(unit?.rarity ?? 0);
    if (rarity >= 6) return '#f18b2f';
    if (rarity === 4) return '#9a4de0';
    if (rarity === 2) return '#2f97e8';
    if (rarity === 1) return '#3ca56a';
    return '#656a74';
}

export function getTraitTierColor(trait) {
    // style:
    // 0 = gray (no active bonus)
    // 1 = bronze
    // 2 = silver
    // 3 = UNIQUE
    // 4 = gold
    // 5 = prismatic
    const style = Number(trait?.style ?? 0);
    if (style >= 5) return '#c4fdc9';
    if (style === 4) return '#DBC66F';
    if (style === 3) return '#FEAF76';
    if (style === 2) return '#ACC5CA';
    if (style === 1) return '#CD7B46';
    return '#7b808e';
}

export function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

export function drawBackground(ctx, width, height) {
    const backgroundGradient = ctx.createLinearGradient(0, 0, 0, height);
    backgroundGradient.addColorStop(0, 'rgba(15, 17, 26, 0.92)');
    backgroundGradient.addColorStop(1, 'rgba(8, 10, 15, 0.92)');
    ctx.fillStyle = backgroundGradient;
    ctx.fillRect(0, 0, width, height);
}

export function drawTierStars(ctx, starImage, stars, x, y, width) {
    const count = Math.min(3, Math.max(0, Number(stars ?? 0)));
    if (!starImage || !Number.isFinite(count) || count <= 0) return;

    const totalWidth = count * STAR_ICON_SIZE + (count - 1) * STAR_ICON_SPACING;
    const startX = Math.floor(x + (width - totalWidth) / 2);
    const drawY = Math.floor(y + (STAR_ROW_HEIGHT - STAR_ICON_SIZE) / 2);

    for (let i = 0; i < count; i += 1) {
        const drawX = startX + i * (STAR_ICON_SIZE + STAR_ICON_SPACING);
        ctx.drawImage(starImage, drawX, drawY, STAR_ICON_SIZE, STAR_ICON_SIZE);
    }
}

function drawMonochromeTraitIcon(ctx, traitImage, x, y, size) {
    if (!traitImage) return;

    try {
        const offscreen = createCanvas(size, size);
        const offscreenCtx = offscreen.getContext('2d');

        offscreenCtx.drawImage(traitImage, 0, 0, size, size);
        offscreenCtx.globalCompositeOperation = 'source-atop';
        offscreenCtx.fillStyle = '#000';
        offscreenCtx.fillRect(0, 0, size, size);
        offscreenCtx.globalCompositeOperation = 'source-over';

        ctx.drawImage(offscreen, x, y, size, size);
    } catch {
        // Fallback to original image if recolor fails for any reason.
        ctx.drawImage(traitImage, x, y, size, size);
    }
}

export function drawTraitSection(ctx, traits, traitImages, layout, options) {
    const { padding, traitIconSize } = options;
    if (traits.length === 0) return;

    ctx.fillStyle = 'rgba(11, 13, 20, 0.92)';
    drawRoundedRect(ctx, padding / 2, padding / 2, layout.width - padding, layout.traitSectionHeight - padding / 2, 8);
    ctx.fill();

    for (const [index, trait] of traits.entries()) {
        const iconX = layout.traitRowOffsetX + padding + index * (traitIconSize + padding);
        const iconY = padding;
        const traitImage = traitImages[index];

        const traitBackground = getTraitTierColor(trait);
        ctx.fillStyle = traitBackground;
        drawRoundedRect(ctx, iconX, iconY, traitIconSize, traitIconSize, 6);
        ctx.fill();

        if (traitImage) {
            drawMonochromeTraitIcon(ctx, traitImage, iconX + 2, iconY + 2, traitIconSize - 4);
        }

        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        drawRoundedRect(ctx, iconX + 1, iconY + 1, traitIconSize - 2, traitIconSize - 2, 5);
        ctx.stroke();
    }
}

export function drawUnitCard(ctx, unit, images, position, layout) {
    const { championImage, starImage, itemImages } = images;
    const { x, y } = position;
    const { cardWidth, portraitHeight, itemRowHeight } = layout;
    const frameColor = getUnitTierColor(unit);

    drawTierStars(ctx, starImage, unit?.tier, x, y, cardWidth);

    const portraitY = y + STAR_ROW_HEIGHT;
    ctx.fillStyle = 'rgba(14, 16, 23, 0.96)';
    drawRoundedRect(ctx, x, portraitY, cardWidth, portraitHeight, 6);
    ctx.fill();

    if (championImage) {
        ctx.drawImage(championImage, x + 3, portraitY + 3, cardWidth - 6, portraitHeight - 5);
    } else {
        // if no image, put the unit id as text
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const textX = x + cardWidth / 2;
        const textY = portraitY + portraitHeight / 2;
        const text = String(unit?.character_id ?? 'Unknown').toUpperCase();
        ctx.fillText(text, textX, textY, cardWidth - 10);
    }

    const itemRowY = portraitY + portraitHeight;
    const visibleItemCount = itemImages.length;
    if (visibleItemCount > 0) {
        const itemSize = Math.floor(Math.min(cardWidth / 3, itemRowHeight) * 0.86);
        const totalItemWidth = visibleItemCount * itemSize;
        const itemStartX = Math.floor(x + (cardWidth - totalItemWidth) / 2);
        const itemY = Math.floor(itemRowY + (itemRowHeight - itemSize) / 2);

        for (let i = 0; i < visibleItemCount; i += 1) {
            const itemX = itemStartX + i * itemSize;
            ctx.drawImage(itemImages[i], itemX, itemY, itemSize, itemSize);
        }
    }

    ctx.strokeStyle = frameColor;
    ctx.lineWidth = 3;
    drawRoundedRect(ctx, x + 1.5, portraitY + 1.5, cardWidth - 3, portraitHeight - 3, 5);
    ctx.stroke();
}
