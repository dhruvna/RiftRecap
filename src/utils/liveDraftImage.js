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

async function drawSlotIconOrFallback(ctx, iconUrl, x, y, fallbackColor) {
  drawRoundedRect(ctx, x, y, ICON_SIZE, ICON_SIZE, SLOT_RADIUS, fallbackColor);
  if (!iconUrl) return;
  try {
    const image = await loadImage(iconUrl);
    ctx.save();
    roundedRectPath(ctx, x, y, ICON_SIZE, ICON_SIZE, SLOT_RADIUS);
    ctx.clip();
    ctx.drawImage(image, x, y, ICON_SIZE, ICON_SIZE);
    ctx.restore();
  } catch {
    // Keep fallback block if icon fetch/decoding fails.
  }
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

  for (let index = 0; index < SLOT_COUNT_PER_SIDE; index += 1) {
    const bx = leftStart + (index * (ICON_SIZE + ICON_GAP));
    const rx = rightStart + (index * (ICON_SIZE + ICON_GAP));
    await drawSlotIconOrFallback(ctx, blueIconUrls[index], bx, topY, BLUE_EMPTY);
    await drawSlotIconOrFallback(ctx, redIconUrls[index], rx, topY, RED_EMPTY);
  }

  return canvas.toBuffer('image/png');
}
