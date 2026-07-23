import { Canvas, loadImage } from '@napi-rs/canvas';

const DEFAULT_SLOT_COUNT_PER_SIDE = 5;
const ICON_SIZE = 48;
const LOADOUT_ICON_SIZE = 18;
const LOADOUT_ICON_GAP = 3;
const ICON_GAP = 8;
const SIDE_PADDING_X = 16;
const CANVAS_PADDING_Y = 12;
const VS_WIDTH = 42;

const BACKGROUND_COLOR = '#141822';
const VS_BACKGROUND = '#21283A';
const BLUE_EMPTY = '#4B5563';
const RED_EMPTY = '#4B5563';
const LOADOUT_EMPTY = 'rgba(45, 55, 72, 0.55)';
const SLOT_RADIUS = 6;
const LOADOUT_RADIUS = 4;
const THUMBNAIL_ICON_SIZE = 96;
const THUMBNAIL_LOADOUT_ICON_SIZE = 24;
const THUMBNAIL_LOADOUT_ICON_GAP = 4;
const THUMBNAIL_LOADOUT_PADDING = 6;
const THUMBNAIL_LOADOUT_BACKDROP_PADDING = 4;
const THUMBNAIL_LOADOUT_BACKDROP_COLOR = 'rgba(20, 24, 34, 0.45)';
const ICON_IMAGE_CACHE_MAX_ENTRIES = 256;
const iconImageCache = new Map();

const LIVE_CARD_WIDTH = 1320;
const LIVE_CARD_HEIGHT = 760;
const LIVE_CARD_PADDING = 32;
const LIVE_CARD_HEADER_HEIGHT = 98;
const LIVE_CARD_ROW_HEIGHT = 112;
const LIVE_CARD_GUTTER = 18;
const LIVE_CARD_PANEL_WIDTH = (LIVE_CARD_WIDTH - (LIVE_CARD_PADDING * 2) - LIVE_CARD_GUTTER) / 2;
const LIVE_CARD_CHAMPION_SIZE = 64;
const LIVE_CARD_LOADOUT_SIZE = 26;
const LIVE_CARD_RUNE_SIZE = 30;

function truncateText(ctx, value, maxWidth) {
  const text = String(value ?? '').trim() || 'Unknown player';
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = '…';
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}${ellipsis}`).width > maxWidth) end -= 1;
  return end > 0 ? `${text.slice(0, end)}${ellipsis}` : ellipsis;
}

function formatLiveElapsedTime(gameStartEpochSeconds, now = Date.now()) {
  const startSeconds = Number(gameStartEpochSeconds);
  if (!Number.isFinite(startSeconds) || startSeconds <= 0) return '--:--';

  const elapsedSeconds = Math.max(0, Math.floor((now / 1000) - startSeconds));
  const minutes = Math.floor(elapsedSeconds / 60);
  return `${minutes}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
}

function normalizeParticipantSlots({ participants, iconUrls, slotCount }) {
  const explicitParticipants = Array.isArray(participants) ? participants : [];
  if (explicitParticipants.length > 0) {
    return explicitParticipants.slice(0, slotCount);
  }

  return (Array.isArray(iconUrls) ? iconUrls : [])
    .slice(0, slotCount)
    .map((championIconUrl) => ({ championIconUrl }));
}

