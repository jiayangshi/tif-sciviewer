import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { writeSequence, writeSliceTif } from '../tools/make-sequence.mjs';
import { phantom as phantomOf } from '../tools/phantom.mjs';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const {
  SliceSource, BufferReader, bodyHtml, computeStats, autoAdjust, stretchHistogram,
  resetRange, getLut, mapTo8Bit, composeRGBA, viewOf, fromBase64, SequenceSource,
} = lib;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const VIEWER_JS = fs.readFileSync(path.join(HERE, '..', 'media', 'viewer.js'), 'utf8');

/**
 * A 2D context stub that records what the viewer drew. jsdom has no canvas
 * backend, so this is the seam: everything above it is the real viewer code.
 */
function stubContext(canvas) {
  const ctx = {
    canvas,
    imageSmoothingEnabled: true,
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    _lastImageData: null,
    _drawImageCalls: [],
    _fillRects: [],
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect(...a) { this._fillRects.push(a); },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) { this._lastImageData = img; },
    drawImage(...a) { this._drawImageCalls.push(a); },
  };
  return ctx;
}

function mount() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml()}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // jsdom reports every element as zero-sized; give the layout real numbers.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 600; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 400; }, configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0 };
  };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};
  window.devicePixelRatio = 1;

  const contexts = new Map();
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, stubContext(this));
    return contexts.get(this);
  };
  // jsdom has no canvas backend; stand in for the PNG encoder.
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,aGVsbG8=';
  };

  const posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: m => posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });

  // Run callbacks synchronously so tests need no timers.
  window.requestAnimationFrame = cb => { cb(0); return 0; };

  window.eval(VIEWER_JS);

  const send = msg => {
    const ev = new window.MessageEvent('message', { data: msg });
    window.dispatchEvent(ev);
  };
  const $ = id => window.document.getElementById(id);
  const canvasCtx = () => contexts.get(window.document.getElementById('canvas'));
  const offscreenCtx = () => {
    for (const [el, ctx] of contexts) {
      if (el !== window.document.getElementById('canvas')
        && el !== window.document.getElementById('histogram')) return ctx;
    }
    return null;
  };
  return { window, posted, send, $, canvasCtx, offscreenCtx };
}

function payloadFor(file, index = 0) {
  const src = new SliceSource(new BufferReader(new Uint8Array(fs.readFileSync(file))));
  return { src, payload: src.payload(index) };
}

function initMessage(src, fileName, overrides = {}) {
  return {
    type: 'init',
    fileName,
    fileSize: 1234,
    pageCount: src.pageCount,
    meta: {
      width: src.meta.width, height: src.meta.height, dtype: src.meta.dtype,
      bitsPerSample: src.meta.bitsPerSample[0], samplesPerPixel: src.meta.samplesPerPixel,
      compression: src.meta.compressionName, photometric: src.meta.photometric,
      planarConfig: src.meta.planarConfig, tiled: false,
    },
    stack: src.stack,
    config: {
      autoContrastOnOpen: true, defaultLut: 'Grays',
      recomputeRangePerSlice: false, saturatedPercent: 0.35,
      ...overrides,
    },
  };
}

/** What the reference pipeline produces for a given file and display range. */
function reference(file, range, lutName = 'Grays', index = 0) {
  const src = new SliceSource(new BufferReader(new Uint8Array(fs.readFileSync(file))));
  const p = src.payload(index);
  const data = viewOf(fromBase64(p.base64), p.dtype, p.littleEndian);
  const idx = new Uint8Array(p.width * p.height);
  const mask = new Uint8Array(p.width * p.height);
  mapTo8Bit(data, range.min, range.max, idx, { mask });
  const rgba = new Uint8ClampedArray(p.width * p.height * 4);
  composeRGBA(idx, getLut(lutName), rgba, mask, [255, 64, 64]);
  return { rgba, stats: computeStats(data, p.dtype, p.samplesPerPixel), payload: p, data };
}

/**
 * Messages posted by the viewer are built inside the jsdom realm, so their
 * prototype is not node's Object and assert/strict's deepEqual rejects them on
 * identity. Round-trip through JSON to compare by value.
 */
const plain = x => JSON.parse(JSON.stringify(x));

const REAL = path.join(HERE, '..', 'sample.tif');
const CT = path.join(FIX, 'f32_ct_like.tif');
const STACK = path.join(FIX, 'stack_f32.tif');

