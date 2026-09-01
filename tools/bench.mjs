#!/usr/bin/env node
/** Time the full open -> decode -> stats -> encode -> render path. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  SliceSource, computeStats, autoAdjust, mapTo8Bit, composeRGBA, getLut, viewOf, fromBase64,
} = require('../dist/lib.cjs');
const { FileByteReader } = require('./fileReader.cjs');

const ms = f => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const mb = n => (n / 1048576).toFixed(1);

for (const file of process.argv.slice(2)) {
  const size = fs.statSync(file).size;
  const [tOpen, src] = ms(() => new SliceSource(new FileByteReader(file), 64 * 1024 * 1024, 4096 * 1024 * 1024));
  const m = src.meta;
  console.log(`\n${file.split('/').pop()}  ${mb(size)} MB on disk, ${src.pageCount} page(s), ` +
    `${m.width}x${m.height} ${m.dtype}, ${m.compressionName}`);
  console.log(`  open (headers only)      ${tOpen.toFixed(1)} ms`);

  const [tDecode, slice] = ms(() => src.getSlice(0));
  console.log(`  decode page 0            ${tDecode.toFixed(1)} ms   (${mb(slice.data.byteLength)} MB decoded)`);

  const [tStats] = ms(() => computeStats(slice.data, m.dtype, m.samplesPerPixel));
  console.log(`  statistics + histogram   ${tStats.toFixed(1)} ms`);

  const [tPayload, payload] = ms(() => src.payload(0));
  console.log(`  base64 for the webview   ${tPayload.toFixed(1)} ms   (${mb(payload.base64.length)} MB on the wire)`);

  const [tView, data] = ms(() => viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian));
  console.log(`  webview-side decode      ${tView.toFixed(1)} ms`);

  const px = m.width * m.height;
  const idx = new Uint8Array(px), mask = new Uint8Array(px), rgba = new Uint8ClampedArray(px * 4);
  const range = autoAdjust(slice.stats, 0).range;
  const clean = slice.stats.nonFiniteCount === 0;
  const [tMap] = ms(() => {
    mapTo8Bit(data, range.min, range.max, idx, { assumeFinite: clean, mask: clean ? undefined : mask });
    composeRGBA(idx, getLut('Grays'), rgba, clean ? undefined : mask);
  });
  console.log(`  remap on slider drag     ${tMap.toFixed(1)} ms   <- this one runs per frame`);

  if (src.pageCount > 1) {
    const n = Math.min(10, src.pageCount);
    const [tScrub] = ms(() => { for (let i = 0; i < n; i++) src.payload(i); });
    console.log(`  scrub ${String(n).padStart(2)} slices          ${tScrub.toFixed(1)} ms   (${(tScrub / n).toFixed(1)} ms/slice)`);
  }
  const heap = process.memoryUsage();
  console.log(`  heap now                 ${mb(heap.heapUsed)} MB used, ${mb(heap.rss)} MB rss`);
  src.dispose();
}
