import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeSequence, writeSliceTif, expectedValue } from '../tools/make-sequence.mjs';
import { phantom } from '../tools/phantom.mjs';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const {
  naturalCompare, sortSequence, encodeSequence, decodeSequence,
  sequenceQuery, sequenceFromQuery, baseName, SequenceSource, SliceSource, BufferReader,
} = lib;

const W = 48, H = 32;
const COUNT = 6;
let dir;
let paths;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-seq-'));
  paths = writeSequence(dir, { count: COUNT, width: W, height: H });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Counts opens and closes so the file-handle pool can be checked. */
function countingFactory(counts = { opened: 0, closed: 0 }) {
  const open = (id) => {
    counts.opened++;
    const reader = new BufferReader(new Uint8Array(fs.readFileSync(id)));
    return {
      get size() { return reader.size; },
      read: (o, n) => reader.read(o, n),
      close: () => { counts.closed++; },
    };
  };
  open.counts = counts;
  return open;
}

const plainFactory = (id) => new BufferReader(new Uint8Array(fs.readFileSync(id)));

/**
 * Decode a wire payload. `Buffer.from(b64).buffer` is the shared pool, not just
 * these bytes, so it has to be copied before being viewed as float32 - both to
 * get the alignment and to avoid reading a neighbour's data.
 */
function floatsOf(base64) {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

describe('sequence ordering', () => {
  test('numbers sort like numbers, not like text', () => {
    const shuffled = ['s_10.tif', 's_2.tif', 's_1.tif', 's_21.tif', 's_3.tif'];
    assert.deepEqual(
      sortSequence(shuffled),
      ['s_1.tif', 's_2.tif', 's_3.tif', 's_10.tif', 's_21.tif'],
    );
  });

  test('zero padding and no padding agree', () => {
    assert.ok(naturalCompare('slice_0002.tif', 'slice_10.tif') < 0);
    assert.ok(naturalCompare('recon_9.tif', 'recon_10.tif') < 0);
  });

  test('ordering is total, so equal-looking names still have a fixed order', () => {
    // The collator folds case; the tiebreak keeps the result deterministic.
    assert.notEqual(naturalCompare('A.tif', 'a.tif'), 0);
    assert.equal(naturalCompare('a.tif', 'a.tif'), 0);
  });

  test('the explorer selection order does not leak through', () => {
    const asClicked = [paths[3], paths[0], paths[5], paths[1]];
    const ordered = sortSequence(asClicked);
    assert.deepEqual(ordered, [paths[0], paths[1], paths[3], paths[5]]);
  });
});

describe('sequence URIs', () => {
  const ids = [
    'file:///data/recon/slice_0001.tif',
    'file:///data/recon/slice_0002.tif',
    'file:///data/recon/slice_0003.tif',
  ];

  test('round-trips the member list', () => {
    assert.deepEqual(decodeSequence(encodeSequence(ids)), ids);
  });

  test('round-trips through a URI query', () => {
    assert.deepEqual(sequenceFromQuery(sequenceQuery(ids)), ids);
  });

  test('the encoding is URI-safe', () => {
    const encoded = encodeSequence(ids);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'base64url only, so no re-escaping in a query');
    assert.equal(encodeURIComponent(encoded), encoded);
  });

  test('a shared folder is stored once', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      `file:///very/long/path/to/the/reconstruction/slice_${String(i).padStart(4, '0')}.tif`);
    const encoded = encodeSequence(many);
    const naive = Buffer.from(JSON.stringify(many)).toString('base64url').length;
    assert.ok(encoded.length < naive / 3, `expected real compression, got ${encoded.length} vs ${naive}`);
    assert.deepEqual(decodeSequence(encoded), many);
  });

  test('files from different folders still round-trip', () => {
    const mixed = ['file:///a/one.tif', 'file:///b/two.tif', 'file:///c/three.tif'];
    assert.deepEqual(decodeSequence(encodeSequence(mixed)), mixed);
  });

  test('a plain file URI carries no sequence', () => {
    assert.equal(sequenceFromQuery(''), undefined);
    assert.equal(sequenceFromQuery('other=1'), undefined);
  });

  test('a damaged list fails loudly rather than opening the wrong thing', () => {
    assert.throws(() => decodeSequence('not-base64-at-all!!'), /not readable/);
    assert.throws(() => decodeSequence(Buffer.from('{"v":9}').toString('base64url')), /not readable/);
    assert.throws(
      () => decodeSequence(Buffer.from('{"v":1,"base":"","items":[]}').toString('base64url')),
      /not readable/,
    );
  });

  test('baseName survives percent-encoding', () => {
    assert.equal(baseName('file:///data/my%20scan/slice_1.tif'), 'slice_1.tif');
    assert.equal(baseName('file:///data/a%20b.tif'), 'a b.tif');
  });
});