function getLiveDraftStripLayout({ slotCountPerSide = DEFAULT_SLOT_COUNT_PER_SIDE, showVersus = true, includeRightSide = true } = {}) {
  const sideWidth = (slotCountPerSide * ICON_SIZE) + ((slotCountPerSide - 1) * ICON_GAP);
  const centerWidth = showVersus ? VS_WIDTH : 0;
  const rightSideWidth = includeRightSide ? sideWidth : 0;
  const width = (SIDE_PADDING_X * 2) + sideWidth + centerWidth + rightSideWidth;
  const height = (CANVAS_PADDING_Y * 2) + ICON_SIZE + LOADOUT_ICON_GAP + LOADOUT_ICON_SIZE;
  return { width, height, sideWidth, centerWidth };
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

async function loadIconResult(iconUrl) {
  if (!iconUrl) return null;
  const result = await Promise.resolve(loadIconImageCached(iconUrl)).then(
    (image) => ({ status: 'fulfilled', value: image }),
    () => ({ status: 'rejected', value: null }),
  );
  return result.status === 'fulfilled' ? result.value : null;
}

function drawSlotIconOrFallback(ctx, image, x, y, size, radius, fallbackColor) {
  drawRoundedRect(ctx, x, y, size, size, radius, fallbackColor);
  if (!image) return;

  ctx.save();
  roundedRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

function getLoadoutIconUrls(participant) {
  return [
    ...(Array.isArray(participant?.spellIconUrls) ? participant.spellIconUrls : []),
    participant?.runeIconUrl ?? null,
  ].filter(Boolean).slice(0, 3);
}

async function loadParticipantImages(participant) {
  const loadoutIconUrls = getLoadoutIconUrls(participant);
  const [championImage, ...loadoutImages] = await Promise.all([
    loadIconResult(participant?.championIconUrl),
    ...loadoutIconUrls.map((iconUrl) => loadIconResult(iconUrl)),
  ]);

  return { championImage, loadoutImages };
}

function drawParticipantSlot(ctx, { images, x, y, fallbackColor }) {
  drawSlotIconOrFallback(ctx, images?.championImage, x, y, ICON_SIZE, SLOT_RADIUS, fallbackColor);

  const loadoutY = y + ICON_SIZE + LOADOUT_ICON_GAP;
  const totalLoadoutWidth = (3 * LOADOUT_ICON_SIZE) + (2 * LOADOUT_ICON_GAP);
  const loadoutStartX = Math.floor(x + ((ICON_SIZE - totalLoadoutWidth) / 2));

  for (let index = 0; index < 3; index += 1) {
    const iconX = loadoutStartX + (index * (LOADOUT_ICON_SIZE + LOADOUT_ICON_GAP));
    drawSlotIconOrFallback(
      ctx,
      images?.loadoutImages?.[index] ?? null,
      iconX,
      loadoutY,
      LOADOUT_ICON_SIZE,
      LOADOUT_RADIUS,
      LOADOUT_EMPTY,
    );
  }
}

function drawParticipantThumbnail(ctx, { images, x, y }) {
  drawSlotIconOrFallback(ctx, images?.championImage, x, y, THUMBNAIL_ICON_SIZE, SLOT_RADIUS, BLUE_EMPTY);

  const loadoutIconCount = 3;
  const totalLoadoutWidth = (loadoutIconCount * THUMBNAIL_LOADOUT_ICON_SIZE)
    + ((loadoutIconCount - 1) * THUMBNAIL_LOADOUT_ICON_GAP);
  const loadoutStartX = Math.floor(x + ((THUMBNAIL_ICON_SIZE - totalLoadoutWidth) / 2));
  const loadoutY = y + THUMBNAIL_ICON_SIZE - THUMBNAIL_LOADOUT_PADDING - THUMBNAIL_LOADOUT_ICON_SIZE;

  drawRoundedRect(
    ctx,
    loadoutStartX - THUMBNAIL_LOADOUT_BACKDROP_PADDING,
    loadoutY - THUMBNAIL_LOADOUT_BACKDROP_PADDING,
    totalLoadoutWidth + (THUMBNAIL_LOADOUT_BACKDROP_PADDING * 2),
    THUMBNAIL_LOADOUT_ICON_SIZE + (THUMBNAIL_LOADOUT_BACKDROP_PADDING * 2),
    LOADOUT_RADIUS + THUMBNAIL_LOADOUT_BACKDROP_PADDING,
    THUMBNAIL_LOADOUT_BACKDROP_COLOR,
  );

  for (let index = 0; index < loadoutIconCount; index += 1) {
    const iconX = loadoutStartX + (index * (THUMBNAIL_LOADOUT_ICON_SIZE + THUMBNAIL_LOADOUT_ICON_GAP));
    drawSlotIconOrFallback(
      ctx,
      images?.loadoutImages?.[index] ?? null,
      iconX,
      loadoutY,
      THUMBNAIL_LOADOUT_ICON_SIZE,
      LOADOUT_RADIUS,
      LOADOUT_EMPTY,
    );
  }
}

export async function buildParticipantLoadoutThumbnailBuffer(participant = {}) {
  const canvas = new Canvas(THUMBNAIL_ICON_SIZE, THUMBNAIL_ICON_SIZE);
  const ctx = canvas.getContext('2d');
  const images = await loadParticipantImages(participant);

  drawParticipantThumbnail(ctx, { images, x: 0, y: 0 });

  return canvas.toBuffer('image/png');
}

export async function buildLiveDraftImageBuffer({
  blueIconUrls = [],
  redIconUrls = [],
  blueParticipants = null,
  redParticipants = null,
  slotCountPerSide = DEFAULT_SLOT_COUNT_PER_SIDE,
  showVersus = true,
} = {}) {
  const blueSlots = normalizeParticipantSlots({ participants: blueParticipants, iconUrls: blueIconUrls, slotCount: slotCountPerSide });
  const redSlots = normalizeParticipantSlots({ participants: redParticipants, iconUrls: redIconUrls, slotCount: slotCountPerSide });
  const includeRightSide = showVersus || redSlots.length > 0;
  const { width, height, sideWidth, centerWidth } = getLiveDraftStripLayout({ slotCountPerSide, showVersus, includeRightSide });
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);
  if (showVersus) {
    ctx.fillStyle = VS_BACKGROUND;
    ctx.fillRect(SIDE_PADDING_X + sideWidth, 0, VS_WIDTH, height);
  }
  const topY = CANVAS_PADDING_Y;
  const leftStart = SIDE_PADDING_X;
  const rightStart = SIDE_PADDING_X + sideWidth + centerWidth;

  const [blueImageSets, redImageSets] = await Promise.all([
    Promise.all(blueSlots.map((participant) => loadParticipantImages(participant))),
    Promise.all(redSlots.map((participant) => loadParticipantImages(participant))),
  ]);

  for (let index = 0; index < slotCountPerSide; index += 1) {
    const bx = leftStart + (index * (ICON_SIZE + ICON_GAP));
    const rx = rightStart + (index * (ICON_SIZE + ICON_GAP));
    drawParticipantSlot(ctx, {
      images: blueImageSets[index] ?? null,
      x: bx,
      y: topY,
      fallbackColor: BLUE_EMPTY,
    });
    if (includeRightSide) {
      drawParticipantSlot(ctx, {
        images: redImageSets[index] ?? null,
        x: rx,
        y: topY,
        fallbackColor: RED_EMPTY,
      });
    }
  }

  return canvas.toBuffer('image/png');
}

function drawLiveCardFallback(ctx, x, y, size) {
  drawRoundedRect(ctx, x, y, size, size, 6, '#394150');
  ctx.fillStyle = '#9DA9BC';
  ctx.font = `700 ${Math.round(size * 0.42)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', x + (size / 2), y + (size / 2) + 1);
}

function drawLiveCardIcon(ctx, image, x, y, size, fallback = true) {
  if (!image && fallback) {
    drawLiveCardFallback(ctx, x, y, size);
    return;
  }
  if (!image) return;

  ctx.save();
  roundedRectPath(ctx, x, y, size, size, 6);
  ctx.clip();
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

function drawLiveTeamRow(ctx, { participant, images, x, y, width, accent, side }) {
  const isRed = side === 'red';
  drawRoundedRect(ctx, x, y, width, LIVE_CARD_ROW_HEIGHT - 8, 10, '#202735');
  drawRoundedRect(ctx, x, y, 5, LIVE_CARD_ROW_HEIGHT - 8, 3, accent);

  const championX = x + 20;
  const championY = y + 16;
  drawLiveCardIcon(ctx, images?.championImage, championX, championY, LIVE_CARD_CHAMPION_SIZE);

  const loadoutX = championX + LIVE_CARD_CHAMPION_SIZE + 10;
  drawLiveCardIcon(ctx, images?.loadoutImages?.[0], loadoutX, championY, LIVE_CARD_LOADOUT_SIZE);
  drawLiveCardIcon(ctx, images?.loadoutImages?.[1], loadoutX, championY + LIVE_CARD_LOADOUT_SIZE + 7, LIVE_CARD_LOADOUT_SIZE);
  drawLiveCardIcon(ctx, images?.loadoutImages?.[2], loadoutX + LIVE_CARD_LOADOUT_SIZE + 9, championY + 17, LIVE_CARD_RUNE_SIZE);

  const nameX = loadoutX + (LIVE_CARD_LOADOUT_SIZE * 2) + 28;
  const textWidth = width - (nameX - x) - 18;
  const playerName = participant?.riotId || participant?.summonerName || 'Unknown player';
  ctx.textAlign = isRed ? 'right' : 'left';
  const alignedNameX = isRed ? x + width - 18 : nameX;
  ctx.fillStyle = '#F4F7FB';
  ctx.font = '700 22px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncateText(ctx, playerName, textWidth), alignedNameX, y + 43);
}

/**
 * Builds a mobile-legible 16:9-ish live match card from buildLolLiveTeamPresentationModel.
 */
export async function buildLolLiveMatchCardBuffer(model = {}) {
  const canvas = new Canvas(LIVE_CARD_WIDTH, LIVE_CARD_HEIGHT);
  const ctx = canvas.getContext('2d');
  const blueParticipants = Array.isArray(model?.sides?.blue) ? model.sides.blue.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const redParticipants = Array.isArray(model?.sides?.red) ? model.sides.red.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const slots = [...blueParticipants, ...redParticipants];
  const imageSets = await Promise.all(slots.map((participant) => loadParticipantImages(participant)));

  ctx.fillStyle = '#111622';
  ctx.fillRect(0, 0, LIVE_CARD_WIDTH, LIVE_CARD_HEIGHT);
  ctx.fillStyle = '#182031';
  ctx.fillRect(0, 0, LIVE_CARD_WIDTH, LIVE_CARD_HEADER_HEIGHT);
  ctx.fillStyle = '#2A354B';
  ctx.fillRect(0, LIVE_CARD_HEADER_HEIGHT - 1, LIVE_CARD_WIDTH, 1);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#F6F8FC';
  ctx.font = '700 30px sans-serif';
  ctx.fillText(truncateText(ctx, model?.queueLabel || 'League of Legends', 720), LIVE_CARD_PADDING, 40);

  drawRoundedRect(ctx, LIVE_CARD_PADDING, 57, 76, 28, 14, '#1FAD72');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 15px sans-serif';
  ctx.fillText('LIVE', LIVE_CARD_PADDING + 38, 71);
  const blueX = LIVE_CARD_PADDING;
  const redX = blueX + LIVE_CARD_PANEL_WIDTH + LIVE_CARD_GUTTER;
  const sectionY = LIVE_CARD_HEADER_HEIGHT + 19;
  for (const [label, x, color, align] of [
    ['BLUE TEAM', blueX, '#4CA7FF', 'left'],
    ['RED TEAM', redX, '#FF657C', 'right'],
  ]) {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.font = '700 17px sans-serif';
    ctx.fillText(label, align === 'right' ? x + LIVE_CARD_PANEL_WIDTH : x, sectionY);
  }

  for (let index = 0; index < DEFAULT_SLOT_COUNT_PER_SIDE; index += 1) {
    const rowY = LIVE_CARD_HEADER_HEIGHT + 36 + (index * LIVE_CARD_ROW_HEIGHT);
    drawLiveTeamRow(ctx, {
      participant: blueParticipants[index], images: imageSets[index], x: blueX, y: rowY,
      width: LIVE_CARD_PANEL_WIDTH, accent: '#358FFF', side: 'blue',
    });
    drawLiveTeamRow(ctx, {
      participant: redParticipants[index], images: imageSets[blueParticipants.length + index], x: redX, y: rowY,
      width: LIVE_CARD_PANEL_WIDTH, accent: '#ED4F6A', side: 'red',
    });
  }

  return canvas.toBuffer('image/png');
}
