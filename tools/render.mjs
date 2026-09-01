#!/usr/bin/env node
/**
 * Render a TIFF through the same pipeline the webview uses and write a PNG.
 * This is how the viewer's output gets eyeballed without launching VS Code.
 *
 *   node tools/render.mjs <file.tif> <out.png> [--mode auto|enhance|reset|min,max]
 *                         [--lut Grays] [--page 0] [--auto-presses N]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TiffFile, BufferReader, computeStats, autoAdjust, stretchHistogram, resetRange,
  getLut, mapTo8Bit, composeRGBA, renderColor, formatValue,
} = require('../dist/lib.cjs');

const args = process.argv.slice(2);
const input = args[0];
const output = args[1];
if (!input || !output) {
  console.error('usage: render.mjs <in.tif> <out.png> [--mode auto|enhance|reset|min,max] [--lut NAME] [--page N] [--auto-presses N]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const mode = flag('mode', 'auto');
const lutName = flag('lut', 'Grays');
const page = Number(flag('page', '0'));
const presses = Number(flag('auto-presses', '1'));

const tif = new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(input))));
const decoded = tif.decode(page);
const stats = computeStats(decoded.data, decoded.dtype, decoded.samplesPerPixel);

let range;
if (mode === 'auto') {
  let at = 0;
  for (let i = 0; i < presses; i++) { const r = autoAdjust(stats, at); at = r.autoThreshold; range = r.range; }
} else if (mode === 'enhance') {
  range = stretchHistogram(stats, Number(flag('saturated', '0.35')));
} else if (mode === 'reset') {
  range = resetRange(stats);
} else if (mode.includes(',')) {
  const [a, b] = mode.split(',').map(Number);
  range = { min: a, max: b };
} else {
  throw new Error(`unknown mode: ${mode}`);
}

const { width, height, samplesPerPixel } = decoded;
const rgba = new Uint8ClampedArray(width * height * 4);
if (samplesPerPixel >= 3) {
  renderColor(decoded.data, samplesPerPixel, range.min, range.max, rgba);
} else {
  const idx = new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  mapTo8Bit(decoded.data, range.min, range.max, idx, { mask });
  composeRGBA(idx, getLut(lutName), rgba, mask, [255, 64, 64]);
}

fs.writeFileSync(output, encodePng(width, height, rgba));

const isF = decoded.dtype.startsWith('float');
console.log(`${input} page ${page}: ${width}x${height} ${decoded.dtype} spp=${samplesPerPixel}`);
console.log(`  data    [${formatValue(stats.min, isF)}, ${formatValue(stats.max, isF)}]  mean=${formatValue(stats.mean, true)} sd=${formatValue(stats.stdDev, true)}`);
console.log(`  ${mode.padEnd(7)} [${formatValue(range.min, isF)}, ${formatValue(range.max, isF)}]  lut=${lutName}`);
console.log(`  wrote ${output}`);

/** Minimal PNG writer: one IDAT of zlib-compressed filter-0 scanlines. */
function encodePng(w, h, rgbaData) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0; // filter type: none
    Buffer.from(rgbaData.buffer, rgbaData.byteOffset + y * w * 4, w * 4).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// A hoisted function declaration, so this is usable from the top-level
// statements above without tripping over temporal dead zone.
function crcTable() {
  if (!crcTable.cached) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crcTable.cached = t;
  }
  return crcTable.cached;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