describe('SequenceSource', () => {
  test('presents one page per file', () => {
    const seq = new SequenceSource(paths, plainFactory);
    assert.equal(seq.pageCount, COUNT);
    assert.equal(seq.entries.length, COUNT);
    assert.equal(seq.stackMeta().slices, COUNT);
    assert.equal(seq.stackMeta().source, 'sequence');
    seq.close();
  });

  test('maps every global index to the right file', () => {
    const seq = new SequenceSource(paths, plainFactory);
    for (let i = 0; i < COUNT; i++) {
      const at = seq.locate(i);
      assert.equal(at.fileIndex, i);
      assert.equal(at.localPage, 0);
      assert.equal(at.entry.name, path.basename(paths[i]));
    }
    seq.close();
  });

  test('decodes each slice from its own file', () => {
    const seq = new SequenceSource(paths, plainFactory);
    const probe = Math.floor((W * H) / 2) + 7;
    for (let n = 0; n < COUNT; n++) {
      const page = seq.decode(n);
      assert.equal(page.width, W);
      assert.equal(page.height, H);
      assert.equal(page.data[probe], expectedValue(W, H, probe, n, COUNT),
        `slice ${n} should carry its own pixels`);
    }
    seq.close();
  });

  test('slices are in file order after sorting, not selection order', () => {
    const shuffled = [paths[4], paths[1], paths[0], paths[3], paths[2], paths[5]];
    const seq = new SequenceSource(sortSequence(shuffled), plainFactory);
    const probe = 11;
    for (let n = 0; n < COUNT; n++) {
      assert.equal(seq.decode(n).data[probe], expectedValue(W, H, probe, n, COUNT));
    }
    seq.close();
  });

  test('labels name the file behind each slice', () => {
    const seq = new SequenceSource(paths, plainFactory);
    assert.deepEqual(seq.sliceLabels(), paths.map(p => path.basename(p)));
    seq.close();
  });

  test('page metadata reports the global index', () => {
    const seq = new SequenceSource(paths, plainFactory);
    assert.equal(seq.meta(3).index, 3);
    assert.equal(seq.meta(3).width, W);
    seq.close();
  });

  test('a file of another shape is rejected by name', () => {
    const odd = writeSliceTif(path.join(dir, 'odd', 'wrong_size.tif'), {
      width: W + 4, height: H, pixels: phantom(W + 4, H),
    });
    assert.throws(
      () => new SequenceSource([...paths, odd], plainFactory),
      (e) => /same shape/.test(e.message)
        && e.message.match(/wrong_size\.tif/g).length === 1,   // not "name: name is ..." 
    );
  });

  test('a file of another pixel type is rejected too', () => {
    const u16 = writeSliceTif(path.join(dir, 'odd', 'wrong_dtype.tif'), {
      width: W, height: H, pixels: phantom(W, H).map(v => (v + 1) * 1000), dtype: 'uint16',
    });
    assert.throws(
      () => new SequenceSource([...paths, u16], plainFactory),
      (e) => /same shape/.test(e.message)
        && e.message.match(/wrong_dtype\.tif/g).length === 1,
    );
  });

  test('a member that is itself a stack contributes all its pages', () => {
    const multi = path.join('test', 'fixtures', 'stack_f32.tif');
    const meta = new lib.TiffFile(new BufferReader(new Uint8Array(fs.readFileSync(multi)))).meta(0);
    const solo = writeSliceTif(path.join(dir, 'multi', 'a_single.tif'), {
      width: meta.width, height: meta.height, pixels: phantom(meta.width, meta.height),
    });
    const seq = new SequenceSource([solo, multi], plainFactory);

    assert.equal(seq.pageCount, 1 + 7, 'one single page plus the seven in the stack');
    assert.equal(seq.locate(0).fileIndex, 0);
    assert.equal(seq.locate(1).fileIndex, 1);
    assert.equal(seq.locate(1).localPage, 0);
    assert.equal(seq.locate(7).localPage, 6);
    assert.deepEqual(seq.sliceLabels().slice(0, 3),
      ['a_single.tif', 'stack_f32.tif [1/7]', 'stack_f32.tif [2/7]']);
    seq.close();
  });

  test('an index outside the stack fails loudly', () => {
    const seq = new SequenceSource(paths, plainFactory);
    assert.throws(() => seq.decode(COUNT), /outside the stack/);
    assert.throws(() => seq.decode(-1), /outside the stack/);
    seq.close();
  });

  test('an empty selection is refused', () => {
    assert.throws(() => new SequenceSource([], plainFactory), /at least one file/);
  });

  test('only a handful of files stay open, however long the stack', () => {
    const factory = countingFactory();
    const seq = new SequenceSource(paths, factory, 2);
    // Headers are read up front, then every handle is released again.
    assert.equal(factory.counts.opened, COUNT);
    assert.equal(factory.counts.closed, COUNT);

    for (let i = 0; i < COUNT; i++) seq.decode(i);
    assert.ok(seq.openFileCount <= 2, `pool held ${seq.openFileCount} files`);

    seq.close();
    assert.equal(seq.openFileCount, 0);
    assert.equal(factory.counts.closed, factory.counts.opened, 'every handle is given back');
  });

  test('a cached file is not reopened', () => {
    const factory = countingFactory();
    const seq = new SequenceSource(paths, factory, 4);
    const afterHeaders = factory.counts.opened;
    seq.decode(0);
    seq.decode(0);
    seq.decode(0);
    assert.equal(factory.counts.opened, afterHeaders + 1);
    seq.close();
  });
});