describe('webview end to end', () => {
  test('announces itself as ready on load', () => {
    const { posted } = mount();
    assert.deepEqual(plain(posted), [{ type: 'ready' }]);
  });

  test('renders a float32 CT slice exactly like the reference pipeline', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);

    const stats = computeStats(
      viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian),
      payload.dtype, payload.samplesPerPixel,
    );
    const expectedRange = autoAdjust(stats, 0).range;
    const ref = reference(CT, expectedRange);

    const drawn = h.offscreenCtx()._lastImageData;
    assert.ok(drawn, 'the viewer should have pushed an ImageData');
    assert.equal(drawn.width, payload.width);
    assert.equal(drawn.height, payload.height);
    assert.equal(drawn.data.length, ref.rgba.length);
    for (let i = 0; i < ref.rgba.length; i++) {
      assert.equal(drawn.data[i], ref.rgba[i], `rgba byte ${i}`);
    }
  });

  test('auto-contrasts on open, and the numeric fields agree', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif'));
    h.send(payload);

    const stats = computeStats(
      viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian), payload.dtype,
    );
    const expected = autoAdjust(stats, 0).range;
    assert.ok(Math.abs(Number(h.$('input-min').value) - expected.min) < 1e-3, h.$('input-min').value);
    assert.ok(Math.abs(Number(h.$('input-max').value) - expected.max) < 1e-3, h.$('input-max').value);
    // The whole point: the auto range must be far tighter than the data range.
    assert.ok(expected.max < stats.max - 0.5, 'auto contrast should not just be the full range');
  });

  test('opening with auto contrast disabled uses the full data range', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif', { autoContrastOnOpen: false }));
    h.send(payload);
    assert.ok(Math.abs(Number(h.$('input-min').value) - payload.stats.min) < 1e-3);
    assert.ok(Math.abs(Number(h.$('input-max').value) - payload.stats.max) < 1e-3);
  });

  test('pressing Auto repeatedly keeps tightening the range', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif', { autoContrastOnOpen: false }));
    h.send(payload);

    const seen = [];
    for (let i = 0; i < 4; i++) {
      h.$('btn-auto').click();
      seen.push(Number(h.$('input-max').value) - Number(h.$('input-min').value));
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] <= seen[i - 1], `press ${i + 1} widened the range: ${seen}`);
    }
    assert.ok(seen[3] < seen[0], 'repeated presses should have some effect');
  });

  test('Reset restores the full data range', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    h.$('btn-reset').click();
    const full = resetRange(payload.stats);
    assert.ok(Math.abs(Number(h.$('input-min').value) - full.min) < 1e-3);
    assert.ok(Math.abs(Number(h.$('input-max').value) - full.max) < 1e-3);
  });

  test('Enhance applies the saturated stretch', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif'));
    h.send(payload);
    h.$('btn-enhance').click();
    const stats = computeStats(
      viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian), payload.dtype,
    );
    const expected = stretchHistogram(stats, 0.35);
    assert.ok(Math.abs(Number(h.$('input-min').value) - expected.min) < 1e-3);
    assert.ok(Math.abs(Number(h.$('input-max').value) - expected.max) < 1e-3);
  });

  test('typing an exact range re-renders to that range', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);

    h.$('input-min').value = '-0.5';
    h.$('input-max').value = '0.25';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));

    const ref = reference(CT, { min: -0.5, max: 0.25 });
    const drawn = h.offscreenCtx()._lastImageData;
    for (let i = 0; i < ref.rgba.length; i += 997) {
      assert.equal(drawn.data[i], ref.rgba[i], `rgba byte ${i}`);
    }
  });

  test('an invalid typed range is rejected and the fields snap back', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    const before = h.$('input-min').value;

    h.$('input-min').value = '5';      // min above max
    h.$('input-max').value = '1';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));
    assert.equal(h.$('input-min').value, before, 'should have reverted');

    h.$('input-min').value = 'not a number';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));
    assert.equal(h.$('input-min').value, before, 'should have reverted');
  });

  test('changing the LUT recolours without touching the display range', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    const rangeBefore = [h.$('input-min').value, h.$('input-max').value];

    h.$('select-lut').value = 'Fire';
    h.$('select-lut').dispatchEvent(new h.window.Event('change'));

    const stats = computeStats(
      viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian), payload.dtype,
    );
    const ref = reference(CT, autoAdjust(stats, 0).range, 'Fire');
    const drawn = h.offscreenCtx()._lastImageData;
    for (let i = 0; i < ref.rgba.length; i += 991) {
      assert.equal(drawn.data[i], ref.rgba[i], `rgba byte ${i}`);
    }
    assert.deepEqual([h.$('input-min').value, h.$('input-max').value], rangeBefore);
  });

  test('the sidebar reports dimensions, dtype and statistics', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif'));
    h.send(payload);
    const info = h.$('info').textContent;
    assert.match(info, /512 × 512/);
    assert.match(info, /float32/);
    assert.equal(h.$('file-name').textContent, 'sample.tif');
    const stats = h.$('stats').textContent;
    assert.match(stats, /Data min/);
    assert.match(stats, /-1/);
    assert.match(stats, /Mean/);
  });

  test('NaN and Inf counts are surfaced', () => {
    const h = mount();
    const file = path.join(FIX, 'f32_nan_inf.tif');
    const { src, payload } = payloadFor(file);
    h.send(initMessage(src, 'f32_nan_inf.tif'));
    h.send(payload);
    assert.match(h.$('stats').textContent, /NaN \/ Inf/);
    assert.match(h.$('stats').textContent, /3/);
  });

  test('stack controls appear only for multi-page files, and request slices', () => {
    const single = mount();
    const s1 = payloadFor(CT);
    single.send(initMessage(s1.src, 'f32_ct_like.tif'));
    single.send(s1.payload);
    assert.equal(single.$('stack-panel').hasAttribute('hidden'), true);

    const h = mount();
    const { src, payload } = payloadFor(STACK);
    h.send(initMessage(src, 'stack_f32.tif'));
    h.send(payload);
    assert.equal(h.$('stack-panel').hasAttribute('hidden'), false);
    assert.equal(h.$('slider-slice').max, '6');
    assert.match(h.$('slice-label').textContent, /z 1\/7/);
    assert.equal(h.$('row-c').hasAttribute('hidden'), true, 'no channel slider for a plain stack');
    assert.equal(h.$('row-t').hasAttribute('hidden'), true, 'no frame slider for a plain stack');

    h.$('slider-slice').value = '4';
    h.$('slider-slice').dispatchEvent(new h.window.Event('input'));
    const req = h.posted.filter(m => m.type === 'requestSlice');
    assert.deepEqual(plain(req), [{ type: 'requestSlice', index: 4 }]);
    assert.match(h.$('slice-label').textContent, /z 5\/7/);

    h.send(src.payload(4));
    const ref = reference(STACK, { min: Number(h.$('input-min').value), max: Number(h.$('input-max').value) }, 'Grays', 4);
    const drawn = h.offscreenCtx()._lastImageData;
    for (let i = 0; i < ref.rgba.length; i += 883) assert.equal(drawn.data[i], ref.rgba[i], `byte ${i}`);
  });

  test('the display range is held across slices by default', () => {
    const h = mount();
    const { src, payload } = payloadFor(STACK);
    h.send(initMessage(src, 'stack_f32.tif'));
    h.send(payload);
    h.$('input-min').value = '-0.4';
    h.$('input-max').value = '0.3';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));

    h.send(src.payload(5));
    assert.ok(Math.abs(Number(h.$('input-min').value) - (-0.4)) < 1e-6, h.$('input-min').value);
    assert.ok(Math.abs(Number(h.$('input-max').value) - 0.3) < 1e-6, h.$('input-max').value);
  });

  test('per-slice recomputation re-autos on every slice when asked', () => {
    const h = mount();
    const { src, payload } = payloadFor(STACK);
    h.send(initMessage(src, 'stack_f32.tif', { recomputeRangePerSlice: true }));
    h.send(payload);
    const first = Number(h.$('input-max').value);
    h.send(src.payload(6));
    const later = Number(h.$('input-max').value);
    // Each fixture slice is shifted by 0.05, so six slices on it must move.
    assert.ok(Math.abs(later - first) > 0.1, `expected the range to follow the slice: ${first} -> ${later}`);
  });

  test('keyboard arrows step through the stack', () => {
    const h = mount();
    const { src, payload } = payloadFor(STACK);
    h.send(initMessage(src, 'stack_f32.tif'));
    h.send(payload);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.deepEqual(plain(h.posted.filter(m => m.type === 'requestSlice')), [{ type: 'requestSlice', index: 1 }]);
    // Must not run off the start of the stack.
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const idx = h.posted.filter(m => m.type === 'requestSlice').map(m => Number(m.index));
    assert.deepEqual(idx, [1, 0]);
  });

  test('keyboard shortcuts drive contrast', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif'));
    h.send(payload);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    assert.ok(Math.abs(Number(h.$('input-max').value) - payload.stats.max) < 1e-3, 'r resets');
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    assert.ok(Number(h.$('input-max').value) < payload.stats.max - 0.5, 'a auto-contrasts');
  });

  test('typing in a text field does not trigger shortcuts', () => {
    const h = mount();
    const { src, payload } = payloadFor(REAL);
    h.send(initMessage(src, 'sample.tif'));
    h.send(payload);
    const before = h.$('input-max').value;
    const ev = new h.window.KeyboardEvent('keydown', { key: 'r', bubbles: true });
    h.$('input-min').dispatchEvent(ev);
    assert.equal(h.$('input-max').value, before, 'r inside an input must be a literal r');
  });

  test('zoom steps along the ImageJ ladder and the label follows', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);

    h.$('btn-100').click();
    assert.match(h.$('zoom-label').textContent, /^100%/);
    h.$('btn-zoom-in').click();
    assert.match(h.$('zoom-label').textContent, /^150%/);
    h.$('btn-zoom-in').click();
    assert.match(h.$('zoom-label').textContent, /^200%/);
    h.$('btn-zoom-out').click();
    assert.match(h.$('zoom-label').textContent, /^150%/);
    h.$('btn-zoom-out').click();
    assert.match(h.$('zoom-label').textContent, /^100%/);
  });

  test('drawing never smooths', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    assert.equal(h.canvasCtx().imageSmoothingEnabled, false);
    assert.ok(h.canvasCtx()._drawImageCalls.length > 0, 'should have drawn');
  });

  test('an error message is shown and reported', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send({ type: 'error', message: 'LZMA compression is not supported', fatal: true });
    assert.equal(h.$('overlay-error').hasAttribute('hidden'), false);
    assert.match(h.$('overlay-error').textContent, /LZMA/);
    assert.ok(h.posted.some(m => m.type === 'reportError'), 'should have told the extension host');
  });

  test('a later good slice clears a previous error', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send({ type: 'error', message: 'transient', fatal: false });
    h.send(payload);
    assert.equal(h.$('overlay-error').hasAttribute('hidden'), true);
  });

  test('Copy sends the current range to the extension host', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    h.$('btn-copy').click();
    const copy = h.posted.find(m => m.type === 'copy');
    assert.ok(copy, 'expected a copy message');
    assert.match(copy.text, /min=.*max=/);
  });

  test('the LUT picker is disabled for RGB images', () => {
    const h = mount();
    const file = path.join(FIX, 'rgb_u8.tif');
    const { src, payload } = payloadFor(file);
    h.send(initMessage(src, 'rgb_u8.tif'));
    h.send(payload);
    assert.equal(h.$('select-lut').disabled, true);
    const drawn = h.offscreenCtx()._lastImageData;
    assert.ok(drawn, 'RGB images should still render');
    assert.equal(drawn.width, payload.width);
  });

  test('a hyperstack gets channel, slice and frame axes', () => {
    const h = mount();
    const file = path.join(FIX, 'imagej_hyperstack.tif');
    const { src, payload } = payloadFor(file);
    assert.equal(src.stack.channels, 2);
    assert.equal(src.stack.slices, 3);
    assert.equal(src.stack.frames, 2);

    h.send(initMessage(src, 'imagej_hyperstack.tif'));
    h.send(payload);
    assert.equal(h.$('row-c').hasAttribute('hidden'), false);
    assert.equal(h.$('row-t').hasAttribute('hidden'), false);
    assert.equal(h.$('slider-c').max, '1');
    assert.equal(h.$('slider-t').max, '1');
    assert.equal(h.$('slider-slice').max, '2');
    assert.match(h.$('slice-label').textContent, /c 1\/2.*z 1\/3.*t 1\/2/);
  });

  test('hyperstack axes map onto page indices in ImageJ c,z,t order', () => {
    const h = mount();
    const file = path.join(FIX, 'imagej_hyperstack.tif');
    const { src, payload } = payloadFor(file);
    h.send(initMessage(src, 'imagej_hyperstack.tif'));
    h.send(payload);

    const requestFor = (c, z, t) => {
      h.posted.length = 0;
      h.$('slider-c').value = String(c); h.$('slider-c').dispatchEvent(new h.window.Event('input'));
      h.$('slider-slice').value = String(z); h.$('slider-slice').dispatchEvent(new h.window.Event('input'));
      h.$('slider-t').value = String(t); h.$('slider-t').dispatchEvent(new h.window.Event('input'));
      const reqs = h.posted.filter(m => m.type === 'requestSlice');
      return reqs.length ? Number(reqs[reqs.length - 1].index) : null;
    };
    // page = t*channels*slices + z*channels + c
    assert.equal(requestFor(1, 0, 0), 1);
    assert.equal(requestFor(0, 1, 0), 2);
    assert.equal(requestFor(0, 0, 1), 6);
    assert.equal(requestFor(1, 2, 1), 11);
  });

  test('each channel keeps its own display range', () => {
    const h = mount();
    const file = path.join(FIX, 'imagej_hyperstack.tif');
    const { src, payload } = payloadFor(file);
    h.send(initMessage(src, 'imagej_hyperstack.tif'));
    h.send(payload);

    // Channel 0 spans ~0..100, channel 1 spans ~0..5000 in the fixture.
    const c0 = Number(h.$('input-max').value);
    h.$('slider-c').value = '1';
    h.$('slider-c').dispatchEvent(new h.window.Event('input'));
    h.send(src.payload(1));
    const c1 = Number(h.$('input-max').value);
    assert.ok(c1 > c0 * 5, `channel 1 should get its own, much wider range: ${c0} vs ${c1}`);

    // Going back to channel 0 must restore its range, not reuse channel 1's.
    h.$('slider-c').value = '0';
    h.$('slider-c').dispatchEvent(new h.window.Event('input'));
    h.send(src.payload(0));
    assert.ok(Math.abs(Number(h.$('input-max').value) - c0) < 1e-6,
      `expected channel 0 range back: ${h.$('input-max').value} vs ${c0}`);
  });

  test('Save PNG hands the host a data URL for the current view', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    h.$('btn-save').click();
    const save = h.posted.find(m => m.type === 'savePng');
    assert.ok(save, 'expected a savePng message');
    assert.match(save.dataUrl, /^data:image\/png;base64,/);
    assert.equal(Number(save.sliceIndex), 0);
  });

  test('the histogram is drawn with the display range shaded', () => {
    const h = mount();
    const { src, payload } = payloadFor(CT);
    h.send(initMessage(src, 'f32_ct_like.tif'));
    h.send(payload);
    const hist = h.window.document.getElementById('histogram');
    const ctx = h.window.HTMLCanvasElement.prototype.getContext.call(hist);
    assert.ok(ctx._fillRects.length > 200, 'expected a bar per histogram bin plus the shading');
  });
});

