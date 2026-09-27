import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { TiffFile, BufferReader } = lib;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'truth.json'), 'utf8'));

function open(file) {
  return new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(path.join(FIX, file)))));
}

/** JSON cannot carry NaN/Inf, so make_fixtures.py tags them as strings. */
function dec(v) {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  return Number(v);
}

/** Tolerance: exact for integers, a float32 ulp-ish relative epsilon otherwise. */
function close(actual, expected, dtype) {
  if (!Number.isFinite(expected)) return !Number.isFinite(actual);
  if (dtype.startsWith('float')) {
    const scale = Math.max(1e-12, Math.abs(expected));
    return Math.abs(actual - expected) <= scale * 1e-6;
  }
  return actual === expected;
}

describe('TIFF decoder vs tifffile ground truth', () => {
  for (const [name, info] of Object.entries(truth)) {
    test(name, () => {
      const tif = open(info.file);
      assert.equal(tif.pageCount, info.pageCount, 'page count');
      assert.equal(tif.bigTiff, info.bigtiff, 'bigtiff flag');
      assert.equal(tif.littleEndian, info.byteorder === '<', 'byte order');

      for (let p = 0; p < info.pages.length; p++) {
        const exp = info.pages[p];
        const got = tif.decode(p);
        // Dimensions come straight from the page tags; the sample fingerprint
        // is taken in our interleaved order (see canonical() in the generator).
        assert.equal(got.height, exp.height, `page ${p} height`);
        assert.equal(got.width, exp.width, `page ${p} width`);
        assert.equal(got.samplesPerPixel, exp.spp, `page ${p} samples`);
        assert.equal(got.data.length, exp.width * exp.height * exp.spp, `page ${p} length`);

        for (const [i, raw] of exp.samples) {
          const v = dec(raw);
          assert.ok(
            close(got.data[i], v, exp.dtype),
            `page ${p} index ${i}: got ${got.data[i]}, expected ${v}`,
          );
        }

        // Extremes and a checksum catch any stride/scatter mistake the spot
        // samples would walk past.
        let min = Infinity, max = -Infinity, sum = 0;
        for (let i = 0; i < got.data.length; i++) {
          const v = got.data[i];
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        assert.ok(close(min, exp.min, exp.dtype), `page ${p} min: ${min} vs ${exp.min}`);
        assert.ok(close(max, exp.max, exp.dtype), `page ${p} max: ${max} vs ${exp.max}`);
        const tol = Math.max(1e-6, Math.abs(exp.sum) * 1e-6);
        assert.ok(Math.abs(sum - exp.sum) <= tol, `page ${p} sum: ${sum} vs ${exp.sum}`);
      }
    });
  }
});

describe('metadata', () => {
  test('ImageJ description is parsed into axes and saved range', () => {
    const tif = open('imagej_stack.tif');
    const sm = tif.stackMeta();
    assert.equal(sm.source, 'imagej');
    assert.equal(sm.slices, 6);
    assert.equal(sm.savedMin, 12.5);
    assert.equal(sm.savedMax, 987.5);
    assert.equal(sm.unit, 'micron');
  });

  test('tifffile JSON description yields the logical shape', () => {
    const tif = open('f32_none.tif');
    const sm = tif.stackMeta();
    assert.equal(sm.source, 'tifffile');
    assert.deepEqual(sm.shape, [64, 96]);
    assert.equal(sm.slices, 1);
  });

  test('page meta reports dtype and compression', () => {
    const m = open('f32_lzw.tif').meta(0);
    assert.equal(m.dtype, 'float32');
    assert.equal(m.compressionName, 'LZW');
    assert.equal(m.width, 96);
    assert.equal(m.height, 64);
  });

  test('rejects a non-TIFF', () => {
    const junk = new Uint8Array(64);
    junk.set([0x89, 0x50, 0x4e, 0x47]);
    assert.throws(() => new TiffFile(new BufferReader(junk)), /Not a TIFF/);
  });
});

describe('the generated sample slice', () => {
  const p = path.join(HERE, '..', 'sample.tif');
  test('decodes sample.tif', { skip: !fs.existsSync(p) }, () => {
    const tif = new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(p))));
    const meta = tif.meta(0);
    assert.equal(meta.compressionName, 'none');
    assert.equal(meta.samplesPerPixel, 1);
    assert.deepEqual(tif.stackMeta().shape, [512, 512]);

    const page = tif.decode(0);
    assert.equal(page.width, 512);
    assert.equal(page.height, 512);
    assert.equal(page.dtype, 'float32');

    let min = Infinity, max = -Infinity, sum = 0, atFloor = 0;
    for (const v of page.data) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (v === -1) atFloor++;
    }
    const mean = sum / page.data.length;

    // The point of this fixture is the shape of its distribution, not exact
    // values: a hard air plateau at the floor, a sparse bright tail, and a mean
    // sitting far below the midpoint. That is what defeats a naive viewer.
    assert.equal(min, -1, 'air plateau should sit exactly at -1');
    assert.ok(max > 0.9, `bright tail should approach 1, got ${max}`);
    assert.ok(atFloor / page.data.length > 0.25,
      `at least a quarter of pixels should be background, got ${atFloor}`);
    assert.ok(mean < (min + max) / 2 - 0.5,
      `mean ${mean} should sit far below the midpoint of [${min}, ${max}]`);
  });
});

