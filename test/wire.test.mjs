import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SliceSource, BufferReader, TiffFile, toBase64, fromBase64, viewOf, computeStats, payloadBytes,
  subsample, sampledSize, clipRegion,
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
    const values = viewOf(payloadBytes(p), p.dtype, p.littleEndian);
    assert.equal(values.length, direct.data.length);
    for (let i = 0; i < values.length; i += 97) assert.equal(values[i], direct.data[i], `value ${i}`);
  });

  test('stats travel with the slice and match a local computation', () => {
    const src = source('f32_ct_like.tif');
    const p = src.payload(0);
    const values = viewOf(payloadBytes(p), p.dtype, p.littleEndian);
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
      firsts.push(viewOf(payloadBytes(p), p.dtype, p.littleEndian)[0]);
    }
    // Each slice of the fixture is offset by 0.05 from the previous one.
    for (let i = 1; i < firsts.length; i++) {
      assert.ok(Math.abs((firsts[i] - firsts[i - 1]) - 0.05) < 1e-5, `slice ${i} offset`);
    }
  });

  test('prefetch decodes into the cache, and a request then finds it there', () => {
    const src = source('stack_f32.tif');
    assert.equal(src.prefetch(3), true);
    assert.deepEqual(src.cachedPages, [3]);
    const cached = src.getSlice(3);
    assert.equal(src.prefetch(3), false, 'already there, so nothing to do');
    assert.equal(src.getSlice(3).data, cached.data);
  });

  test('prefetch does not reorder the pages already cached', () => {
    const src = source('stack_f32.tif');
    src.getSlice(1); src.getSlice(2);
    src.prefetch(1);
    assert.deepEqual(src.cachedPages, [1, 2], 'a hit leaves page 1 first in line for eviction');
  });

  test('prefetch ignores pages that do not exist rather than throwing', () => {
    const src = source('stack_f32.tif');
    for (const bad of [-1, 7, 1.5, NaN]) assert.equal(src.prefetch(bad), false, String(bad));
    assert.deepEqual(src.cachedPages, []);
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

/**
 * VS Code's own webview message transport, transcribed from
 * src/vs/workbench/api/common/extHostWebviewMessaging.ts (serializeWebviewMessage
 * / deserializeWebviewMessage) as shipped in 1.138. This is what decides
 * whether pixels travel as bytes or as JSON, so the payload is checked against it.
 */
const VIEW_TYPES = {
  Int8Array: 1, Uint8Array: 2, Uint8ClampedArray: 3, Int16Array: 4, Uint16Array: 5,
  Int32Array: 6, Uint32Array: 7, Float32Array: 8, Float64Array: 9,
};
const VIEW_CTORS = [null, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array];
function vscodeSerialize(message) {
  const buffers = [];
  const add = b => { let i = buffers.indexOf(b); if (i < 0) { i = buffers.length; buffers.push(b); } return i; };
  const json = JSON.stringify(message, (_k, v) => {
    if (v instanceof ArrayBuffer) return { $$vscode_array_buffer_reference$$: true, index: add(v) };
    if (ArrayBuffer.isView(v)) {
      const type = VIEW_TYPES[v.constructor.name];
      if (type) {
        return {
          $$vscode_array_buffer_reference$$: true, index: add(v.buffer),
          view: { type, byteLength: v.byteLength, byteOffset: v.byteOffset },
        };
      }
    }
    return v;
  });
  return { json, buffers: buffers.map(b => new Uint8Array(b)) };
}
function vscodeDeserialize({ json, buffers }) {
  const copies = buffers.map(b => { const a = new ArrayBuffer(b.byteLength); new Uint8Array(a).set(b); return a; });
  return JSON.parse(json, (_k, v) => {
    if (v && typeof v === 'object' && v.$$vscode_array_buffer_reference$$) {
      const ab = copies[v.index];
      if (!v.view) return ab;
      const C = VIEW_CTORS[v.view.type];
      return new C(ab, v.view.byteOffset, v.view.byteLength / C.BYTES_PER_ELEMENT);
    }
    return v;
  });
}

describe('binary wire format', () => {
  test('pixels travel as a plain Uint8Array over exactly their own bytes', () => {
    const p = source('f32_ct_like.tif').payload(0);
    assert.equal(p.base64, undefined, 'no base64 unless asked for');
    // VS Code matches views by constructor name: a Buffer would go as JSON.
    assert.equal(p.pixels.constructor.name, 'Uint8Array');
    // And it sends the whole ArrayBuffer behind a view.
    assert.equal(p.pixels.byteOffset, 0);
    assert.equal(p.pixels.buffer.byteLength, p.pixels.byteLength);
    assert.equal(p.pixels.byteLength, p.width * p.height * 4);
    assert.equal(p.step, 1);
  });

  test("VS Code's transport ships the pixels as bytes, and they arrive intact", () => {
    const p = source('f32_ct_like.tif').payload(0);
    const wire = vscodeSerialize(p);
    assert.equal(wire.buffers.length, 1, 'one binary attachment');
    assert.equal(wire.buffers[0].byteLength, p.pixels.byteLength, 'and nothing but the pixels in it');
    // The JSON part is metadata and the 256-bin histogram, not pixels.
    assert.ok(wire.json.length < 8 * 1024, `JSON part is ${wire.json.length} bytes`);

    const got = vscodeDeserialize(wire);
    const bytes = payloadBytes(got);
    assert.ok(bytes, 'pixels must survive');
    assert.deepEqual(Buffer.from(bytes), Buffer.from(p.pixels));
    const values = viewOf(bytes, got.dtype, got.littleEndian);
    const direct = source('f32_ct_like.tif').getSlice(0).data;
    for (let i = 0; i < direct.length; i += 101) assert.equal(values[i], direct[i], `value ${i}`);
  });

  test('a Node Buffer would not survive it, which is why pixels are never one', () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const got = vscodeDeserialize(vscodeSerialize({ pixels: buf }));
    assert.equal(payloadBytes(got), undefined, 'a Buffer arrives as { type, data }, not bytes');
  });

  test('base64 is there for a transport that mangles binary', () => {
    const src = source('stack_f32.tif');
    const b64 = src.payload(2, 'base64');
    assert.equal(b64.pixels, undefined);
    assert.equal(typeof b64.base64, 'string');
    assert.deepEqual(Buffer.from(payloadBytes(b64)), Buffer.from(src.payload(2).pixels));
  });

  test('payloadBytes reports pixels that did not survive, rather than guessing', () => {
    assert.equal(payloadBytes({ pixels: { 0: 1, 1: 2 } }), undefined, 'a typed array stringified to JSON');
    assert.equal(payloadBytes({}), undefined);
    assert.equal(payloadBytes({ pixels: null }), undefined);
    const view = new Float32Array([1.5, -2]);
    const bytes = payloadBytes({ pixels: view });
    assert.equal(bytes.byteLength, 8, 'any view is taken as its bytes');
  });
});

describe('previews while a stack is moving', () => {
  test('sampledSize rounds up, so the last partial block is kept', () => {
    assert.deepEqual(sampledSize(4096, 4096, 4), { width: 1024, height: 1024 });
    assert.deepEqual(sampledSize(10, 7, 3), { width: 4, height: 3 });
    assert.deepEqual(sampledSize(5, 5, 1), { width: 5, height: 5 });
  });

  test('subsample keeps the measured value at the centre of each block', () => {
    const W = 10, H = 7, step = 3;
    const data = Float32Array.from({ length: W * H }, (_, i) => i);
    const out = subsample(data, W, H, 1, step);
    assert.ok(out instanceof Float32Array, 'same element type as the slice');
    assert.equal(out.length, 4 * 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        // Centre of the block, pulled back inside a partial edge block.
        const sx = Math.min(W - 1, x * step + 1), sy = Math.min(H - 1, y * step + 1);
        assert.equal(out[y * 4 + x], data[sy * W + sx], `(${x}, ${y})`);
      }
    }
  });

  test('subsample keeps interleaved samples together', () => {
    const W = 4, H = 2, spp = 3;
    const data = Uint16Array.from({ length: W * H * spp }, (_, i) => i);
    const out = subsample(data, W, H, spp, 2);
    assert.ok(out instanceof Uint16Array);
    // Blocks centred on (1,1) and (3,1).
    const at = (x, y) => Array.from(data.subarray((y * W + x) * spp, (y * W + x + 1) * spp));
    assert.deepEqual(Array.from(out), [...at(1, 1), ...at(3, 1)]);
  });

  test('clipRegion keeps a region on the slice and on whole pixels', () => {
    assert.deepEqual(clipRegion({ x: 10, y: 20, width: 30, height: 40 }, 100, 100), { x: 10, y: 20, width: 30, height: 40 });
    assert.deepEqual(clipRegion({ x: -5, y: 90, width: 20, height: 50 }, 100, 100), { x: 0, y: 90, width: 15, height: 10 });
    assert.deepEqual(clipRegion({ x: 1.5, y: 2.5, width: 3, height: 3 }, 100, 100), { x: 1, y: 2, width: 4, height: 4 },
      'widened to cover every pixel it touches');
    assert.equal(clipRegion({ x: 0, y: 0, width: 100, height: 100 }, 100, 100), undefined, 'all of it means no region');
    assert.equal(clipRegion({ x: -10, y: -10, width: 500, height: 500 }, 100, 100), undefined);
    for (const bad of [undefined, null, 'x', { x: 200, y: 0, width: 5, height: 5 }, { x: 'a', y: 0, width: 5, height: 5 },
      { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: 0, width: NaN, height: 5 }]) {
      assert.equal(clipRegion(bad, 100, 100), undefined, JSON.stringify(bad));
    }
  });

  test('subsample crops a region, and samples within it', () => {
    const W = 12, H = 9;
    const data = Float32Array.from({ length: W * H }, (_, i) => i);
    const r = { x: 3, y: 2, width: 5, height: 4 };
    const crop = subsample(data, W, H, 1, 1, r);
    const want = [];
    for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) want.push(y * W + x);
    assert.deepEqual(Array.from(crop), want, 'at step 1, exactly the pixels of the region');

    const thin = subsample(data, W, H, 1, 2, r);
    assert.equal(thin.length, 3 * 2);
    // Block centres at x = 4, 6, then the last column (7); y = 3, 5.
    assert.deepEqual(Array.from(thin), [3 * W + 4, 3 * W + 6, 3 * W + 7, 5 * W + 4, 5 * W + 6, 5 * W + 7]);
  });

  test('a region payload says which part it covers', () => {
    const src = source('big_f32_lzw.tif');
    const full = src.getSlice(0).data;
    const r = { x: 17, y: 5, width: 64, height: 32 };
    const p = src.payload(0, 'binary', 1, r);
    assert.deepEqual(p.region, r);
    assert.equal(p.step, 1);
    const values = viewOf(payloadBytes(p), p.dtype, p.littleEndian);
    assert.equal(values.length, 64 * 32);
    assert.equal(values[33 * 1 + 64 * 7], full[(5 + 7) * p.width + 17 + 33]);
    assert.equal(src.payload(0, 'binary', 1, { x: 0, y: 0, width: 1e6, height: 1e6 }).region, undefined,
      'a region covering everything is the whole slice');
  });

  test('a preview payload is small, but its statistics are the whole slice', () => {
    const src = source('big_f32_lzw.tif');
    const full = src.payload(0);
    const preview = src.payload(0, 'binary', 4);
    assert.equal(preview.step, 4);
    assert.equal(preview.width, full.width, 'dimensions stay those of the slice');
    assert.equal(preview.height, full.height);
    const { width, height } = sampledSize(full.width, full.height, 4);
    assert.equal(preview.pixels.byteLength, width * height * 4);
    assert.deepEqual(preview.stats, full.stats, 'histogram and range must not depend on the step');
  });
});
