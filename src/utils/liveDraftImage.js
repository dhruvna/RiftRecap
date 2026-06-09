import { Canvas, loadImage } from '@napi-rs/canvas';

const SLOT_COUNT_PER_SIDE = 5;
const ICON_SIZE = 48;
const ICON_GAP = 8;
const SIDE_PADDING_X = 16;
const CANVAS_PADDING_Y = 12;
const VS_WIDTH = 42;

const BACKGROUND_COLOR = '#141822';
const VS_BACKGROUND = '#21283A';
const BLUE_EMPTY = '#4B5563';
const RED_EMPTY = '#4B5563';
const SLOT_RADIUS = 6;
const ICON_IMAGE_CACHE_MAX_ENTRIES = 256;
const iconImageCache = new Map();

function getLiveDraftStripLayout() {
  const sideWidth = (SLOT_COUNT_PER_SIDE * ICON_SIZE) + ((SLOT_COUNT_PER_SIDE - 1) * ICON_GAP);
  const width = (SIDE_PADDING_X * 2) + sideWidth + VS_WIDTH + sideWidth;
  const height = (CANVAS_PADDING_Y * 2) + ICON_SIZE;
  return { width, height, sideWidth };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawRoundedRect(ctx, x, y, w, h, r, fillStyle) {
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function evictOldIconImageCacheEntries() {
  while (iconImageCache.size > ICON_IMAGE_CACHE_MAX_ENTRIES) {
    const oldestIconUrl = iconImageCache.keys().next().value;
    iconImageCache.delete(oldestIconUrl);
  }
}

function loadIconImageCached(iconUrl) {
  if (!iconUrl) return null;

  const cachedImage = iconImageCache.get(iconUrl);
  if (cachedImage) return cachedImage;

  const imagePromise = loadImage(iconUrl);
  iconImageCache.set(iconUrl, imagePromise);
  evictOldIconImageCacheEntries();

  return imagePromise
    .then((image) => {
      if (iconImageCache.get(iconUrl) === imagePromise) {
        iconImageCache.set(iconUrl, image);
      }
      return image;
    })
    .catch((error) => {
      if (iconImageCache.get(iconUrl) === imagePromise) {
        iconImageCache.delete(iconUrl);
      }
      throw error;
    });
}

function drawSlotIconOrFallback(ctx, image, x, y, fallbackColor) {
  drawRoundedRect(ctx, x, y, ICON_SIZE, ICON_SIZE, SLOT_RADIUS, fallbackColor);
  if (!image) return;

  ctx.save();
  roundedRectPath(ctx, x, y, ICON_SIZE, ICON_SIZE, SLOT_RADIUS);
  ctx.clip();
  ctx.drawImage(image, x, y, ICON_SIZE, ICON_SIZE);
  ctx.restore();
}

export async function buildLiveDraftImageBuffer({ blueIconUrls = [], redIconUrls = [] }) {
  const { width, height, sideWidth } = getLiveDraftStripLayout();
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = VS_BACKGROUND;
  ctx.fillRect(SIDE_PADDING_X + sideWidth, 0, VS_WIDTH, height);
  const topY = CANVAS_PADDING_Y;
  const leftStart = SIDE_PADDING_X;
  const rightStart = SIDE_PADDING_X + sideWidth + VS_WIDTH;

  const blueIconLoadPromises = blueIconUrls
    .slice(0, SLOT_COUNT_PER_SIDE)
    .map((iconUrl) => loadIconImageCached(iconUrl));
  const redIconLoadPromises = redIconUrls
    .slice(0, SLOT_COUNT_PER_SIDE)
    .map((iconUrl) => loadIconImageCached(iconUrl));
  const [blueIconLoadResults, redIconLoadResults] = await Promise.all([
    Promise.allSettled(blueIconLoadPromises),
    Promise.allSettled(redIconLoadPromises),
  ]);

  for (let index = 0; index < SLOT_COUNT_PER_SIDE; index += 1) {
    const bx = leftStart + (index * (ICON_SIZE + ICON_GAP));
    const rx = rightStart + (index * (ICON_SIZE + ICON_GAP));
    const blueImage = blueIconLoadResults[index]?.status === 'fulfilled'
      ? blueIconLoadResults[index].value
      : null;
    const redImage = redIconLoadResults[index]?.status === 'fulfilled'
      ? redIconLoadResults[index].value
      : null;

    drawSlotIconOrFallback(ctx, blueImage, bx, topY, BLUE_EMPTY);
    drawSlotIconOrFallback(ctx, redImage, rx, topY, RED_EMPTY);
  }

  return canvas.toBuffer('image/png');
}
