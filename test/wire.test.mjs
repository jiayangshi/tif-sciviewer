import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SliceSource, BufferReader, TiffFile, toBase64, fromBase64, viewOf, computeStats,
} = require('../dist/lib.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const source = name => new SliceSource(new BufferReader(new Uint8Array(fs.readFileSync(path.join(FIX, name)))));

describe('base64 wire format', () => {
  test('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 2, 3, 255, 4096, 65537]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37) & 0xff;
      const back = fromBase64(toBase64(bytes));
      assert.equal(back.length, len);
      for (let i = 0; i < len; i++) assert.equal(back[i], bytes[i], `byte ${i} of ${len}`);
    }
  });

  test('survives a possibly unaligned decode buffer for every dtype', () => {
    const cases = [
      ['uint16', Uint16Array.from([0, 1, 65535, 1234])],
      ['int16', Int16Array.from([-32768, -1, 0, 32767])],
      ['uint32', Uint32Array.from([0, 4294967295, 7])],
      ['int32', Int32Array.from([-2147483648, 0, 2147483647])],
      ['float32', Float32Array.from([-1, 0.5, 3.25, 1e20])],
      ['float64', Float64Array.from([-1e300, 0.1, 1e300])],
    ];
    for (const [dtype, arr] of cases) {
      const bytes = new Uint8Array(arr.buffer.slice(0));
      const view = viewOf(fromBase64(toBase64(bytes)), dtype, true);
      assert.equal(view.length, arr.length, dtype);
      for (let i = 0; i < arr.length; i++) assert.equal(view[i], arr[i], `${dtype}[${i}]`);
    }
  });

  test('byte-swaps when the sender disagrees about endianness', () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    const asIs = viewOf(bytes.slice(), 'uint16', true);
    const swapped = viewOf(bytes.slice(), 'uint16', false);
    assert.equal(asIs[0], 0x0201);
    assert.equal(swapped[0], 0x0102);
  });
});

describe('SliceSource', () => {
  test('payload matches a direct decode', () => {
    const src = source('stack_f32.tif');
    const direct = new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(path.join(FIX, 'stack_f32.tif'))))).decode(3);
    const p = src.payload(3);
    assert.equal(p.type, 'slice');
    assert.equal(p.index, 3);
    assert.equal(p.width, direct.width);
    assert.equal(p.height, direct.height);
    assert.equal(p.dtype, direct.dtype);
    const values = viewOf(fromBase64(p.base64), p.dtype, p.littleEndian);
    assert.equal(values.length, direct.data.length);
    for (let i = 0; i < values.length; i += 97) assert.equal(values[i], direct.data[i], `value ${i}`);
  });

  test('stats travel with the slice and match a local computation', () => {
    const src = source('f32_ct_like.tif');
    const p = src.payload(0);
    const values = viewOf(fromBase64(p.base64), p.dtype, p.littleEndian);
    const local = computeStats(values, p.dtype, p.samplesPerPixel);
    assert.equal(p.stats.pixelCount, local.pixelCount);
    assert.ok(Math.abs(p.stats.min - local.min) < 1e-9);
    assert.ok(Math.abs(p.stats.max - local.max) < 1e-9);
    assert.deepEqual(p.stats.histogram, Array.from(local.histogram));
  });

  test('every page of a stack is reachable and distinct', () => {
    const src = source('stack_f32.tif');
    assert.equal(src.pageCount, 7);
    const firsts = [];
    for (let i = 0; i < 7; i++) {
      const p = src.payload(i);
      firsts.push(viewOf(fromBase64(p.base64), p.dtype, p.littleEndian)[0]);
    }
    // Each slice of the fixture is offset by 0.05 from the previous one.
    for (let i = 1; i < firsts.length; i++) {
      assert.ok(Math.abs((firsts[i] - firsts[i - 1]) - 0.05) < 1e-5, `slice ${i} offset`);
    }
  });

  test('re-reading a page is served from cache', () => {
    const src = source('stack_f32.tif');
    const a = src.getSlice(2);
    const b = src.getSlice(2);
    assert.equal(a.data, b.data, 'same array instance means no re-decode');
  });

  test('the cache evicts oldest first under a pixel budget', () => {
    // 64*96 values per page; a budget of 2.5 pages must hold at most 2.
    const src = new SliceSource(
      new BufferReader(new Uint8Array(fs.readFileSync(path.join(FIX, 'stack_f32.tif')))),
      Math.floor(64 * 96 * 2.5),
    );
    for (let i = 0; i < 5; i++) src.getSlice(i);
    const cached = src.cachedPages;
    assert.ok(cached.length <= 2, `expected at most 2 cached pages, got ${cached.length}`);
    assert.ok(cached.includes(4), 'the most recent page must survive');
    assert.ok(!cached.includes(0), 'the oldest page must have been evicted');
  });

  test('touching a page moves it to the back of the eviction queue', () => {
    const src = new SliceSource(
      new BufferReader(new Uint8Array(fs.readFileSync(path.join(FIX, 'stack_f32.tif')))),
      Math.floor(64 * 96 * 2.5),
    );
    src.getSlice(0);
    src.getSlice(1);
    src.getSlice(0);  // refresh page 0
    src.getSlice(2);  // forces one eviction
    assert.ok(src.cachedPages.includes(0), 'the refreshed page should have survived');
    assert.ok(!src.cachedPages.includes(1), 'the untouched page should have gone');
  });

  test('exposes stack metadata for the sidebar', () => {
    const src = source('imagej_stack.tif');
    assert.equal(src.stack.source, 'imagej');
    assert.equal(src.stack.slices, 6);
    assert.equal(src.meta.dtype, 'float32');
  });

  test('an out-of-range page fails loudly', () => {
    const src = source('f32_none.tif');
    assert.throws(() => src.payload(5), /out of range/);
  });
});
