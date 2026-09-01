import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const {
  SliceSource, BufferReader, bodyHtml, computeStats, autoAdjust, stretchHistogram,
  resetRange, getLut, mapTo8Bit, composeRGBA, viewOf, fromBase64,
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