describe('a stack built from separate files', () => {
  const COUNT = 5, SW = 40, SH = 24;
  let dir, paths, seq, src, labels;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-seq-view-'));
    paths = writeSequence(dir, { count: COUNT, width: SW, height: SH });
    seq = new SequenceSource(paths, id => new BufferReader(new Uint8Array(fs.readFileSync(id))));
    src = new SliceSource(seq);
    labels = seq.sliceLabels();
  });
  after(() => { src.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

  const initForSequence = () => ({
    ...initMessage(src, `${path.basename(dir)}  (${COUNT} files)`),
    sequence: { count: COUNT, labels },
  });

  /** The reference pipeline, for a payload that came from a sequence. */
  const expectedRgba = (payload, range) => {
    const data = viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian);
    const idx = new Uint8Array(payload.width * payload.height);
    const mask = new Uint8Array(payload.width * payload.height);
    mapTo8Bit(data, range.min, range.max, idx, { mask });
    const rgba = new Uint8ClampedArray(payload.width * payload.height * 4);
    composeRGBA(idx, getLut('Grays'), rgba, mask, [255, 64, 64]);
    return rgba;
  };

  test('the slider spans the files and names the one on screen', () => {
    const h = mount();
    h.send(initForSequence());
    h.send(src.payload(0));

    assert.equal(h.$('stack-panel').hasAttribute('hidden'), false, 'a multi-file stack is a stack');
    assert.equal(h.$('slider-slice').max, String(COUNT - 1));
    assert.match(h.$('slice-label').textContent, /z 1\/5/);
    assert.match(h.$('slice-label').textContent, /slice_0001\.tif/);
    assert.equal(h.$('row-c').hasAttribute('hidden'), true, 'no channel axis in a file sequence');
    assert.equal(h.$('row-t').hasAttribute('hidden'), true, 'no frame axis in a file sequence');
    assert.match(h.$('file-name').textContent, /\(5 files\)/);
  });

  test('dragging the slider asks for the right file and relabels', () => {
    const h = mount();
    h.send(initForSequence());
    h.send(src.payload(0));

    h.$('slider-slice').value = '3';
    h.$('slider-slice').dispatchEvent(new h.window.Event('input'));

    assert.deepEqual(plain(h.posted.filter(m => m.type === 'requestSlice')),
      [{ type: 'requestSlice', index: 3 }]);
    assert.match(h.$('slice-label').textContent, /z 4\/5/);
    assert.match(h.$('slice-label').textContent, /slice_0004\.tif/);
  });

  test('the pixels drawn are the ones in that file', () => {
    const h = mount();
    h.send(initForSequence());
    h.send(src.payload(0));
    const firstDraw = Uint8ClampedArray.from(h.offscreenCtx()._lastImageData.data);

    h.send(src.payload(4));
    const range = { min: Number(h.$('input-min').value), max: Number(h.$('input-max').value) };
    const drawn = h.offscreenCtx()._lastImageData;
    const want = expectedRgba(src.payload(4), range);
    for (let i = 0; i < want.length; i += 397) assert.equal(drawn.data[i], want[i], `byte ${i}`);

    // Compare the whole frame, not a corner: the corner is background, which is
    // identical on every slice by design.
    assert.ok(drawn.data.some((v, i) => v !== firstDraw[i]),
      'the last slice must not still be showing the first file');
  });

  // Guards the question "why is every slice's histogram the same?": the viewer
  // must draw the histogram of the slice on screen, never a leftover one.
  test('the histogram drawn is the one of the slice on screen', () => {
    const h = mount();
    h.send(initForSequence());
    const histCtx = h.window.HTMLCanvasElement.prototype.getContext.call(h.$('histogram'));
    const barsFor = hist => {
      const peak = Math.max(...hist);
      return Array.from(hist, c => (Math.log1p(c) / Math.log1p(peak)) * 88);
    };

    const drawn = [];
    for (let n = 0; n < COUNT; n++) {
      histCtx._fillRects.length = 0;
      const payload = src.payload(n);
      h.send(payload);
      // Worked out again from the pixels themselves, not from the payload's stats.
      const data = viewOf(fromBase64(payload.base64), payload.dtype, payload.littleEndian);
      const want = barsFor(computeStats(data, payload.dtype).histogram);
      const bars = histCtx._fillRects.slice(0, 256).map(r => r[3]);
      bars.forEach((b, i) => assert.ok(Math.abs(b - want[i]) < 1e-9, `slice ${n + 1}, bin ${i}`));
      drawn.push(bars.join());
    }
    assert.equal(new Set(drawn).size, COUNT, 'every slice of this stack has a histogram of its own');
  });

  test('arrow keys step from file to file', () => {
    const h = mount();
    h.send(initForSequence());
    h.send(src.payload(0));

    for (let i = 0; i < 3; i++) {
      h.window.document.dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      h.send(src.payload(i + 1));
    }
    assert.deepEqual(h.posted.filter(m => m.type === 'requestSlice').map(m => Number(m.index)), [1, 2, 3]);
    assert.match(h.$('slice-label').textContent, /slice_0004\.tif/);
  });

  test('the display range is held across files, as it is within one stack', () => {
    const h = mount();
    h.send(initForSequence());
    h.send(src.payload(0));
    const min = h.$('input-min').value, max = h.$('input-max').value;

    h.send(src.payload(4));
    assert.equal(h.$('input-min').value, min, 'slice 5 must not re-window on its own');
    assert.equal(h.$('input-max').value, max);
  });
});

