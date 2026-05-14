import zlib from "node:zlib";

const SLOT_COUNT_PER_SIDE = 5;
const ICON_SIZE = 48;
const ICON_GAP = 8;
const SIDE_PADDING_X = 16;
const CANVAS_PADDING_Y = 12;
const VS_WIDTH = 42;

export function getLiveDraftStripLayout() {
  const sideWidth = (SLOT_COUNT_PER_SIDE * ICON_SIZE) + ((SLOT_COUNT_PER_SIDE - 1) * ICON_GAP);
  const width = (SIDE_PADDING_X * 2) + sideWidth + VS_WIDTH + sideWidth;
  const height = (CANVAS_PADDING_Y * 2) + ICON_SIZE;
  return { width, height, sideWidth };
}

function makeRgba(width, height, color = [20, 24, 34, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = color[3];
  }
  return data;
}

function rect(data, width, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const o = ((yy * width) + xx) * 4;
      data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = color[3];
    }
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng({ width, height, rgba }) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

export async function buildLiveDraftImageBuffer({ blueIconUrls = [], redIconUrls = [] }) {
  const { width, height, sideWidth } = getLiveDraftStripLayout();
  const rgba = makeRgba(width, height);
  const topY = CANVAS_PADDING_Y;
  const leftStart = SIDE_PADDING_X;
  const rightStart = SIDE_PADDING_X + sideWidth + VS_WIDTH;

  rect(rgba, width, SIDE_PADDING_X + sideWidth, 0, VS_WIDTH, height, [33, 40, 58, 255]);

  for (let index = 0; index < SLOT_COUNT_PER_SIDE; index += 1) {
    const bx = leftStart + (index * (ICON_SIZE + ICON_GAP));
    const rx = rightStart + (index * (ICON_SIZE + ICON_GAP));
    const blueColor = blueIconUrls[index] ? [52, 123, 232, 255] : [75, 85, 99, 255];
    const redColor = redIconUrls[index] ? [219, 68, 55, 255] : [75, 85, 99, 255];
    rect(rgba, width, bx, topY, ICON_SIZE, ICON_SIZE, blueColor);
    rect(rgba, width, rx, topY, ICON_SIZE, ICON_SIZE, redColor);
  }

  return encodePng({ width, height, rgba });
}
