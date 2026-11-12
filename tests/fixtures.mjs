// Small real images for the tests: a PNG of any size and colour, and the headers of the other formats.
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

export function png(width, height, [r, g, b]) {
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height), header = Buffer.alloc(13);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([r, g, b], y * stride + 1 + x * 3);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const gif = (width, height) => Buffer.from([...Buffer.from("GIF89a"), width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0]);

export const jpeg = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);

export const webpLossless = (width, height) => {
  const w = width - 1, h = height - 1, bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0); bytes.write("WEBP", 8); bytes.write("VP8L", 12);
  bytes[20] = 0x2f; bytes[21] = w & 255; bytes[22] = ((w >> 8) & 0x3f) | ((h & 3) << 6); bytes[23] = (h >> 2) & 255; bytes[24] = (h >> 10) & 0x0f;
  return bytes;
};

export const svgText = (width, height) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#c33"/></svg>\n`;
