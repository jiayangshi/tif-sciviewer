import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TiffFile, BufferReader, SliceSource, computeStats, mapTo8Bit } = require('../dist/lib.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const bytesOf = name => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const openBytes = b => new TiffFile(new BufferReader(b));

/** Every failure has to name what went wrong; a bare "undefined" helps nobody. */
function assertHelpfulThrow(fn, pattern) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a throw');
  assert.ok(err instanceof Error, `expected an Error, got ${typeof err}`);
  assert.ok(err.message && err.message.length > 10, `unhelpfully short message: "${err.message}"`);
  if (pattern) assert.match(err.message, pattern);
  return err;
}

describe('malformed input', () => {
  test('an empty file', () => {
    assertHelpfulThrow(() => openBytes(new Uint8Array(0)));
  });

  test('a file shorter than the header', () => {
    assertHelpfulThrow(() => openBytes(Uint8Array.from([0x49, 0x49])));
  });

  test('a PNG', () => {
    const b = new Uint8Array(256);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assertHelpfulThrow(() => openBytes(b), /Not a TIFF/);
  });

  test('plain text', () => {
    assertHelpfulThrow(() => openBytes(new Uint8Array(Buffer.from('this is not an image at all'))), /Not a TIFF/);
  });

  test('a bogus version number', () => {
    const b = bytesOf('f32_none.tif').slice();
    b[2] = 99; b[3] = 0;
    assertHelpfulThrow(() => openBytes(b), /version/i);
  });

  test('a truncated file still reports its header, then fails on pixels', () => {
    const full = bytesOf('f32_none.tif');
    const cut = full.slice(0, Math.floor(full.length / 2));
    // The IFD lives at the front for tifffile output, so metadata survives.
    const tif = openBytes(cut);
    assert.equal(tif.meta(0).width, 96);
    assertHelpfulThrow(() => tif.decode(0), /past end of file/i);
  });

  test('a strip offset past the end of the file', () => {
    const b = bytesOf('f32_none.tif').slice();
    const tif = openBytes(b);
    // StripOffsets is a LONG; find it in the IFD and point it into space.
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = view.getUint16(8, true);
    for (let i = 0; i < n; i++) {
      const base = 10 + i * 12;
      if (view.getUint16(base, true) === 273) view.setUint32(base + 8, 0x7ffffff0, true);
    }
    assertHelpfulThrow(() => openBytes(b).decode(0), /past end of file/i);
    void tif;
  });

  test('a circular IFD chain terminates instead of hanging', () => {
    const b = bytesOf('stack_f32.tif').slice();
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const first = view.getUint32(4, true);
    const n = view.getUint16(first, true);
    // Point the first IFD's "next" pointer back at itself.
    view.setUint32(first + 2 + n * 12, first, true);
    const tif = openBytes(b);
    assert.equal(tif.pageCount, 1, 'the self-referencing page should be counted once');
  });

  test('an absurd IFD entry count is rejected', () => {
    const b = bytesOf('f32_none.tif').slice();
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint16(8, 60000, true);
    assertHelpfulThrow(() => openBytes(b));
  });

  test('a page index outside the file', () => {
    const tif = openBytes(bytesOf('f32_none.tif'));
    assertHelpfulThrow(() => tif.meta(7), /out of range/);
    assertHelpfulThrow(() => tif.meta(-1), /out of range/);
  });

  test('unsupported compression names the codec and suggests a fix', () => {
    for (const [code, pattern] of [[7, /JPEG/], [34925, /LZMA/], [50000, /Zstd/]]) {
      const b = bytesOf('f32_none.tif').slice();
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const n = view.getUint16(8, true);
      for (let i = 0; i < n; i++) {
        const base = 10 + i * 12;
        if (view.getUint16(base, true) === 259) view.setUint16(base + 8, code, true);
      }
      const err = assertHelpfulThrow(() => openBytes(b).decode(0), pattern);
      assert.match(err.message, /not supported/i);
      assert.match(err.message, /compression|re-save/i, 'should tell the user what to do');
    }
  });

  test('an unknown tag type is skipped rather than fatal', () => {
    const b = bytesOf('f32_none.tif').slice();
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = view.getUint16(8, true);
    // Corrupt the type of a tag we do not need (Software, 305).
    for (let i = 0; i < n; i++) {
      const base = 10 + i * 12;
      if (view.getUint16(base, true) === 305) view.setUint16(base + 2, 999, true);
    }
    const tif = openBytes(b);
    assert.equal(tif.decode(0).width, 96, 'the image should still decode');
  });

  test('a description that is not the JSON we expect is ignored', () => {
    const b = bytesOf('f32_none.tif').slice();
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = view.getUint16(8, true);
    for (let i = 0; i < n; i++) {
      const base = 10 + i * 12;
      if (view.getUint16(base, true) === 270) {
        const off = view.getUint32(base + 8, true);
        b.set(new Uint8Array(Buffer.from('{not valid json at all')), off);
      }
    }
    const tif = openBytes(b);
    assert.equal(tif.stackMeta().source, 'pages', 'should fall back to counting pages');
    assert.equal(tif.decode(0).width, 96);
  });
});

describe('resource limits', () => {
  test('an oversized page is refused with a number and a remedy', () => {
    const src = new SliceSource(new BufferReader(bytesOf('f32_none.tif')), 1024, 1024);
    const err = assertHelpfulThrow(() => src.getSlice(0), /over the/);
    assert.match(err.message, /MB/);
    assert.match(err.message, /maxDecodedMegabytes/, 'should name the setting to change');
  });

  test('a generous limit lets the same page through', () => {
    const src = new SliceSource(new BufferReader(bytesOf('f32_none.tif')), 1e9, 1e9);
    assert.equal(src.getSlice(0).meta.width, 96);
  });
});

describe('degenerate images', () => {
  test('a constant image does not divide by zero', () => {
    const data = new Float32Array(64).fill(7);
    const st = computeStats(data, 'float32');
    assert.equal(st.min, 7);
    assert.equal(st.max, 7);
    assert.equal(st.binSize, 0);
    const out = new Uint8Array(64);
    mapTo8Bit(data, st.min, st.max, out);
    assert.ok(out.every(v => v === 255), 'a flat image should be uniform, not garbage');
  });

  test('an all-NaN image reports no usable statistics', () => {
    const data = new Float32Array(16).fill(NaN);
    const st = computeStats(data, 'float32');
    assert.equal(st.pixelCount, 0);
    assert.equal(st.nonFiniteCount, 16);
    assert.ok(Number.isFinite(st.min) && Number.isFinite(st.max), 'must not leak Infinity into the UI');
  });

  test('statistics ignore Inf but still count it', () => {
    const data = Float32Array.from([1, 2, 3, Infinity, -Infinity, NaN]);
    const st = computeStats(data, 'float32');
    assert.equal(st.pixelCount, 3);
    assert.equal(st.nonFiniteCount, 3);
    assert.equal(st.min, 1);
    assert.equal(st.max, 3);
    assert.equal(st.mean, 2);
  });

  test('a 1x1 image works', () => {
    const st = computeStats(Float32Array.from([42]), 'float32');
    assert.equal(st.pixelCount, 1);
    assert.equal(st.stdDev, 0);
  });
});
