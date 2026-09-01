import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeStats, autoAdjust, mapTo8Bit, composeRGBA, getLut, toBase64, fromBase64, viewOf,
} = require('../dist/lib.cjs');

/**
 * Guard rails, not a benchmark. Thresholds sit well above measured times on a
 * 2021 laptop so they catch an algorithmic regression (a per-pixel allocation,
 * a lost fast path) without failing on slow or loaded CI hardware.
 */
const MP = 2048 * 2048;

function ctLike(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 977 === 0 ? -1000 : -700 + (i % 500);
  return a;
}

const timed = fn => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

/** Best of three, so one unlucky GC pause does not fail the build. */
const best = fn => Math.min(timed(fn), timed(fn), timed(fn));

describe('performance guard rails (4 megapixel float32)', () => {
  const data = ctLike(MP);
  const stats = computeStats(data, 'float32');
  const range = autoAdjust(stats, 0).range;
  const idx = new Uint8Array(MP);
  const rgba = new Uint8ClampedArray(MP * 4);

  test('statistics stay under 400 ms', () => {
    const ms = best(() => computeStats(data, 'float32'));
    assert.ok(ms < 400, `computeStats took ${ms.toFixed(0)} ms`);
  });

  test('the per-frame remap stays under 200 ms', () => {
    const ms = best(() => {
      mapTo8Bit(data, range.min, range.max, idx, { assumeFinite: true });
      composeRGBA(idx, getLut('Grays'), rgba);
    });
    assert.ok(ms < 200, `remap took ${ms.toFixed(0)} ms - a slider drag would stutter`);
  });

  test('composeRGBA uses word-sized writes', () => {
    // The byte-at-a-time fallback is roughly 4x slower; this pins the fast path.
    const ms = best(() => composeRGBA(idx, getLut('Grays'), rgba));
    assert.ok(ms < 120, `composeRGBA took ${ms.toFixed(0)} ms`);
  });

  test('the wire round trip stays under 500 ms', () => {
    const bytes = new Uint8Array(data.buffer);
    const ms = best(() => viewOf(fromBase64(toBase64(bytes)), 'float32', true));
    assert.ok(ms < 500, `base64 round trip took ${ms.toFixed(0)} ms`);
  });

  test('statistics allocate one histogram, not one per pixel', () => {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5; i++) computeStats(data, 'float32');
    const grew = (process.memoryUsage().heapUsed - before) / 1048576;
    assert.ok(grew < 64, `heap grew ${grew.toFixed(1)} MB across five passes`);
  });
});