describe('display range across a stack', () => {
  const HYPER = path.join(FIX, 'imagej_hyperstack.tif');

  const rangeOf = h => ({
    min: Number(h.$('input-min').value),
    max: Number(h.$('input-max').value),
  });
  const controlsOf = h => ({
    min: h.$('slider-min').value,
    max: h.$('slider-max').value,
    brightness: h.$('slider-brightness').value,
    contrast: h.$('slider-contrast').value,
  });
  const click = (h, id) => h.$(id).dispatchEvent(new h.window.Event('click'));
  const openStack = (file = STACK, overrides = {}) => {
    const h = mount();
    const { src, payload } = payloadFor(file);
    h.send(initMessage(src, path.basename(file), overrides));
    h.send(payload);
    return { h, src };
  };

  /** A multi-file sequence, which is the other way to land in a stack. */
  function openSequence() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-rng-'));
    const paths = writeSequence(dir, { count: 5, width: 40, height: 24 });
    const seq = new SequenceSource(paths, id => new BufferReader(new Uint8Array(fs.readFileSync(id))));
    const src = new SliceSource(seq);
    const h = mount();
    h.send({
      ...initMessage(src, 'recon  (5 files)'),
      sequence: { count: 5, labels: seq.sliceLabels() },
    });
    h.send(src.payload(0));
    return { h, src, cleanup: () => { src.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  test('a range set with Auto survives every other slice', () => {
    const { h, src } = openStack();
    click(h, 'btn-auto');
    const chosen = rangeOf(h);

    for (const i of [1, 3, 6, 2, 0]) {
      h.send(src.payload(i));
      assert.deepEqual(rangeOf(h), chosen, `slice ${i} should still be windowed at the chosen range`);
    }
  });

  test('a range set with Enhance survives too', () => {
    const { h, src } = openStack();
    click(h, 'btn-enhance');
    const chosen = rangeOf(h);
    h.send(src.payload(5));
    assert.deepEqual(rangeOf(h), chosen);
  });

  test('a range typed in by hand survives', () => {
    const { h, src } = openStack();
    h.$('input-min').value = '0.1';
    h.$('input-max').value = '0.5';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));
    assert.deepEqual(rangeOf(h), { min: 0.1, max: 0.5 });

    h.send(src.payload(4));
    assert.deepEqual(rangeOf(h), { min: 0.1, max: 0.5 }, 'typing a range must not be undone by scrubbing');
  });

  test('a range set by dragging the slider survives', () => {
    const { h, src } = openStack();
    h.$('slider-min').value = '300';
    h.$('slider-min').dispatchEvent(new h.window.Event('input'));
    const chosen = rangeOf(h);
    h.send(src.payload(6));
    assert.deepEqual(rangeOf(h), chosen);
  });

  const slide = (h, id, raw) => {
    h.$(id).value = String(raw);
    h.$(id).dispatchEvent(new h.window.Event('input'));
  };
  /** The numeric fields show four decimals. */
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  /** Where a value sits on a slider spanning `data`, as the viewer rounds it. */
  const sliderAt = (v, data) =>
    String(Math.min(1000, Math.max(0, Math.round(((v - data.min) / (data.max - data.min)) * 1000))));

  // ImageJ's Min and Max sliders span the data of the image on screen. They
  // used to sit on one axis fixed for the whole stack, which on stack_f32.tif
  // (each page 0.05 higher than the last) let them reach below the data on
  // later slices and never reach its top.
  test('the Min and Max sliders reach exactly the data of the slice on screen', () => {
    const { h, src } = openStack();
    for (const i of [0, 3, 6]) {
      h.send(src.payload(i));
      const { min, max } = src.getSlice(i).stats;
      slide(h, 'slider-min', 0);
      assert.ok(near(rangeOf(h).min, min), `slice ${i}: Min slider stops at ${rangeOf(h).min}, data min is ${min}`);
      slide(h, 'slider-max', 1000);
      assert.ok(near(rangeOf(h).max, max), `slice ${i}: Max slider stops at ${rangeOf(h).max}, data max is ${max}`);
      for (const raw of [0, 250, 500, 750, 1000]) {
        for (const id of ['slider-min', 'slider-max']) {
          slide(h, id, raw);
          const r = rangeOf(h);
          assert.ok(r.min >= min - 1e-3 && r.max <= max + 1e-3,
            `slice ${i}: ${id} at ${raw} gave ${r.min}..${r.max}, outside the data ${min}..${max}`);
        }
      }
    }
  });

  // The display range is held; the handles move to show where it sits in each
  // slice's data, just as the histogram's lines do.
  test('across files the range is held and the handles follow each file\'s data', () => {
    const { h, src, cleanup } = openSequence();
    try {
      click(h, 'btn-auto');
      const range = rangeOf(h);
      for (const i of [1, 2, 3, 4]) {
        h.send(src.payload(i));
        assert.deepEqual(rangeOf(h), range, `slice ${i} range`);
        const data = src.getSlice(i).stats;
        assert.equal(h.$('slider-min').value, sliderAt(range.min, data), `slice ${i} Min handle`);
        assert.equal(h.$('slider-max').value, sliderAt(range.max, data), `slice ${i} Max handle`);
      }
    } finally {
      cleanup();
    }
  });

  test('re-adjusting on a later slice replaces the range from then on', () => {
    const { h, src } = openStack();
    const initial = rangeOf(h);

    h.send(src.payload(4));
    click(h, 'btn-auto');                       // unhappy with slice 0's window
    const revised = rangeOf(h);
    assert.notDeepEqual(revised, initial, 'Auto on slice 4 should pick its own window');

    for (const i of [5, 6, 0]) {
      h.send(src.payload(i));
      assert.deepEqual(rangeOf(h), revised, `slice ${i} should carry the revised range`);
    }
  });

  // Typing is ImageJ's Set: any range is allowed. The sliders still span only
  // the data - they pin at its ends rather than stretching to the typed range -
  // and moving one pulls both ends back inside it (ContrastAdjuster.adjustMin).
  test('a typed range may go past the data, but the sliders stop at it', () => {
    const { h, src } = openStack();   // stack_f32.tif slice 0 spans about -1 .. 0.98
    const data = src.getSlice(0).stats;
    h.$('input-min').value = '-5';
    h.$('input-max').value = '5';
    h.$('input-min').dispatchEvent(new h.window.Event('change'));
    assert.deepEqual(rangeOf(h), { min: -5, max: 5 });
    assert.equal(h.$('slider-min').value, '0', 'pinned at the bottom of the data');
    assert.equal(h.$('slider-max').value, '1000', 'pinned at the top of the data');

    slide(h, 'slider-min', 250);
    const quarter = data.min + 0.25 * (data.max - data.min);
    assert.ok(near(rangeOf(h).min, quarter), `a quarter of the way along the data is ${quarter}, got ${rangeOf(h).min}`);
    assert.ok(near(rangeOf(h).max, data.max), `the max end should come back to the data max, got ${rangeOf(h).max}`);
  });

  // The usual way to hold a range reaching past a slice: it came from another.
  test('a range held from other slices is pulled inside this one by the sliders', () => {
    const { h, src, count, cleanup } = openShiftedStack();
    try {
      const held = rangeOf(h);
      const data = src.getSlice(0).stats;
      assert.ok(held.max > data.max, 'the stack window reaches past slice 1 (premise)');
      slide(h, 'slider-min', 100);
      assert.ok(near(rangeOf(h).max, data.max), `max should be pulled to ${data.max}, got ${rangeOf(h).max}`);

      h.send(src.payload(count - 1));
      const top = src.getSlice(count - 1).stats;
      slide(h, 'slider-max', 900);
      assert.ok(rangeOf(h).min >= top.min - 1e-3, `min should be pulled up to at least ${top.min}, got ${rangeOf(h).min}`);
    } finally {
      cleanup();
    }
  });

  // The histogram's axis can run past the data: an 8-bit histogram spans the
  // whole of -128..127 even when the data stops at 126.
  test('dragging a histogram handle stops at the data too', () => {
    const h = mount();
    const { src, payload } = payloadFor(path.join(FIX, 'i8_none.tif'));
    h.send(initMessage(src, 'i8_none.tif'));
    h.send(payload);
    const data = src.getSlice(0).stats;
    assert.ok(data.histMax > data.max, 'the histogram reaches past the data (premise)');

    h.$('handle-max').dispatchEvent(new h.window.PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    h.window.dispatchEvent(new h.window.PointerEvent('pointermove', { clientX: 10000, pointerId: 1 }));
    h.window.dispatchEvent(new h.window.PointerEvent('pointerup', { pointerId: 1 }));
    assert.equal(rangeOf(h).max, data.max);
  });

  /** A stack whose slices sit at very different levels. */
  function openShiftedStack(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-white-'));
    const w = 40, h = 24, count = 5;
    const shape = phantomOf(w, h);
    const paths = Array.from({ length: count }, (_, n) => {
      const pixels = new Float32Array(shape.length);
      for (let i = 0; i < shape.length; i++) pixels[i] = shape[i] + n * 2;
      return writeSliceTif(path.join(dir, `s_${n + 1}.tif`), { width: w, height: h, pixels });
    });
    const seq = new SequenceSource(paths, id => new BufferReader(new Uint8Array(fs.readFileSync(id))));
    const src = new SliceSource(seq);
    const h2 = mount();
    h2.send({
      ...initMessage(src, 'shifted', overrides),
      sequence: { count, labels: seq.sliceLabels() },
      stackAuto: src.stackWindows(),
    });
    h2.send(src.payload(0));
    return { h: h2, src, count, cleanup: () => { src.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  /** Share of drawn pixels that came out pure white. */
  const whiteFraction = h => {
    const d = h.offscreenCtx()._lastImageData.data;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
    return white / (d.length / 4);
  };

  // What the bug looked like: hold the window from slice 1 and every later
  // slice of a stack that moves at all is drawn as a flat white rectangle.
  test('no slice is drawn as flat white', () => {
    const { h, src, count, cleanup } = openShiftedStack();
    try {
      for (let n = 0; n < count; n++) {
        h.send(src.payload(n));
        assert.ok(whiteFraction(h) < 0.9,
          `slice ${n} came out ${(whiteFraction(h) * 100).toFixed(0)}% pure white`);
      }
    } finally {
      cleanup();
    }
  });

  test('the opening window is the stack\'s, not the first slice\'s', () => {
    const { h, src, cleanup } = openShiftedStack();
    try {
      const opened = rangeOf(h);
      const sliceZero = src.getSlice(0).stats;
      assert.ok(opened.max > sliceZero.max,
        'the window must reach past slice 1, or the rest of the stack saturates');
      // And it is still just a range: held, and adjustable, like any other.
      h.send(src.payload(3));
      assert.deepEqual(rangeOf(h), opened);
    } finally {
      cleanup();
    }
  });

  test('"recompute per slice" ignores the stack window and follows the slice', () => {
    const { h, src, cleanup } = openShiftedStack({ recomputeRangePerSlice: true });
    try {
      const first = rangeOf(h);
      h.send(src.payload(4));
      assert.notDeepEqual(rangeOf(h), first, 'per-slice mode must still re-window');
      assert.ok(whiteFraction(h) < 0.9);
    } finally {
      cleanup();
    }
  });

  test('"recompute per slice" still follows each slice', () => {
    const { h, src } = openStack(STACK, { recomputeRangePerSlice: true });
    const first = rangeOf(h);
    h.send(src.payload(6));
    assert.notDeepEqual(rangeOf(h), first,
      'the opt-in per-slice mode must still re-window on every slice');
  });

  test('each channel of a hyperstack keeps its own axis', () => {
    const h = mount();
    const { src } = payloadFor(HYPER);
    h.send(initMessage(src, 'imagej_hyperstack.tif'));
    h.send(src.payload(0));
    const c0 = { range: rangeOf(h), controls: controlsOf(h) };

    h.$('slider-c').value = '1';
    h.$('slider-c').dispatchEvent(new h.window.Event('input'));
    h.send(src.payload(1));
    assert.notDeepEqual(rangeOf(h), c0.range, 'the second channel has its own scale');

    h.$('slider-c').value = '0';
    h.$('slider-c').dispatchEvent(new h.window.Event('input'));
    h.send(src.payload(0));
    assert.deepEqual(rangeOf(h), c0.range, 'going back restores channel 1');
    assert.deepEqual(controlsOf(h), c0.controls, 'and its controls, unmoved');
  });

  // Regression: one stack window was taken across all pages and given to every
  // channel, so the 0..100 channel opened at 0..5000 and came out nearly black.
  test('each channel of a hyperstack opens at its own window, not one taken across channels', () => {
    const h = mount();
    const { src } = payloadFor(HYPER);
    h.send({ ...initMessage(src, 'imagej_hyperstack.tif'), stackAuto: src.stackWindows() });
    h.send(src.payload(0));
    assert.ok(rangeOf(h).max < 200, `channel 1 (data 0..100) opened at ${rangeOf(h).min}..${rangeOf(h).max}`);

    h.$('slider-c').value = '1';
    h.$('slider-c').dispatchEvent(new h.window.Event('input'));
    h.send(src.payload(1));
    assert.ok(rangeOf(h).max > 1000, `channel 2 (data 0..5000) opened at ${rangeOf(h).min}..${rangeOf(h).max}`);
  });
});
