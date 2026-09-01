#!/usr/bin/env node
/**
 * Write sample.tif: a synthetic float32 CT slice for trying the viewer out.
 *
 * A fresh clone has no .tif in it - the repository deliberately ships no
 * research data - so this gives F5 something to open. It is written the way
 * tifffile writes: little-endian, uncompressed, single strip, SampleFormat 3.
 */
import fs from 'node:fs';
import { phantom } from './phantom.mjs';

const W = 512, H = 512;
const out = process.argv[2] ?? 'sample.tif';
const pixels = phantom(W, H);

const DESC = Buffer.from(`{"shape": [${H}, ${W}]}\0`, 'ascii');
const SOFT = Buffer.from('tif-sciviewer\0', 'ascii');
const tags = [
  [256, 4, 1, W], [257, 4, 1, H], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1],
  [270, 2, DESC.length, null], [273, 4, 1, null], [277, 3, 1, 1], [278, 4, 1, H],
  [279, 4, 1, W * H * 4], [305, 2, SOFT.length, null], [339, 3, 1, 3],
];
const IFD_OFFSET = 8;
const ifdSize = 2 + tags.length * 12 + 4;
let extra = IFD_OFFSET + ifdSize;
const descOffset = extra; extra += DESC.length;
const softOffset = extra; extra += SOFT.length;
const dataOffset = extra + (extra % 2);

const head = Buffer.alloc(dataOffset);
head.write('II', 0, 'ascii');
head.writeUInt16LE(42, 2);
head.writeUInt32LE(IFD_OFFSET, 4);
head.writeUInt16LE(tags.length, IFD_OFFSET);

tags.forEach(([tag, type, count, value], i) => {
  const o = IFD_OFFSET + 2 + i * 12;
  head.writeUInt16LE(tag, o);
  head.writeUInt16LE(type, o + 2);
  head.writeUInt32LE(count, o + 4);
  let v = value;
  if (tag === 270) v = descOffset;
  else if (tag === 305) v = softOffset;
  else if (tag === 273) v = dataOffset;
  // SHORT values that fit inline sit in the low half of the value field.
  if (type === 3 && count === 1) head.writeUInt16LE(v, o + 8);
  else head.writeUInt32LE(v, o + 8);
});
head.writeUInt32LE(0, IFD_OFFSET + 2 + tags.length * 12); // no next IFD
DESC.copy(head, descOffset);
SOFT.copy(head, softOffset);

const body = Buffer.alloc(W * H * 4);
for (let i = 0; i < pixels.length; i++) body.writeFloatLE(pixels[i], i * 4);

fs.writeFileSync(out, Buffer.concat([head, body]));
let lo = Infinity, hi = -Infinity;
for (const v of pixels) { if (v < lo) lo = v; if (v > hi) hi = v; }
console.log(`wrote ${out}  ${W}x${H} float32  range [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
