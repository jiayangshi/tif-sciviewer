/**
 * The viewer surface. Everything numeric lives in ../imagej/* so that the
 * behaviour here is the same code the Node tests exercise.
 */
import { Stats, N_BINS } from '../imagej/stats';
import { autoAdjust, stretchHistogram, resetRange, fromBrightnessContrast, toBrightnessContrast, Range } from '../imagej/contrast';
import { getLut, LUT_NAMES } from '../imagej/luts';
import { mapTo8Bit, composeRGBA, renderColor, formatValue } from '../imagej/render';
import { DType, NumericArray } from '../tiff/types';
import { fromBase64, viewOf, SlicePayload } from '../wire';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();

/** ImageJ's zoom ladder (ij.gui.ImageCanvas.zoomLevels). */
const ZOOM_LEVELS = [
  1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 0.75,
  1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32,
];

interface InitMessage {
  fileName: string;
  fileSize: number;
  pageCount: number;
  meta: {
    width: number; height: number; dtype: DType; bitsPerSample: number;
    samplesPerPixel: number; compression: string; photometric: number;
    planarConfig: number; tiled: boolean; software?: string; description?: string;
    resolution?: { x: number; y: number; unit: number };
  };
  stack: {
    pages: number; channels: number; slices: number; frames: number;
    hyperstack: boolean; savedMin?: number; savedMax?: number; unit?: string;
    shape?: number[]; source: string;
  };
  /** Present when the stack was assembled from several files. */
  sequence?: { count: number; labels: string[] };
  /**
   * Opening window computed across the stack, not just its first slice - one
   * per channel. An entry is null where the host could not find one.
   */
  stackAuto?: ({ min: number; max: number } | null)[];
  config: {
    autoContrastOnOpen: boolean; defaultLut: string;
    recomputeRangePerSlice: boolean; saturatedPercent: number;
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

class Viewer {
  private init?: InitMessage;
  private data?: NumericArray;
  private stats?: Stats;
  private sliceIndex = 0;
  private width = 0;
  private height = 0;
  private samplesPerPixel = 1;
  private dtype: DType = 'float32';

  /** Hyperstack position. ImageJ orders pages c, then z, then t. */
  private axisC = 0;
  private axisZ = 0;
  private axisT = 0;
  /** ImageJ keeps a display range per channel; so do we. */
  private channelRanges = new Map<number, Range>();

  /**
   * What the Min/Max sliders span: the data range of the slice on screen, as
   * ImageJ's B&C spans defaultMin..defaultMax.
   *
   * It follows the slice while the display range itself is held, so stepping
   * through a stack moves the handles to show where the held range sits in
   * each slice's data, the same way the histogram's lines move. An axis fixed
   * for the whole stack was tried and is wrong: the sliders then reach values a
   * slice does not contain, and cannot reach ones it does.
   */
  private scale: Range = { min: 0, max: 1 };

  private range: Range = { min: 0, max: 1 };
  private fullRange: Range = { min: 0, max: 1 };
  private autoThreshold = 0;
  private lutName = 'Grays';

  private zoom = 1;
  private offsetX = 0;
  private offsetY = 0;
  private userHasZoomed = false;

  /** Offscreen image at native resolution; the canvas only scales it. */
  private offscreen = document.createElement('canvas');
  private offCtx = this.offscreen.getContext('2d', { willReadFrequently: false })!;
  private indices = new Uint8Array(0);
  private nanMask = new Uint8Array(0);
  private imageData?: ImageData;

  private canvas = $<HTMLCanvasElement>('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private renderQueued = false;

  constructor() {
    this.wireControls();
    window.addEventListener('message', e => this.onMessage(e.data));
    window.addEventListener('resize', () => { this.resizeCanvas(); this.scheduleDraw(); });
    vscode.postMessage({ type: 'ready' });
  }

  // ---- messaging ---------------------------------------------------------
  private onMessage(msg: any) {
    if (msg.type === 'init') {
      this.init = msg as InitMessage;
      this.lutName = msg.config.defaultLut;
      $('file-name').textContent = msg.fileName;
      ($('chk-per-slice') as HTMLInputElement).checked = msg.config.recomputeRangePerSlice;
      this.fillInfo();
      this.setupStackControls();
      this.setupLutOptions();
    } else if (msg.type === 'slice') {
      this.onSlice(msg);
    } else if (msg.type === 'error') {
      this.showError(msg.message, msg.fatal);
    }
  }

  private onSlice(msg: SlicePayload) {
    this.sliceIndex = msg.index;
    this.width = msg.width;
    this.height = msg.height;
    this.samplesPerPixel = msg.samplesPerPixel;
    this.dtype = msg.dtype;
    this.data = viewOf(fromBase64(msg.base64), msg.dtype, msg.littleEndian);
    this.stats = {
      ...msg.stats,
      histogram: Int32Array.from(msg.stats.histogram),
    } as Stats;

    const { channels } = this.init ? this.axisSizes() : { channels: 1 };
    const first = !this.imageData || this.offscreen.width !== this.width || this.offscreen.height !== this.height;
    if (first) {
      this.offscreen.width = this.width;
      this.offscreen.height = this.height;
      this.imageData = this.offCtx.createImageData(this.width, this.height);
      this.indices = new Uint8Array(this.width * this.height);
      this.nanMask = new Uint8Array(this.width * this.height);
    }

    this.fullRange = resetRange(this.stats!);
    const perSlice = ($('chk-per-slice') as HTMLInputElement).checked;

    // ImageJ keeps one display range per channel, so a channel is "new" until
    // it has been shown once - otherwise a 0..100 channel would inherit the
    // 0..5000 range of the one before it and come out blank.
    const remembered = channels > 1 ? this.channelRanges.get(this.axisC) : undefined;
    const neverSeen = channels > 1 ? remembered === undefined : !this.hasRange;

    if (perSlice || neverSeen) {
      const saved = this.init?.stack;
      if (!this.hasRange && saved?.savedMin !== undefined && saved.savedMax !== undefined) {
        // An ImageJ-written file already carries the range someone chose.
        this.range = { min: saved.savedMin, max: saved.savedMax };
      } else if (this.init?.config.autoContrastOnOpen) {
        // Opening a stack windows the stack. Auto-contrast from slice 0 alone
        // would leave every slice at a different level saturated the moment the
        // range is held - which is the whole point of holding it.
        // Each channel gets its own, as it keeps its own range.
        const wholeStack = perSlice ? undefined : this.init.stackAuto?.[channels > 1 ? this.axisC : 0];
        if (wholeStack) {
          this.range = { ...wholeStack };
          this.autoThreshold = 0;
        } else {
          const auto = autoAdjust(this.stats!, 0);
          this.range = auto.range;
          this.autoThreshold = auto.autoThreshold;
        }
      } else {
        this.range = { ...this.fullRange };
      }
      this.hasRange = true;
    } else if (remembered) {
      this.range = remembered;
    }
    // else: single-channel stack, keep whatever range the user has set.

    if (channels > 1) this.channelRanges.set(this.axisC, this.range);
    this.scale = { ...this.fullRange };

    this.hideError();
    if (!this.userHasZoomed) this.fitToWindow();
    this.syncControls();
    this.fillStats();
    this.pixelsDirty = true;
    this.scheduleDraw();
  }

  private hasRange = false;

  // ---- rendering ---------------------------------------------------------
  private renderPixels() {
    if (!this.data || !this.imageData) return;
    const rgba = this.imageData.data;
    if (this.samplesPerPixel >= 3) {
      renderColor(this.data, this.samplesPerPixel, this.range.min, this.range.max, rgba);
    } else {
      // The statistics pass already counted NaN/Inf, so the common case skips
      // the per-pixel finiteness test and the mask entirely.
      const clean = (this.stats?.nonFiniteCount ?? 0) === 0;
      mapTo8Bit(this.data, this.range.min, this.range.max, this.indices, {
        assumeFinite: clean,
        mask: clean ? undefined : this.nanMask,
      });
      composeRGBA(this.indices, getLut(this.lutName), rgba, clean ? undefined : this.nanMask, [255, 64, 64]);
    }
    this.offCtx.putImageData(this.imageData, 0, 0);
  }

  private pixelsDirty = false;

  private scheduleDraw() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.pixelsDirty) {
        this.pixelsDirty = false;
        this.renderPixels();
        this.drawHistogram();
      }
      this.draw();
    });
  }

  private resizeCanvas() {
    const stage = $('stage');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw() {
    if (!this.width) return;
    if (this.canvas.width === 0) this.resizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    const vw = this.canvas.width / dpr;
    const vh = this.canvas.height / dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, vw, vh);
    // Never interpolate: smoothing invents pixel values that were not measured.
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.offscreen, 0, 0, this.width, this.height,
      Math.round(this.offsetX), Math.round(this.offsetY),
      this.width * this.zoom, this.height * this.zoom,
    );
    $('zoom-label').textContent = `${formatZoom(this.zoom)}  (${this.width}×${this.height})`;
  }

  private fitToWindow() {
    const stage = $('stage');
    const w = Math.max(1, stage.clientWidth) - 16;
    const h = Math.max(1, stage.clientHeight) - 16;
    this.resizeCanvas();
    const scale = Math.min(w / this.width, h / this.height);
    this.zoom = scale;
    this.centre();
  }

  private centre() {
    const dpr = window.devicePixelRatio || 1;
    this.offsetX = (this.canvas.width / dpr - this.width * this.zoom) / 2;
    this.offsetY = (this.canvas.height / dpr - this.height * this.zoom) / 2;
  }

  private setZoom(next: number, anchorX?: number, anchorY?: number) {
    const dpr = window.devicePixelRatio || 1;
    const ax = anchorX ?? this.canvas.width / dpr / 2;
    const ay = anchorY ?? this.canvas.height / dpr / 2;
    const imgX = (ax - this.offsetX) / this.zoom;
    const imgY = (ay - this.offsetY) / this.zoom;
    this.zoom = next;
    this.offsetX = ax - imgX * this.zoom;
    this.offsetY = ay - imgY * this.zoom;
    this.userHasZoomed = true;
    this.scheduleDraw();
  }

  private stepZoom(dir: 1 | -1, anchorX?: number, anchorY?: number) {
    // Fit-to-window leaves us between rungs, so step to the next rung strictly
    // above (or below) the current zoom rather than indexing off a stored rung.
    this.setZoom(nextZoom(this.zoom, dir), anchorX, anchorY);
  }

  // ---- panels ------------------------------------------------------------
  private fillInfo() {
    const m = this.init!.meta;
    const s = this.init!.stack;
    const rows: [string, string][] = [
      ['Dimensions', `${m.width} × ${m.height}${this.init!.pageCount > 1 ? ` × ${this.init!.pageCount}` : ''}`],
      ['Type', `${m.dtype}${m.samplesPerPixel > 1 ? ` × ${m.samplesPerPixel}` : ''}`],
      ['Compression', m.compression + (m.tiled ? ', tiled' : '')],
      ['File size', humanBytes(this.init!.fileSize)],
    ];
    if (s.shape) rows.push(['Array shape', `(${s.shape.join(', ')})`]);
    if (s.unit) rows.push(['Unit', s.unit]);
    if (m.software) rows.push(['Software', m.software]);
    const dl = $('info');
    dl.innerHTML = '';
    for (const [k, v] of rows) dl.appendChild(row(k, v));
  }

  private fillStats() {
    const s = this.stats!;
    const isF = this.dtype === 'float32' || this.dtype === 'float64';
    const rows: [string, string][] = [
      ['Data min', formatValue(s.min, isF)],
      ['Data max', formatValue(s.max, isF)],
      ['Mean', formatValue(s.mean, true)],
      ['Std dev', formatValue(s.stdDev, true)],
      ['Pixels', s.pixelCount.toLocaleString()],
    ];
    if (s.nonFiniteCount > 0) rows.push(['NaN / Inf', `${s.nonFiniteCount.toLocaleString()} (shown red)`]);
    const dl = $('stats');
    dl.innerHTML = '';
    for (const [k, v] of rows) dl.appendChild(row(k, v));
  }

  private setupStackControls() {
    const n = this.init!.pageCount;
    const panel = $('stack-panel');
    if (n <= 1) { panel.hidden = true; return; }
    panel.hidden = false;

    const { channels, frames } = this.axisSizes();
    $('row-c').hidden = channels <= 1;
    $('row-t').hidden = frames <= 1;
    $<HTMLInputElement>('slider-c').max = String(Math.max(0, channels - 1));
    $<HTMLInputElement>('slider-t').max = String(Math.max(0, frames - 1));

    const slider = $<HTMLInputElement>('slider-slice');
    slider.max = String(this.axisSizes().slices - 1);
    slider.value = '0';
    this.updateSliceLabel();
  }

  /** Axis lengths, falling back to a plain page stack when metadata is absent. */
  private axisSizes() {
    const st = this.init!.stack;
    const n = this.init!.pageCount;
    const channels = Math.max(1, st.channels || 1);
    const frames = Math.max(1, st.frames || 1);
    let slices = Math.max(1, st.slices || 1);
    if (channels * slices * frames > n) slices = Math.max(1, Math.floor(n / (channels * frames)));
    if (channels === 1 && frames === 1) slices = n;
    return { channels, slices, frames };
  }

  /** ImageJ's default hyperstack page order is c fastest, then z, then t. */
  private pageIndex(): number {
    const { channels, slices } = this.axisSizes();
    return this.axisT * channels * slices + this.axisZ * channels + this.axisC;
  }

  private updateSliceLabel() {
    const { channels, slices, frames } = this.axisSizes();
    const parts: string[] = [];
    if (channels > 1) parts.push(`c ${this.axisC + 1}/${channels}`);
    parts.push(`z ${this.axisZ + 1}/${slices}`);
    if (frames > 1) parts.push(`t ${this.axisT + 1}/${frames}`);

    // For a multi-file stack the member's own name says far more than a page number.
    const seq = this.init!.sequence;
    const tail = seq
      ? seq.labels[this.sliceIndex] ?? ''
      : `(page ${this.sliceIndex + 1}/${this.init!.pageCount})`;

    const el = $('slice-label');
    el.textContent = `${parts.join('   ')}   ${tail}`;
    el.title = tail; // long names are clipped in the sidebar
  }

  /** Move to the page implied by the current axis positions. */
  private requestCurrentPage() {
    const idx = clamp(this.pageIndex(), 0, this.init!.pageCount - 1);
    if (idx === this.sliceIndex) return;
    this.sliceIndex = idx;
    this.updateSliceLabel();
    vscode.postMessage({ type: 'requestSlice', index: idx });
  }

  private setupLutOptions() {
    const sel = $<HTMLSelectElement>('select-lut');
    sel.innerHTML = '';
    for (const name of LUT_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === this.lutName) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.disabled = this.init!.meta.samplesPerPixel >= 3;
  }

  private drawHistogram() {
    const c = $<HTMLCanvasElement>('histogram');
    const wrap = c.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, wrap.clientWidth);
    const h = 90;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.stats) return;

    const hist = this.stats.histogram;
    // Log scale, because a CT background peak is orders of magnitude taller
    // than the tissue detail you actually want to see.
    let peak = 0;
    for (let i = 0; i < N_BINS; i++) peak = Math.max(peak, hist[i]);
    if (peak === 0) return;
    const logPeak = Math.log1p(peak);

    const style = getComputedStyle(document.documentElement);
    ctx.fillStyle = style.getPropertyValue('--hist-bar').trim() || '#8aa9c8';
    const bw = w / N_BINS;
    for (let i = 0; i < N_BINS; i++) {
      const bh = (Math.log1p(hist[i]) / logPeak) * (h - 2);
      ctx.fillRect(i * bw, h - bh, Math.max(bw, 1), bh);
    }

    // Shade the region outside the display range.
    const toX = (v: number) => {
      const span = this.stats!.histMax - this.stats!.histMin;
      if (span <= 0) return 0;
      return ((v - this.stats!.histMin) / span) * w;
    };
    const x0 = Math.max(0, Math.min(w, toX(this.range.min)));
    const x1 = Math.max(0, Math.min(w, toX(this.range.max)));
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, x0, h);
    ctx.fillRect(x1, 0, w - x1, h);
    ctx.strokeStyle = style.getPropertyValue('--accent').trim() || '#4ea1ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, h);
    ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, h);
    ctx.stroke();

    const isF = this.dtype === 'float32' || this.dtype === 'float64';
    $('hist-lo').textContent = formatValue(this.stats.histMin, isF);
    $('hist-hi').textContent = formatValue(this.stats.histMax, isF);
    $('handle-min').style.left = `${x0}px`;
    $('handle-max').style.left = `${x1}px`;
  }

  // ---- controls ----------------------------------------------------------
  private syncing = false;

  private syncNumericFields() {
    const isF = this.dtype === 'float32' || this.dtype === 'float64';
    $<HTMLInputElement>('input-min').value = formatValue(this.range.min, isF);
    $<HTMLInputElement>('input-max').value = formatValue(this.range.max, isF);
  }

  private syncControls() {
    this.syncing = true;
    const span = this.scale.max - this.scale.min || 1;
    const toSlider = (v: number) => Math.round(((v - this.scale.min) / span) * 1000);
    $<HTMLInputElement>('slider-min').value = String(clamp(toSlider(this.range.min), 0, 1000));
    $<HTMLInputElement>('slider-max').value = String(clamp(toSlider(this.range.max), 0, 1000));
    const bc = toBrightnessContrast(this.scale, this.range);
    $<HTMLInputElement>('slider-brightness').value = String(Math.round(bc.brightness * 1000));
    $<HTMLInputElement>('slider-contrast').value = String(Math.round(bc.contrast * 1000));
    this.syncNumericFields();
    this.syncing = false;
  }

  /**
   * Dragging a slider fires far faster than a 16-megapixel remap can run, so
   * the remap is coalesced into the next animation frame along with the draw.
   * The control values update immediately; only the pixels wait.
   */
  private applyRange(next: Range, resync = true) {
    this.range = next;
    const multiChannel = !!this.init && this.axisSizes().channels > 1;
    if (multiChannel) this.channelRanges.set(this.axisC, next);
    this.pixelsDirty = true;
    if (resync) this.syncControls();
    this.scheduleDraw();
  }

  /**
   * ImageJ's ContrastAdjuster.adjustMin/adjustMax. The value is kept inside
   * the data of the slice on screen, and moving one end pulls the other back
   * inside it too, so a range set this way never reaches past the data. A
   * typed range is the one way past it, as with ImageJ's Set.
   */
  private adjustMin(v: number) {
    const min = clamp(v, this.scale.min, this.scale.max);
    this.applyRange({ min, max: Math.max(min, Math.min(this.range.max, this.scale.max)) });
  }

  private adjustMax(v: number) {
    const max = clamp(v, this.scale.min, this.scale.max);
    this.applyRange({ min: Math.min(max, Math.max(this.range.min, this.scale.min)), max });
  }

  private wireControls() {
    const sliderToValue = (raw: number) =>
      this.scale.min + (raw / 1000) * (this.scale.max - this.scale.min);

    $('slider-min').addEventListener('input', e => {
      if (this.syncing) return;
      this.adjustMin(sliderToValue(Number((e.target as HTMLInputElement).value)));
    });
    $('slider-max').addEventListener('input', e => {
      if (this.syncing) return;
      this.adjustMax(sliderToValue(Number((e.target as HTMLInputElement).value)));
    });
    const bcHandler = () => {
      if (this.syncing) return;
      const b = Number($<HTMLInputElement>('slider-brightness').value) / 1000;
      const c = Number($<HTMLInputElement>('slider-contrast').value) / 1000;
      this.applyRange(fromBrightnessContrast(this.scale, b, c), false);
      this.syncNumericFields();
    };
    $('slider-brightness').addEventListener('input', bcHandler);
    $('slider-contrast').addEventListener('input', bcHandler);

    const commitNumeric = () => {
      const lo = Number($<HTMLInputElement>('input-min').value);
      const hi = Number($<HTMLInputElement>('input-max').value);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) this.applyRange({ min: lo, max: hi });
      else this.syncControls();
    };
    $('input-min').addEventListener('change', commitNumeric);
    $('input-max').addEventListener('change', commitNumeric);

    $('btn-auto').addEventListener('click', () => this.doAuto());
    $('btn-enhance').addEventListener('click', () => this.doEnhance());
    $('btn-reset').addEventListener('click', () => this.doReset());
    $('btn-copy').addEventListener('click', () => {
      const isF = this.dtype === 'float32' || this.dtype === 'float64';
      vscode.postMessage({
        type: 'copy',
        text: `min=${formatValue(this.range.min, isF)}, max=${formatValue(this.range.max, isF)}`,
      });
    });

    $('chk-per-slice').addEventListener('change', e => {
      if ((e.target as HTMLInputElement).checked) this.doAuto0();
    });

    $('select-lut').addEventListener('change', e => {
      this.lutName = (e.target as HTMLSelectElement).value;
      this.renderPixels();
      this.scheduleDraw();
    });

    $('btn-zoom-in').addEventListener('click', () => this.stepZoom(1));
    $('btn-zoom-out').addEventListener('click', () => this.stepZoom(-1));
    $('btn-fit').addEventListener('click', () => { this.userHasZoomed = false; this.fitToWindow(); this.scheduleDraw(); });
    $('btn-100').addEventListener('click', () => { this.setZoom(1); this.centre(); this.scheduleDraw(); });

    $('slider-slice').addEventListener('input', e => {
      this.axisZ = Number((e.target as HTMLInputElement).value);
      this.requestCurrentPage();
    });
    $('slider-c').addEventListener('input', e => {
      this.axisC = Number((e.target as HTMLInputElement).value);
      this.requestCurrentPage();
    });
    $('slider-t').addEventListener('input', e => {
      this.axisT = Number((e.target as HTMLInputElement).value);
      this.requestCurrentPage();
    });

    $('btn-save').addEventListener('click', () => this.savePng());

    this.wirePointer();
    this.wireKeyboard();
    this.wireHistogramHandles();
  }

  /** Auto from a fresh threshold, as if the image had just been opened. */
  private doAuto0() {
    if (!this.stats) return;
    const r = autoAdjust(this.stats, 0);
    this.autoThreshold = r.autoThreshold;
    this.applyRange(r.range);
  }

  private doAuto() {
    if (!this.stats) return;
    const r = autoAdjust(this.stats, this.autoThreshold);
    this.autoThreshold = r.autoThreshold;
    this.applyRange(r.range);
  }

  private doEnhance() {
    if (!this.stats) return;
    this.applyRange(stretchHistogram(this.stats, this.init?.config.saturatedPercent ?? 0.35));
  }

  private doReset() {
    if (!this.stats) return;
    this.autoThreshold = 0;
    this.applyRange(resetRange(this.stats));
  }

  private wirePointer() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', e => {
      dragging = true;
      lastX = e.offsetX; lastY = e.offsetY;
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
    });
    canvas.addEventListener('pointerup', e => {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    });
    canvas.addEventListener('pointerleave', () => { $('pos').innerHTML = '&nbsp;'; });
    canvas.addEventListener('pointermove', e => {
      if (dragging) {
        this.offsetX += e.offsetX - lastX;
        this.offsetY += e.offsetY - lastY;
        lastX = e.offsetX; lastY = e.offsetY;
        this.userHasZoomed = true;
        this.scheduleDraw();
      }
      this.updateReadout(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.stepZoom(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { this.userHasZoomed = false; this.fitToWindow(); this.scheduleDraw(); });
  }

  private updateReadout(px: number, py: number) {
    if (!this.data) return;
    const x = Math.floor((px - this.offsetX) / this.zoom);
    const y = Math.floor((py - this.offsetY) / this.zoom);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) { $('pos').innerHTML = '&nbsp;'; return; }
    const isF = this.dtype === 'float32' || this.dtype === 'float64';
    const base = (y * this.width + x) * this.samplesPerPixel;
    let valueText: string;
    if (this.samplesPerPixel >= 3) {
      const parts = [];
      for (let s = 0; s < Math.min(this.samplesPerPixel, 4); s++) parts.push(formatValue(this.data[base + s], isF));
      valueText = parts.join(', ');
    } else {
      valueText = formatValue(this.data[base], isF);
    }
    $('pos').textContent = `x=${x}, y=${y}, value=${valueText}`;
  }

  private wireKeyboard() {
    document.addEventListener('keydown', e => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      switch (e.key) {
        case '+': case '=': this.stepZoom(1); break;
        case '-': case '_': this.stepZoom(-1); break;
        case 'f': case 'F': this.userHasZoomed = false; this.fitToWindow(); this.scheduleDraw(); break;
        case '1': this.setZoom(1); this.centre(); this.scheduleDraw(); break;
        case 'a': case 'A': this.doAuto(); break;
        case 'e': case 'E': this.doEnhance(); break;
        case 'r': case 'R': this.doReset(); break;
        case 'ArrowLeft': case 'ArrowUp': this.stepSlice(-1); break;
        case 'ArrowRight': case 'ArrowDown': this.stepSlice(1); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  private stepSlice(delta: number) {
    if (!this.init || this.init.pageCount <= 1) return;
    const { slices } = this.axisSizes();
    const next = clamp(this.axisZ + delta, 0, slices - 1);
    if (next === this.axisZ) return;
    this.axisZ = next;
    $<HTMLInputElement>('slider-slice').value = String(next);
    this.requestCurrentPage();
  }

  /**
   * Hand the extension host a full-resolution PNG of exactly what is on screen
   * - current display range and LUT. The webview sandbox blocks downloads, so
   * the host runs the save dialog.
   */
  private savePng() {
    if (!this.width) return;
    let dataUrl: string;
    try {
      dataUrl = this.offscreen.toDataURL('image/png');
    } catch (e) {
      this.showError(`Could not encode the image: ${(e as Error).message}`, false);
      return;
    }
    const isF = this.dtype === 'float32' || this.dtype === 'float64';
    vscode.postMessage({
      type: 'savePng',
      dataUrl,
      sliceIndex: this.sliceIndex,
      range: `${formatValue(this.range.min, isF)}_${formatValue(this.range.max, isF)}`,
    });
  }

  private wireHistogramHandles() {
    const wrap = $('hist-handles');
    let active: 'min' | 'max' | null = null;
    const valueAt = (clientX: number) => {
      const rect = wrap.getBoundingClientRect();
      const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
      const s = this.stats!;
      return s.histMin + frac * (s.histMax - s.histMin);
    };
    const start = (which: 'min' | 'max') => (e: PointerEvent) => {
      active = which;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    $('handle-min').addEventListener('pointerdown', start('min'));
    $('handle-max').addEventListener('pointerdown', start('max'));
    window.addEventListener('pointermove', e => {
      if (!active || !this.stats) return;
      const v = valueAt(e.clientX);
      if (active === 'min') this.adjustMin(v);
      else this.adjustMax(v);
    });
    window.addEventListener('pointerup', () => { active = null; });
  }

  // ---- errors ------------------------------------------------------------
  private showError(message: string, fatal: boolean) {
    const el = $('overlay-error');
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('fatal', !!fatal);
    if (fatal) vscode.postMessage({ type: 'reportError', message });
  }
  private hideError() { $('overlay-error').hidden = true; }
}

// ---- helpers ---------------------------------------------------------------

function row(k: string, v: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = k;
  const dd = document.createElement('dd');
  dd.textContent = v;
  dd.title = v;
  frag.appendChild(dt);
  frag.appendChild(dd);
  return frag;
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

/** Next rung of the ImageJ zoom ladder in the given direction. */
export function nextZoom(current: number, dir: 1 | -1): number {
  const EPS = 1.0001;
  if (dir > 0) {
    for (const z of ZOOM_LEVELS) if (z > current * EPS) return z;
    return ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  }
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    if (ZOOM_LEVELS[i] * EPS < current) return ZOOM_LEVELS[i];
  }
  return ZOOM_LEVELS[0];
}

function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatZoom(z: number): string {
  if (z >= 1) return `${Math.round(z * 100)}%`;
  return `${(z * 100).toFixed(z < 0.1 ? 2 : 1)}%`;
}

new Viewer();
export {};
