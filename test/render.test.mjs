import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TiffFile, BufferReader, mapTo8Bit, composeRGBA, renderColor, formatValue, getLut,
} = require('../dist/lib.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'contrast_truth.json'), 'utf8'));

const fixturePath = name =>
  name === '__real__' ? path.join(HERE, '..', 'sample.tif') : path.join(FIX, name + '.tif');

function pageZero(file) {
  return new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(file)))).decode(0);
}

describe('mapTo8Bit reproduces FloatProcessor.create8BitImage', () => {
  for (const [name, ref] of Object.entries(truth)) {
    const file = fixturePath(name);
    test(name, { skip: !fs.existsSync(file) || !ref.render }, () => {
      const page = pageZero(file);
      const n = page.width * page.height * page.samplesPerPixel;
      for (const probe of ref.render) {
        const out = new Uint8Array(n);
        mapTo8Bit(page.data, probe.range.min, probe.range.max, out);

        // A full 256-entry count of the output is an exact fingerprint of the
        // mapping: any rounding drift shifts pixels between neighbouring bins.
        const counts = new Array(256).fill(0);
        for (let i = 0; i < out.length; i++) counts[out[i]]++;
        for (let v = 0; v < 256; v++) {
          assert.equal(counts[v], probe.counts[v],
            `${name} range [${probe.range.min}, ${probe.range.max}]: count of output value ${v}`);
        }
        for (const [i, expected] of probe.samples) {
          assert.equal(out[i], expected, `${name} pixel ${i}`);
        }
      }
    });
  }

  test('rounds exactly as ImageJ does at bin boundaries', () => {
    // scale = 255/1 = 255; ivalue = trunc(v*255 + 0.5)
    const data = Float32Array.from([0, 0.001, 0.0019, 0.002, 1 / 255, 0.5, 0.999, 1]);
    const out = new Uint8Array(data.length);
    mapTo8Bit(data, 0, 1, out);
    const expected = data.map(v => {
      let x = Math.trunc(Math.max(v - 0, 0) * 255 + 0.5);
      return x > 255 ? 255 : x;
    });
    assert.deepEqual(Array.from(out), Array.from(expected));
  });

  test('clamps below the minimum and above the maximum', () => {
    const data = Float32Array.from([-100, -1, 0, 0.5, 1, 2, 1000]);
    const out = new Uint8Array(data.length);
    mapTo8Bit(data, 0, 1, out);
    assert.deepEqual(Array.from(out), [0, 0, 0, 128, 255, 255, 255]);
  });

  test('flags NaN and Inf in the mask and leaves the index at zero', () => {
    const data = Float32Array.from([0.5, NaN, Infinity, -Infinity, 0.5]);
    const out = new Uint8Array(5);
    const mask = new Uint8Array(5);
    const n = mapTo8Bit(data, 0, 1, out, { mask });
    assert.equal(n, 3);
    assert.deepEqual(Array.from(mask), [0, 1, 1, 1, 0]);
    assert.deepEqual(Array.from(out), [128, 0, 0, 0, 128]);
  });

  test('a degenerate range splits at the level instead of dividing by zero', () => {
    const data = Float32Array.from([4, 5, 6]);
    const out = new Uint8Array(3);
    mapTo8Bit(data, 5, 5, out);
    assert.deepEqual(Array.from(out), [0, 255, 255]);
    assert.ok(out.every(Number.isFinite));
  });

  test('maps a single channel of an interleaved image', () => {
    const data = Uint8Array.from([0, 128, 255, 10, 138, 245]);
    const out = new Uint8Array(2);
    mapTo8Bit(data, 0, 255, out, { channels: 3, channel: 1 });
    assert.deepEqual(Array.from(out), [128, 138]);
  });
});

describe('composeRGBA', () => {
  test('applies the LUT and paints non-finite pixels', () => {
    const idx = Uint8Array.from([0, 255, 7]);
    const mask = Uint8Array.from([0, 0, 1]);
    const rgba = new Uint8ClampedArray(12);
    composeRGBA(idx, getLut('Grays'), rgba, mask, [255, 64, 64]);
    assert.deepEqual(Array.from(rgba.slice(0, 4)), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(rgba.slice(4, 8)), [255, 255, 255, 255]);
    assert.deepEqual(Array.from(rgba.slice(8, 12)), [255, 64, 64, 255]);
  });

  test('Inverted Grays mirrors Grays', () => {
    const idx = Uint8Array.from([0, 128, 255]);
    const a = new Uint8ClampedArray(12);
    const b = new Uint8ClampedArray(12);
    composeRGBA(idx, getLut('Grays'), a);
    composeRGBA(idx, getLut('Inverted Grays'), b);
    for (let i = 0; i < 3; i++) assert.equal(a[i * 4] + b[i * 4], 255);
  });
});

describe('renderColor', () => {
  test('maps all three samples on the same range and stays opaque', () => {
    const data = Uint8Array.from([0, 128, 255, 255, 0, 0]);
    const rgba = new Uint8ClampedArray(8);
    renderColor(data, 3, 0, 255, rgba);
    assert.deepEqual(Array.from(rgba), [0, 128, 255, 255, 255, 0, 0, 255]);
  });

  test('a fourth sample is not treated as alpha', () => {
    const data = Uint8Array.from([10, 20, 30, 0]);
    const rgba = new Uint8ClampedArray(4);
    renderColor(data, 4, 0, 255, rgba);
    assert.equal(rgba[3], 255, 'a zero fourth channel must not blank the pixel');
  });
});

describe('formatValue', () => {
  test('integers stay plain', () => {
    assert.equal(formatValue(1234, false), '1234');
    assert.equal(formatValue(-5, false), '-5');
  });
  test('floats keep enough digits to separate CT numbers', () => {
    assert.equal(formatValue(-0.654212, true), '-0.6542');
    assert.equal(formatValue(1, true), '1');
    assert.equal(formatValue(0, true), '0');
  });
  test('very large and very small floats go exponential', () => {
    assert.equal(formatValue(1e-9, true), '1.0000e-9');
    assert.equal(formatValue(2.5e8, true), '2.5000e+8');
  });
  test('non-finite values are labelled', () => {
    assert.equal(formatValue(NaN, true), 'NaN');
    assert.equal(formatValue(Infinity, true), 'Inf');
    assert.equal(formatValue(-Infinity, true), '-Inf');
  });
});