/**
 * A reference TIFF LZW encoder: MSB-first codes, a clear code first, the width
 * growing one code early, and a clear whenever the table fills - what libtiff
 * writes. Lets the decoder be checked on inputs chosen to hit its edge cases,
 * not only on what tifffile happened to produce.
 */
function lzwEncode(data) {
  const bytes = [];
  let acc = 0, accBits = 0, width = 9;
  const put = code => {
    acc = (acc << width) | code; accBits += width;
    while (accBits >= 8) { bytes.push((acc >>> (accBits - 8)) & 0xff); accBits -= 8; }
    acc &= (1 << accBits) - 1;
  };
  let dict = new Map();
  let next = 258;
  const reset = () => { dict = new Map(); next = 258; width = 9; };
  put(256);
  let w = -1;
  for (const b of data) {
    if (w < 0) { w = b; continue; }
    const key = w * 256 + b;
    const hit = dict.get(key);
    if (hit !== undefined) { w = hit; continue; }
    put(w);
    dict.set(key, next++);
    // The decoder defines each entry one code after the encoder does, so the
    // encoder's "one code early" is when its next free code reaches the power of two.
    if (next === 512) width = 10;
    else if (next === 1024) width = 11;
    else if (next === 2048) width = 12;
    if (next === 4094) { put(256); reset(); }
    w = b;
  }
  if (w >= 0) put(w);
  put(257);
  if (accBits > 0) bytes.push((acc << (8 - accBits)) & 0xff);
  return Uint8Array.from(bytes);
}

/** The chain-walking decoder this one replaced, kept as the reference. */
function lzwDecodeByChains(input, expectedLength) {
  const out = new Uint8Array(expectedLength);
  let outPos = 0;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; }
  let next = 258, width = 9, bitPos = 0, old = -1;
  const total = input.length * 8;
  const read = () => {
    if (bitPos + width > total) return 257;
    let c = 0;
    for (let i = 0; i < width; i++) c = (c << 1) | ((input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1);
    bitPos += width;
    return c;
  };
  const chain = code => { const s = []; for (let c = code; c >= 0; c = prefix[c]) s.push(suffix[c]); return s.reverse(); };
  const emit = s => { for (const b of s) if (outPos < expectedLength) out[outPos++] = b; };
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; old = -1; continue; }
    let s;
    if (old < 0) s = chain(code);
    else if (code < next) s = chain(code);
    else { const o = chain(old); s = [...o, o[0]]; }
    emit(s);
    if (old >= 0 && next < 4096) { prefix[next] = old; suffix[next] = s[0]; next++; }
    old = code;
    if (next + 1 === 512) width = 10; else if (next + 1 === 1024) width = 11; else if (next + 1 === 2048) width = 12;
    if (outPos >= expectedLength) break;
  }
  return out;
}

describe('LZW', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const inputs = {
    'random bytes, which fill the table and force clears': Uint8Array.from({ length: 200000 }, () => rand() * 256),
    'one long run, the KwKwK case over and over': new Uint8Array(100000).fill(42),
    'a few symbols, deep dictionary chains': Uint8Array.from({ length: 150000 }, () => (rand() < 0.9 ? 0 : 1 + (rand() * 3 | 0))),
    'float32 CT-like rows': new Uint8Array(Float32Array.from({ length: 60000 }, (_, i) => (i % 900 < 150 ? -1 : -0.7 + (i % 37) * 1e-3)).buffer),
    'short inputs': Uint8Array.from([1, 2, 1, 2, 1, 2, 1]),
  };
  for (const [name, data] of Object.entries(inputs)) {
    test(`round-trips ${name}`, () => {
      const packed = lzwEncode(data);
      const back = lib.lzwDecode(packed, data.length);
      assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(data)), 0);
      assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(lzwDecodeByChains(packed, data.length))), 0);
    });
  }

  test('stops at the expected length, and pads a stream that ends early', () => {
    const data = inputs['random bytes, which fill the table and force clears'];
    const packed = lzwEncode(data);
    const shorter = lib.lzwDecode(packed, 1000);
    assert.equal(Buffer.compare(Buffer.from(shorter), Buffer.from(data.subarray(0, 1000))), 0);
    for (const cut of [1, 17, 1000, packed.length >> 1, packed.length - 3]) {
      const truncated = packed.subarray(0, cut);
      const got = lib.lzwDecode(truncated, data.length);
      assert.equal(got.length, data.length, 'always the size asked for');
      assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(lzwDecodeByChains(truncated, data.length))), 0,
        `cut at ${cut} bytes`);
    }
  });
});
