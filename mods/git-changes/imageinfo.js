const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const isStartOfFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function pngSize(b) {
  return b.length >= 24 && ascii(b, 12, 16) === "IHDR" ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
}

function gifSize(b) {
  return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
}

function bmpSize(b) {
  return b.length >= 26 ? { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) } : null;
}

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (isStartOfFrame(marker)) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    i += marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + u16be(b, i + 2);
  }
  return null;
}

const WEBP_SIZES = {
  "VP8 ": (b) => ({ width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }),
  VP8L: (b) => ({ width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) }),
  VP8X: (b) => ({ width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }),
};

function webpSize(b) {
  const read = b.length >= 30 ? WEBP_SIZES[ascii(b, 12, 16)] : null;
  return read ? read(b) : null;
}

const SVG_LENGTH = /^\s*([0-9.]+)\s*(px)?\s*$/;

function svgLength(tag, name) {
  const value = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1];
  const match = value ? SVG_LENGTH.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function svgSize(b) {
  const tag = /<svg\b[^>]*>/i.exec(ascii(b, 0, Math.min(b.length, 4096)))?.[0];
  if (!tag) return null;
  const width = svgLength(tag, "width"), height = svgLength(tag, "height");
  if (width && height) return { width, height };
  const box = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag);
  return box ? { width: Number(box[1]), height: Number(box[2]) } : null;
}

const READERS = { png: pngSize, gif: gifSize, bmp: bmpSize, jpg: jpegSize, jpeg: jpegSize, webp: webpSize, svg: svgSize };

/** Pixel size read from an image's own bytes, or null when the format's header isn't understood. */
export function imageSize(bytes, type) {
  const size = READERS[type]?.(bytes) ?? null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** `size` scaled down, never up, to fit inside the box, with its proportions kept. */
export function fitSize(size, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** "512 B", "3.4 KB", "1.2 MB". */
export function formatBytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10240 ? 1 : 0)} KB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}
