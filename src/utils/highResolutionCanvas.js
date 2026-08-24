import { createCanvas } from '@napi-rs/canvas';

// Discord displays attached images at a smaller CSS size than their pixel dimensions.
// Rendering at 2x preserves the existing layout while giving text, borders, and source
// artwork enough pixels to remain sharp on high-density displays.
export const IMAGE_RENDER_SCALE = 2;

export function createHighResolutionCanvas(width, height) {
    const canvas = createCanvas(width * IMAGE_RENDER_SCALE, height * IMAGE_RENDER_SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(IMAGE_RENDER_SCALE, IMAGE_RENDER_SCALE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    return { canvas, ctx };
}
