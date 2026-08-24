import { loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { createHighResolutionCanvas } from './highResolutionCanvas.js';

const DEFAULT_SLOT_COUNT_PER_SIDE = 5;
// Dimensions and styling for the match-result thumbnail.
const BLUE_EMPTY = '#4B5563';
const LOADOUT_EMPTY = 'rgba(45, 55, 72, 0.55)';
const SLOT_RADIUS = 6;
const LOADOUT_RADIUS = 4;
const THUMBNAIL_ICON_SIZE = 96;
const THUMBNAIL_LOADOUT_ICON_SIZE = 24;
const THUMBNAIL_LOADOUT_ICON_GAP = 4;
const THUMBNAIL_LOADOUT_PADDING = 6;
const THUMBNAIL_LOADOUT_BACKDROP_PADDING = 4;
const THUMBNAIL_LOADOUT_BACKDROP_COLOR = 'rgba(20, 24, 34, 0.45)';

// Cache remote icon loads so a shared icon is fetched only once per process.
const ICON_IMAGE_CACHE_MAX_ENTRIES = 256;
const iconImageCache = new Map();

// Dimensions for the live-game card attached to Discord embeds.
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
const LIVE_CARD_BAN_X_COLOR = '#FF3D57';
const LIVE_CARD_BAN_X_SHADOW_COLOR = 'rgba(24, 8, 14, 0.78)';
const LIVE_CARD_BAN_PLACEHOLDER_PATH = fileURLToPath(new URL('../../assets/ban-placeholder.png', import.meta.url));

/**
 * Shortens text until it fits within the current canvas font's available width.
 *
 * @param {CanvasRenderingContext2D} ctx Canvas context with the intended font configured.
 * @param {unknown} value Text to render.
 * @param {number} maxWidth Maximum rendered width in pixels.
 * @returns {string} The original text, or an ellipsis-truncated equivalent.
 */
function truncateText(ctx, value, maxWidth) {
  const text = String(value ?? '').trim() || 'Unknown player';
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = '…';
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}${ellipsis}`).width > maxWidth) end -= 1;
  return end > 0 ? `${text.slice(0, end)}${ellipsis}` : ellipsis;
}

/**
 * Creates a reusable path for a rectangle with corners constrained to its bounds.
 */
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

/**
 * Fills a rounded rectangle using the supplied canvas color or gradient.
 */
function drawRoundedRect(ctx, x, y, w, h, r, fillStyle) {
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/**
 * Removes the least-recently inserted cache entries after a new image is added.
 */
function evictOldIconImageCacheEntries() {
  while (iconImageCache.size > ICON_IMAGE_CACHE_MAX_ENTRIES) {
    const oldestIconUrl = iconImageCache.keys().next().value;
    iconImageCache.delete(oldestIconUrl);
  }
}

/**
 * Loads an icon once and stores both pending requests and resolved images by URL.
 * Failed requests are removed so a later render may retry them.
 */
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

/**
 * Loads one optional icon without allowing a bad remote URL to fail the full card.
 */
async function loadIconResult(iconUrl) {
  if (!iconUrl) return null;
  const result = await Promise.resolve(loadIconImageCached(iconUrl)).then(
    (image) => ({ status: 'fulfilled', value: image }),
    () => ({ status: 'rejected', value: null }),
  );
  return result.status === 'fulfilled' ? result.value : null;
}

/**
 * Draws a clipped icon above a rounded fallback color when an image is available.
 */
function drawSlotIconOrFallback(ctx, image, x, y, size, radius, fallbackColor) {
  drawRoundedRect(ctx, x, y, size, size, radius, fallbackColor);
  if (!image) return;

  ctx.save();
  roundedRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

/**
 * Fetches a participant's champion, spell, and rune art in parallel.
 */
function getLoadoutIconUrls(participant) {
  return [
    ...(Array.isArray(participant?.spellIconUrls) ? participant.spellIconUrls : []),
    participant?.runeIconUrl ?? null,
  ].filter(Boolean).slice(0, 3);
}

async function loadParticipantImages(participant) {
  const loadoutIconUrls = getLoadoutIconUrls(participant);
  const loadChampionImage = async () => {
    const skinImage = await loadIconResult(participant?.championSkinTileUrl);
    return skinImage ?? loadIconResult(participant?.championIconUrl);
  };
  const [championImage, ...loadoutImages] = await Promise.all([
    loadChampionImage(),
    ...loadoutIconUrls.map((iconUrl) => loadIconResult(iconUrl)),
  ]);

  return { championImage, loadoutImages };
}

/**
 * Renders the square match-result thumbnail, overlaying the compact loadout row.
 */
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

/**
 * Creates the PNG thumbnail used on a completed-match embed.
 * Missing or inaccessible icon art is represented with the configured fallback colors.
 */
export async function buildParticipantLoadoutThumbnailBuffer(participant = {}) {
  const { canvas, ctx } = createHighResolutionCanvas(THUMBNAIL_ICON_SIZE, THUMBNAIL_ICON_SIZE);
  const images = await loadParticipantImages(participant);

  drawParticipantThumbnail(ctx, { images, x: 0, y: 0 });

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

/**
 * Draws the question-mark placeholder used for unavailable live-card icon art.
 */
/**
 * Draws a rounded live-card icon, or a placeholder when its art is unavailable.
 */
function drawLiveCardIcon(ctx, image, x, y, size) {
  if (!image) {
    drawLiveCardFallback(ctx, x, y, size);
    return;
  }

  ctx.save();
  roundedRectPath(ctx, x, y, size, size, 6);
  ctx.clip();
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

/**
 * Draws a high-contrast X over a banned champion while preserving the icon beneath it. TODO: Make the X slightly transparent so that the champion icon is still visible behind it. The X should be centered within the square and have a slight shadow to make it stand out against the champion icon.
 */
function drawBanMarker(ctx, x, y, size) {
  ctx.globalAlpha = 0.5;
  const inset = Math.round(size * 0.15);
  const lineWidth = Math.max(4, Math.round(size * 0.1));

  ctx.save();
  roundedRectPath(ctx, x, y, size, size, 6);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineWidth = lineWidth + 4;
  ctx.strokeStyle = LIVE_CARD_BAN_X_SHADOW_COLOR;
  ctx.beginPath();
  ctx.moveTo(x + inset, y + inset);
  ctx.lineTo(x + size - inset, y + size - inset);
  ctx.moveTo(x + size - inset, y + inset);
  ctx.lineTo(x + inset, y + size - inset);
  ctx.stroke();
  

  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = LIVE_CARD_BAN_X_COLOR;
  ctx.beginPath();
  ctx.moveTo(x + inset, y + inset);
  ctx.lineTo(x + size - inset, y + size - inset);
  ctx.moveTo(x + size - inset, y + inset);
  ctx.lineTo(x + inset, y + size - inset);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1.0;
}

/**
 * Renders one player row, including its team accent, champion, loadout, name, and ban.
 */
function drawLiveTeamRow(ctx, { participant, images, ban, banImage, x, y, width, accent }) {
  drawRoundedRect(ctx, x, y, width, LIVE_CARD_ROW_HEIGHT - 8, 10, '#202735');
  drawRoundedRect(ctx, x, y, 5, LIVE_CARD_ROW_HEIGHT - 8, 3, accent);

  const championX = x + 20;
  const championY = y + 16;
  drawLiveCardIcon(ctx, images?.championImage, championX, championY, LIVE_CARD_CHAMPION_SIZE);

  const loadoutX = championX + LIVE_CARD_CHAMPION_SIZE + 10;
  drawLiveCardIcon(ctx, images?.loadoutImages?.[0], loadoutX, championY, LIVE_CARD_LOADOUT_SIZE);
  drawLiveCardIcon(ctx, images?.loadoutImages?.[1], loadoutX, championY + LIVE_CARD_LOADOUT_SIZE + 7, LIVE_CARD_LOADOUT_SIZE);
  drawLiveCardIcon(ctx, images?.loadoutImages?.[2], loadoutX + LIVE_CARD_LOADOUT_SIZE + 9, championY + 17, LIVE_CARD_RUNE_SIZE);

  const banX = x + width - 20 - LIVE_CARD_CHAMPION_SIZE;
  const nameX = loadoutX + (LIVE_CARD_LOADOUT_SIZE * 2) + 28;
  const textWidth = banX - nameX - 18;
  const playerName = participant?.riotId || participant?.summonerName || 'Unknown player';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#F4F7FB';
  ctx.font = '700 22px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncateText(ctx, playerName, textWidth), nameX, y + 43);
  drawLiveCardIcon(ctx, banImage, banX, championY, LIVE_CARD_CHAMPION_SIZE);
  if (Number(ban?.championId) > 0) drawBanMarker(ctx, banX, championY, LIVE_CARD_CHAMPION_SIZE);
}

/**
 * Builds a mobile-legible live-match PNG from buildLolLiveTeamPresentationModel.
 * Each side is always rendered with five rows so incomplete live-game data preserves the layout.
 */
export async function buildLolLiveMatchCardBuffer(model = {}) {
  const { canvas, ctx } = createHighResolutionCanvas(LIVE_CARD_WIDTH, LIVE_CARD_HEIGHT);
  const blueParticipants = Array.isArray(model?.sides?.blue) ? model.sides.blue.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const redParticipants = Array.isArray(model?.sides?.red) ? model.sides.red.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const blueBans = Array.isArray(model?.sides?.blueBans) ? model.sides.blueBans.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const redBans = Array.isArray(model?.sides?.redBans) ? model.sides.redBans.slice(0, DEFAULT_SLOT_COUNT_PER_SIDE) : [];
  const slots = [...blueParticipants, ...redParticipants];
  const [imageSets, banImages] = await Promise.all([
    Promise.all(slots.map((participant) => loadParticipantImages(participant))),
    Promise.all([...blueBans, ...redBans].map((ban) => loadIconResult(
      ban?.isPlaceholder ? LIVE_CARD_BAN_PLACEHOLDER_PATH : ban?.championIconUrl,
    ))),
  ]);

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

  const blueX = LIVE_CARD_PADDING;
  const redX = blueX + LIVE_CARD_PANEL_WIDTH + LIVE_CARD_GUTTER;
  const sectionY = LIVE_CARD_HEADER_HEIGHT + 19;
  for (const [label, x, color] of [
    ['BLUE TEAM', blueX + 20, '#4CA7FF'],
    ['RED TEAM', redX + 20, '#FF657C'],
  ]) {
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.font = '700 17px sans-serif';
    ctx.fillText(label, x, sectionY);
  }

  for (const x of [blueX, redX]) {
    const banColumnCenter = x + LIVE_CARD_PANEL_WIDTH - 20 - (LIVE_CARD_CHAMPION_SIZE / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#B9C3D5';
    ctx.font = '700 17px sans-serif';
    ctx.fillText('BANS', banColumnCenter, sectionY);
  }

  for (let index = 0; index < DEFAULT_SLOT_COUNT_PER_SIDE; index += 1) {
    const rowY = LIVE_CARD_HEADER_HEIGHT + 36 + (index * LIVE_CARD_ROW_HEIGHT);
    drawLiveTeamRow(ctx, {
      participant: blueParticipants[index], images: imageSets[index], ban: blueBans[index], banImage: banImages[index], x: blueX, y: rowY,
      width: LIVE_CARD_PANEL_WIDTH, accent: '#358FFF',
    });
    drawLiveTeamRow(ctx, {
      participant: redParticipants[index], images: imageSets[blueParticipants.length + index], ban: redBans[index], banImage: banImages[blueBans.length + index], x: redX, y: rowY,
      width: LIVE_CARD_PANEL_WIDTH, accent: '#ED4F6A',
    });
  }

  return canvas.toBuffer('image/png');
}
