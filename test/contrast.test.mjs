import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TiffFile, BufferReader, computeStats, autoAdjust, stretchHistogram,
  resetRange, fromBrightnessContrast, toBrightnessContrast, getLut, LUT_NAMES,
} = require('../dist/lib.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'contrast_truth.json'), 'utf8'));

function pageZero(file) {
  const tif = new TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(file))));
  return tif.decode(0);
}

function fixturePath(name) {
  return name === '__real__'
    ? path.join(HERE, '..', 'sample.tif')
    : path.join(FIX, name + '.tif');
}

/** Relative comparison; these are wide dynamic ranges (up to 4e9). */
function near(a, b, eps = 1e-9) {
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * eps;
}

describe('ImageStatistics matches the Python transcription bin for bin', () => {
  for (const [name, ref] of Object.entries(truth)) {
    const file = fixturePath(name);
    test(name, { skip: !fs.existsSync(file) }, () => {
      const page = pageZero(file);
      const st = computeStats(page.data, page.dtype, page.samplesPerPixel);

      assert.equal(st.pixelCount, ref.stats.pixelCount, 'pixelCount');
      assert.equal(st.nonFiniteCount, ref.stats.nonFiniteCount, 'nonFiniteCount');
      assert.ok(near(st.min, ref.stats.min, 1e-6), `min ${st.min} vs ${ref.stats.min}`);
      assert.ok(near(st.max, ref.stats.max, 1e-6), `max ${st.max} vs ${ref.stats.max}`);
      assert.ok(near(st.mean, ref.stats.mean, 1e-6), `mean ${st.mean} vs ${ref.stats.mean}`);
      assert.ok(near(st.stdDev, ref.stats.stdDev, 1e-5), `stdDev ${st.stdDev} vs ${ref.stats.stdDev}`);
      assert.ok(near(st.binSize, ref.stats.binSize, 1e-9), `binSize ${st.binSize} vs ${ref.stats.binSize}`);

      // Bin-for-bin: any binning discrepancy changes every auto-contrast result.
      const got = Array.from(st.histogram);
      assert.equal(got.length, ref.stats.histogram.length);
      for (let i = 0; i < got.length; i++) {
        assert.equal(got[i], ref.stats.histogram[i], `histogram bin ${i}`);
      }
      const total = got.reduce((a, b) => a + b, 0);
      assert.equal(total, st.pixelCount, 'histogram sums to pixel count');
    });
  }
});

/**
 * The histogram pass takes shortcuts once the first pass has shown there is no
 * NaN or Inf. This is the plain transcription of FloatStatistics/ShortStatistics
 * binning it has to agree with, pixel for pixel.
 */
function naiveHistogram(data, dtype, channels = 1, channel = -1) {
  const start = channel >= 0 ? channel : 0, step = channel >= 0 ? channels : 1;
  let min = Infinity, max = -Infinity;
  for (let i = start; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const eightBit = dtype === 'uint8' || dtype === 'int8';
  const integer = dtype !== 'float32' && dtype !== 'float64';
  const histMin = eightBit ? (dtype === 'int8' ? -128 : 0) : min;
  const scale = eightBit ? 1 : integer ? 256 / (max - min + 1) : (max > min ? 256 / (max - min) : 0);
  const h = new Array(256).fill(0);
  for (let i = start; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    let idx = Math.trunc(scale * (v - histMin)); // Java's (int) cast
    if (idx > 255) idx = 255;
    if (idx < 0) idx = 0;
    h[idx]++;
  }
  return h;
}

describe('the fast statistics pass agrees with the plain one', () => {
  // Deterministic, not Math.random, so a failure reproduces.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cases = [
    ['float32', () => Float32Array.from({ length: 20011 }, () => rand() * 7 - 3)],
    ['float64', () => Float64Array.from({ length: 20011 }, () => (rand() - 0.5) * 1e12)],
    ['uint16', () => Uint16Array.from({ length: 20011 }, () => Math.floor(rand() * 65536))],
    ['int16', () => Int16Array.from({ length: 20011 }, () => Math.floor(rand() * 65536) - 32768)],
    ['uint32', () => Uint32Array.from({ length: 20011 }, () => Math.floor(rand() * 4294967295))],
    ['int32', () => Int32Array.from({ length: 20011 }, () => Math.floor(rand() * 4e9) - 2e9)],
    ['uint8', () => Uint8Array.from({ length: 20011 }, () => Math.floor(rand() * 256))],
    ['int8', () => Int8Array.from({ length: 20011 }, () => Math.floor(rand() * 256) - 128)],
  ];
  for (const [dtype, make] of cases) {
    test(dtype, () => {
      const data = make();
      assert.deepEqual(Array.from(computeStats(data, dtype).histogram), naiveHistogram(data, dtype));
    });
  }

  test('the value at the top of the range lands in the last bin, not past it', () => {
    const data = Float32Array.from([0, 0.25, 0.5, 1, 1, 1]);
    const h = computeStats(data, 'float32').histogram;
    assert.equal(h[255], 3);
    assert.deepEqual(Array.from(h), naiveHistogram(data, 'float32'));
  });

  test('with NaN and Inf present, they are left out of the bins', () => {
    const data = Float32Array.from({ length: 5003 }, () => rand() * 10);
    data[7] = NaN; data[100] = Infinity; data[4000] = -Infinity;
    const s = computeStats(data, 'float32');
    assert.equal(s.nonFiniteCount, 3);
    assert.deepEqual(Array.from(s.histogram), naiveHistogram(data, 'float32'));
  });

  test('one channel of interleaved samples', () => {
    const data = Uint16Array.from({ length: 3 * 4001 }, () => Math.floor(rand() * 4000));
    for (const c of [0, 1, 2]) {
      assert.deepEqual(Array.from(computeStats(data, 'uint16', 3, c).histogram), naiveHistogram(data, 'uint16', 3, c));
    }
  });

  test('a flat image puts every pixel in bin 0', () => {
    const h = computeStats(new Float32Array(100).fill(2.5), 'float32').histogram;
    assert.equal(h[0], 100);
  });
});

