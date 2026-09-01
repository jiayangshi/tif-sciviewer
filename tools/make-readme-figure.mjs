#!/usr/bin/env node
/**
 * Build docs/example-auto.png: the same synthetic CT slice at full data range
 * and after ImageJ 'Auto'.
 *
 * The phantom is generated here rather than loaded from a scan, so the figure
 * ships without any research data attached. It reproduces the property that
 * makes real CT slices unreadable in a naive viewer: a large constant
 * background plateau that dominates the histogram.
 *
 *   node tools/make-readme-figure.mjs        (needs `npm run build` first)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

import { phantom } from './phantom.mjs';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { computeStats, autoAdjust, resetRange, mapTo8Bit, composeRGBA, getLut } = lib;

const W = 320, H = 320;

function panel(data, range, lut) {
  const idx = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  mapTo8Bit(data, range.min, range.max, idx, { mask });
  const rgba = new Uint8ClampedArray(W * H * 4);
  composeRGBA(idx, lut, rgba, mask);
  return rgba;
}

const data = phantom(W, H);
const stats = computeStats(data, 'float32');
const full = resetRange(stats);
const auto = autoAdjust(stats, 0).range;

const lut = getLut('Grays');
const left = panel(data, full, lut);
const right = panel(data, auto, lut);

// Compose: two panels, a gutter, a caption strip.
const GUT = 16, PAD = 16, CAP = 34;
const CW = PAD * 2 + W * 2 + GUT;
const CH = PAD + H + CAP;
const out = new Uint8ClampedArray(CW * CH * 4);
for (let i = 0; i < CW * CH; i++) {
  out[i * 4] = 246; out[i * 4 + 1] = 247; out[i * 4 + 2] = 249; out[i * 4 + 3] = 255;
}
const blit = (src, ox, oy) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, d = ((oy + y) * CW + ox + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255;
    }
  }
};
blit(left, PAD, PAD);
blit(right, PAD + W + GUT, PAD);

// Caption text, drawn from a compact 5x7 bitmap font (no font dependency).
const GLYPHS = {
  A:'01100100101111010011001',B:'11110100111110100111110',C:'0111010001100001000101110',
  D:'11110100011000110001111 ',E:'1111110000111101000011111',F:'1111110000111101000010000',
  G:'0111010000101110001001110',H:'1000110001111111000110001',I:'1110001000010000100011100',
  L:'1000010000100001000011111',M:'1000111011101011000110001',N:'1000111001101011001110001',
  O:'0111010001100011000101110',R:'1111010001111101001010001',S:'0111110000011100000111110',
  T:'1111100100001000010000100',U:'1000110001100011000101110',V:'1000110001100010101000100',
  W:'1000110001101011101110001',X:'1000101010001000101010001',Y:'1000101010001000010000100',
  Z:'1111100010001000100011111',
  '0':'0111010011101011100101110','1':'0010001100001000010001110','2':'0111010001000100100011111',
  '3':'1111000010001100000101110','4':'0001000110010101111100010','5':'1111110000111100000111110',
  '6':'0111010000111101000101110','7':'1111100010001000100001000','8':'0111010001011101000101110',
  '9':'0111010001011110000101110',
  '.':'0000000000000000011000110','-':'0000000000111110000000000',',':'0000000000000000110001000',
  ' ':'0000000000000000000000000','(':'0010001000010000100000100',')':'0100000100001000010001000',
  '=':'0000011111000001111100000','%':'1100111010001000101110011',':':'0011000110000000110001100',
};
function text(str, ox, oy, scale, rgb) {
  let x = ox;
  for (const ch of str.toUpperCase()) {
    const g = GLYPHS[ch];
    if (g) {
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
        if (g[r * 5 + c] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const px = x + c * scale + dx, py = oy + r * scale + dy;
          if (px < 0 || py < 0 || px >= CW || py >= CH) continue;
          const d = (py * CW + px) * 4;
          out[d] = rgb[0]; out[d + 1] = rgb[1]; out[d + 2] = rgb[2];
        }
      }
    }
    x += 6 * scale;
  }
}
const f = (v) => (Math.round(v * 1e4) / 1e4).toString();
const INK = [40, 44, 52], DIM = [120, 126, 136];
text('FULL RANGE', PAD, PAD + H + 9, 2, INK);
text(`MIN ${f(full.min)}  MAX ${f(full.max)}`, PAD, PAD + H + 22, 1, DIM);
text('AFTER AUTO', PAD + W + GUT, PAD + H + 9, 2, INK);
text(`MIN ${f(auto.min)}  MAX ${f(auto.max)}`, PAD + W + GUT, PAD + H + 22, 1, DIM);

fs.writeFileSync('docs/example-auto.png', encodePng(CW, CH, out));
console.log(`docs/example-auto.png  ${CW}x${CH}`);
console.log(`  full: [${f(full.min)}, ${f(full.max)}]`);
console.log(`  auto: [${f(auto.min)}, ${f(auto.max)}]`);

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
var TBL;
function crc32(buf) {
  if (!TBL) { TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c; } }
  let c = -1; for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ -1;
}
