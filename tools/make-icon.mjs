#!/usr/bin/env node
/**
 * Generate the marketplace icon: a CT-like slice above a display-range ramp,
 * which is what the extension is about. Deterministic, so it can be regenerated
 * rather than being a mystery binary in the repo.
 *
 *   node tools/make-icon.mjs icon.png [size]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const out = process.argv[2] ?? 'icon.png';
const S = Number(process.argv[3] ?? 256);
const px = new Uint8ClampedArray(S * S * 4);

const BG = [24, 27, 33];
const set = (x, y, r, g, b) => {
  const p = (y * S + x) * 4;
  px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Rounded-square background.
const R = S * 0.18;
const inRounded = (x, y) => {
  const dx = Math.max(R - x, 0, x - (S - 1 - R));
  const dy = Math.max(R - y, 0, y - (S - 1 - R));
  return dx * dx + dy * dy <= R * R;
};

const cx = S / 2;
const cy = S * 0.42;
const outer = S * 0.30;
const ring = S * 0.255;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRounded(x + 0.5, y + 0.5)) { px[(y * S + x) * 4 + 3] = 0; continue; }
    let c = BG;

    // The slice: bright cortical ring, soft interior falloff, dark air.
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < outer) {
      const edge = Math.min(1, (outer - d) / (S * 0.012));
      const ringness = Math.exp(-(((d - ring) / (S * 0.022)) ** 2));
      const soft = 0.30 + 0.34 * Math.exp(-((d / (ring * 0.78)) ** 2));
      const v = Math.min(1, soft + 0.72 * ringness);
      const g = Math.round(255 * v);
      c = mix(BG, [g, g, g], edge);
    }

    // Display-range ramp along the bottom, with the selected window picked out.
    const barTop = S * 0.795;
    const barBot = S * 0.895;
    if (y >= barTop && y < barBot) {
      const inset = S * 0.13;
      const barW = S - 2 * inset;
      if (x >= inset && x < S - inset) {
        const t = (x - inset) / barW;
        const lo = 0.30;
        const hi = 0.78;
        // Outside the window is flat black/white; inside is the live ramp.
        const v = t < lo ? 0 : t > hi ? 1 : (t - lo) / (hi - lo);
        const g = Math.round(255 * v);
        c = [g, g, g];
        // The two window markers, two pixels wide in bar-relative units.
        const half = 1.5 / barW;
        if (Math.abs(t - lo) < half || Math.abs(t - hi) < half) c = [90, 170, 255];
      }
    }
    set(x, y, c[0] | 0, c[1] | 0, c[2] | 0);
  }
}

fs.writeFileSync(out, encodePng(S, S, px));
console.log(`wrote ${out} (${S}x${S})`);

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function crcTable() {
  if (!crcTable.cached) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    crcTable.cached = t;
  }
  return crcTable.cached;
}
function crc32(buf) { const t = crcTable(); let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ -1; }