describe('SliceSource over a sequence', () => {
  test('serves slices exactly as it does for a single file', () => {
    const seq = new SequenceSource(paths, plainFactory);
    const source = new SliceSource(seq);

    assert.equal(source.pageCount, COUNT);
    assert.equal(source.stack.slices, COUNT);
    assert.equal(source.meta.width, W);

    const probe = 21;
    for (let n = 0; n < COUNT; n++) {
      const payload = source.payload(n);
      assert.equal(payload.index, n);
      assert.equal(payload.width, W);
      assert.equal(payload.height, H);
      assert.equal(payload.dtype, 'float32');
      assert.equal(floatsOf(payload.base64)[probe], expectedValue(W, H, probe, n, COUNT));
    }
    source.dispose();
  });

  // The slices cut a volume at different depths, so what they contain differs,
  // not just their level or contrast. Shifting or scaling one image - which is
  // what earlier demo data did - leaves the histogram over its own min..max
  // identical on every slice, so it could never show the histogram following
  // the slice.
  test('each slice has its own histogram, over one background', () => {
    const source = new SliceSource(new SequenceSource(paths, plainFactory));
    const stats = Array.from({ length: COUNT }, (_, n) => source.payload(n).stats);
    /** Share of pixels that land in a different bin. */
    const moved = (a, b) => a.reduce((d, v, i) => d + Math.abs(v - b[i]), 0) / 2 / stats[0].pixelCount;

    for (let n = 1; n < COUNT; n++) {
      assert.ok(moved(stats[n].histogram, stats[n - 1].histogram) > 0.02,
        `slices ${n} and ${n + 1} have practically the same histogram`);
    }
    // The air plateau stays exactly where it is. That is what lets one display
    // window cover the whole stack instead of each slice needing its own.
    for (let n = 1; n < COUNT; n++) {
      assert.equal(stats[n].min, stats[0].min, `slice ${n} moved the background level`);
    }
    source.dispose();
  });

  test('disposing closes the files underneath', () => {
    const factory = countingFactory();
    const seq = new SequenceSource(paths, factory, 4);
    const source = new SliceSource(seq);
    source.payload(0);
    source.payload(1);
    source.dispose();
    assert.equal(seq.openFileCount, 0);
    assert.equal(factory.counts.closed, factory.counts.opened);
  });
});