describe('ContrastAdjuster.autoAdjust', () => {
  for (const [name, ref] of Object.entries(truth)) {
    const file = fixturePath(name);
    test(`${name} - six successive Auto presses`, { skip: !fs.existsSync(file) }, () => {
      const page = pageZero(file);
      const st = computeStats(page.data, page.dtype, page.samplesPerPixel);
      let at = 0;
      for (let k = 0; k < ref.auto.length; k++) {
        const r = autoAdjust(st, at);
        at = r.autoThreshold;
        assert.equal(at, ref.auto[k].autoThreshold, `${name} press ${k + 1}: autoThreshold`);
        assert.ok(near(r.range.min, ref.auto[k].range.min, 1e-6),
          `${name} press ${k + 1}: min ${r.range.min} vs ${ref.auto[k].range.min}`);
        assert.ok(near(r.range.max, ref.auto[k].range.max, 1e-6),
          `${name} press ${k + 1}: max ${r.range.max} vs ${ref.auto[k].range.max}`);
      }
    });
  }

  test('the threshold halves each press and resets below 10', () => {
    const st = computeStats(Float32Array.from({ length: 1000 }, (_, i) => i), 'float32');
    let at = 0;
    const seen = [];
    for (let i = 0; i < 12; i++) { const r = autoAdjust(st, at); at = r.autoThreshold; seen.push(at); }
    assert.deepEqual(seen.slice(0, 10), [5000, 2500, 1250, 625, 312, 156, 78, 39, 19, 9]);
    assert.equal(seen[10], 5000, 'resets once it drops below 10');
  });

  test('a dominant background bin does not swallow the stretch', () => {
    // 90% at a constant value, 10% of real signal spread above it: exactly the
    // padded-CT-slice case the pixelCount/10 rule exists for.
    const n = 100000;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = i < n * 0.9 ? 0 : 0.5 + ((i % 1000) / 1000) * 0.5;
    const st = computeStats(data, 'float32');
    const { range } = autoAdjust(st, 0);
    assert.ok(range.min > 0.4, `expected the stretch to skip the plateau, got min=${range.min}`);
    assert.ok(range.max > range.min);
  });
});

describe('ContrastEnhancer.stretchHistogram', () => {
  for (const [name, ref] of Object.entries(truth)) {
    const file = fixturePath(name);
    test(name, { skip: !fs.existsSync(file) }, () => {
      const page = pageZero(file);
      const st = computeStats(page.data, page.dtype, page.samplesPerPixel);
      for (const [sat, expected] of Object.entries(ref.stretch)) {
        const r = stretchHistogram(st, Number(sat));
        assert.ok(near(r.min, expected.min, 1e-6), `${name} @${sat}%: min ${r.min} vs ${expected.min}`);
        assert.ok(near(r.max, expected.max, 1e-6), `${name} @${sat}%: max ${r.max} vs ${expected.max}`);
      }
    });
  }

  test('clips roughly the requested fraction', () => {
    const n = 200000;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = i / n; // uniform 0..1
    const st = computeStats(data, 'float32');
    const r = stretchHistogram(st, 2.0); // 1% off each end
    assert.ok(Math.abs(r.min - 0.01) < 0.01, `min ${r.min}`);
    assert.ok(Math.abs(r.max - 0.99) < 0.01, `max ${r.max}`);
  });
});

describe('reset and brightness/contrast', () => {
  test('reset returns the full data range', () => {
    const page = pageZero(path.join(FIX, 'f32_ct_like.tif'));
    const st = computeStats(page.data, page.dtype);
    const r = resetRange(st);
    assert.ok(near(r.min, st.min, 1e-6));
    assert.ok(near(r.max, st.max, 1e-6));
  });

  test('reset pins 8-bit to 0..255 like ImageJ', () => {
    const st = computeStats(Uint8Array.from([10, 20, 30]), 'uint8');
    assert.deepEqual(resetRange(st), { min: 0, max: 255 });
  });

  test('brightness/contrast round-trips through a display range', () => {
    const full = { min: -1, max: 1 };
    for (const b of [0.25, 0.5, 0.75]) {
      for (const c of [0.3, 0.5, 0.7]) {
        const range = fromBrightnessContrast(full, b, c);
        const back = toBrightnessContrast(full, range);
        assert.ok(Math.abs(back.brightness - b) < 1e-6, `brightness ${back.brightness} vs ${b}`);
        assert.ok(Math.abs(back.contrast - c) < 1e-6, `contrast ${back.contrast} vs ${c}`);
      }
    }
  });
});

describe('LUTs', () => {
  test('every named LUT is 256 RGB entries', () => {
    for (const name of LUT_NAMES) {
      const lut = getLut(name);
      assert.equal(lut.length, 768, name);
      assert.ok(lut.every(v => v >= 0 && v <= 255), name);
    }
  });
  test('Grays is the identity ramp and Inverted Grays its mirror', () => {
    const g = getLut('Grays');
    const inv = getLut('Inverted Grays');
    for (let i = 0; i < 256; i++) {
      assert.equal(g[i * 3], i);
      assert.equal(inv[i * 3], 255 - i);
    }
  });
  test('an unknown name falls back to Grays', () => {
    assert.deepEqual(getLut('Nonexistent'), getLut('Grays'));
  });
});
