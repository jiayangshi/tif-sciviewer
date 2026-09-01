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