describe('a display window for the whole stack', () => {
  /** Slices that sit at very different levels - the case that saturated. */
  function writeShiftedStack(where, count, step) {
    const shape = phantom(W, H);
    return Array.from({ length: count }, (_, n) => {
      const pixels = new Float32Array(shape.length);
      for (let i = 0; i < shape.length; i++) pixels[i] = shape[i] + n * step;
      return writeSliceTif(path.join(where, `s_${String(n + 1).padStart(3, '0')}.tif`),
        { width: W, height: H, pixels });
    });
  }

  const openSeq = ps => new SliceSource(new SequenceSource(ps, plainFactory));
  /** A sequence has one channel, so its stack window is the first one. */
  const stackWindowOf = source => source.stackWindows()?.[0];

  /** Share of pixels that would land strictly inside the window. */
  function insideFraction(source, index, window) {
    const data = source.getSlice(index).data;
    let inside = 0;
    for (const v of data) if (v > window.min && v < window.max) inside++;
    return inside / data.length;
  }

  test('a single image has no stack window', () => {
    const source = openSeq([paths[0]]);
    assert.equal(source.stackWindows(), undefined, 'one page is not a stack');
    source.dispose();
  });

  // The regression: the window came from slice 0 alone, so holding it left
  // every other slice of a stack that moves at all completely white.
  test('every slice is visible under it, even when slices sit far apart', () => {
    const where = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-shift-'));
    try {
      const ps = writeShiftedStack(where, 6, 2);
      const source = openSeq(ps);
      const sliceZeroOnly = require('../dist/lib.cjs').autoAdjust(source.getSlice(0).stats, 0).range;
      const whole = stackWindowOf(source);

      assert.ok(whole, 'a stack should have a window');
      assert.ok(whole.max > sliceZeroOnly.max, 'it has to reach past the first slice');

      for (let n = 0; n < source.pageCount; n++) {
        assert.ok(insideFraction(source, n, whole) > 0.2,
          `slice ${n} is not visible under the stack window`);
      }
      // And the contrast: slice 0's own window blanks the rest, which is the bug.
      const blanked = [1, 2, 3, 4, 5]
        .filter(n => insideFraction(source, n, sliceZeroOnly) === 0);
      assert.equal(blanked.length, 5, 'the old slice-0 window should indeed blank the rest');
      source.dispose();
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  test('it covers the ordinary case too', () => {
    const source = openSeq(paths);
    const whole = stackWindowOf(source);
    for (let n = 0; n < COUNT; n++) {
      assert.ok(insideFraction(source, n, whole) > 0.2, `slice ${n} not visible`);
    }
    source.dispose();
  });

  test('sampling is bounded, so a long stack does not decode end to end', () => {
    const where = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-many-'));
    try {
      const ps = writeShiftedStack(where, 40, 0.1);
      const factory = countingFactory();
      const source = new SliceSource(new SequenceSource(ps, factory, 4));
      const opened = factory.counts.opened;   // 40 header reads at construction
      source.stackWindows();
      assert.ok(factory.counts.opened - opened <= 8,
        `sampled ${factory.counts.opened - opened} files; should be at most 8`);
      source.dispose();
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });
});

describe('sampling a stack for its window', () => {
  /** A stand-in stack that counts how often a page is decoded. */
  function countingPages({ pages = 6, width = 32, height = 32 } = {}) {
    let decodes = 0;
    const meta = i => ({
      index: i, width, height, samplesPerPixel: 1, dtype: 'float32',
      bitsPerSample: [32], compression: 1, compressionName: 'none',
      photometric: 1, planarConfig: 1,
    });
    return {
      pageCount: pages,
      meta,
      stackMeta: () => ({ pages, channels: 1, slices: pages, frames: 1, hyperstack: false, source: 'pages' }),
      decode(i) {
        decodes++;
        const data = new Float32Array(width * height);
        for (let k = 0; k < data.length; k++) data[k] = i + k / data.length;
        return { ...meta(i), data };
      },
      get decodes() { return decodes; },
    };
  }

  // On pages too large for the cache to hold two, sampling used to end on some
  // other slice and evict page 0 - the one the viewer is about to be sent.
  test('it leaves the slice about to be shown in the cache', () => {
    const pages = countingPages({ pages: 6 });
    const source = new SliceSource(pages, 2 * 32 * 32);   // room for two pages
    source.stackWindows();
    const sampled = pages.decodes;
    assert.ok(sampled > 1, 'the survey should decode more than one page (premise)');

    source.payload(0);
    assert.equal(pages.decodes, sampled, 'the first slice should not be decoded a second time');
    source.dispose();
  });
});

describe('a stack window per channel', () => {
  const HYPER = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'imagej_hyperstack.tif');

  // Regression: one window was taken across every page and handed to every
  // channel, so a 0..100 channel opened at 0..5000 and came out nearly black.
  test('a hyperstack is windowed channel by channel', () => {
    const source = new SliceSource(new BufferReader(new Uint8Array(fs.readFileSync(HYPER))));
    const windows = source.stackWindows();
    assert.equal(windows.length, source.stack.channels);
    for (let c = 0; c < windows.length; c++) {
      for (let p = c; p < source.pageCount; p += windows.length) {
        const s = source.getSlice(p).stats;
        assert.ok(windows[c].max <= s.max * 1.01,
          `channel ${c + 1}'s window reaches ${windows[c].max}, past page ${p}'s data (${s.max})`);
      }
    }
    assert.ok(windows[0].max < 200 && windows[1].max > 1000, 'each channel keeps its own scale');
    source.dispose();
  });

  test('a single-channel stack still samples at most eight slices', () => {
    const where = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-budget-'));
    try {
      const ps = writeSequence(where, { count: 40, width: 16, height: 16 });
      const factory = countingFactory();
      const source = new SliceSource(new SequenceSource(ps, factory, 4));
      const opened = factory.counts.opened;
      assert.equal(source.stackWindows().length, 1);
      assert.ok(factory.counts.opened - opened <= 8);
      source.dispose();
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });
});
