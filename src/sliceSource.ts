/**
 * Page decoding, caching and wire encoding. Deliberately free of any `vscode`
 * import so it can be unit-tested in plain Node.
 */
import { TiffFile, ByteReader } from './tiff/decoder';
import { PageMeta, StackMeta, NumericArray } from './tiff/types';
import { computeStats, Stats } from './imagej/stats';
import { autoAdjust, Range } from './imagej/contrast';
import {
  SlicePayload, SerializableStats, PixelEncoding, Region, toBase64, isLittleEndianHost, sampledSize, clipRegion,
  PREVIEW_MIN_BYTES,
} from './wire';
import { PageProvider } from './sequence';

export type { SlicePayload, SerializableStats, PixelEncoding } from './wire';

/** A reader yields bytes; a provider already knows how to page. */
function isPageProvider(source: ByteReader | PageProvider): source is PageProvider {
  return typeof (source as PageProvider).decode === 'function';
}

export function serializeStats(s: Stats): SerializableStats {
  return {
    pixelCount: s.pixelCount, nonFiniteCount: s.nonFiniteCount,
    min: s.min, max: s.max, mean: s.mean, stdDev: s.stdDev,
    histMin: s.histMin, histMax: s.histMax, binSize: s.binSize,
    histogram: Array.from(s.histogram), dtype: s.dtype,
  };
}

export interface CachedSlice {
  data: NumericArray;
  stats: Stats;
  meta: PageMeta;
}

export class SliceSource {
  private pages: PageProvider;
  /** Only set when this instance opened the reader and so has to close it. */
  private ownedReader?: ByteReader;
  readonly meta: PageMeta;
  readonly stack: StackMeta;

  /** Insertion-ordered LRU, bounded by total pixels rather than page count. */
  private cache = new Map<number, CachedSlice>();

  /**
   * Takes either a reader over one TIFF, or a provider that has already
   * arranged pages some other way - a multi-file sequence, say.
   */
  constructor(
    source: ByteReader | PageProvider,
    private maxCachedValues = 64 * 1024 * 1024,
    private maxDecodedBytes = 512 * 1024 * 1024,
    /** Pages smaller than this are sent whole, whatever the viewer asks for. */
    private minPreviewBytes = PREVIEW_MIN_BYTES,
  ) {
    if (isPageProvider(source)) {
      this.pages = source;
    } else {
      this.ownedReader = source;
      this.pages = new TiffFile(source);
    }
    this.meta = this.pages.meta(0);
    this.stack = this.pages.stackMeta();
  }

  get pageCount(): number { return this.pages.pageCount; }
  pageMeta(index: number): PageMeta { return this.pages.meta(index); }

  getSlice(index: number): CachedSlice {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit); // refresh LRU position
      return hit;
    }
    const meta = this.pages.meta(index);
    this.checkSize(meta);
    const page = this.pages.decode(index);
    const stats = computeStats(page.data, page.dtype, page.samplesPerPixel);
    const entry: CachedSlice = { data: page.data, stats, meta };
    this.cache.set(index, entry);
    this.evict();
    return entry;
  }

  /**
   * Decoding widens everything to at least the sample size, and the webview
   * gets a base64 copy on top; refusing early with a number beats an
   * out-of-memory kill on someone's login node.
   */
  private checkSize(meta: PageMeta) {
    const bytes = meta.width * meta.height * meta.samplesPerPixel * (meta.bitsPerSample[0] / 8);
    if (bytes > this.maxDecodedBytes) {
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
      throw new Error(
        `Page ${meta.index} is ${meta.width}x${meta.height}x${meta.samplesPerPixel} `
        + `${meta.dtype} (${mb(bytes)}), over the ${mb(this.maxDecodedBytes)} limit. `
        + 'Raise "tifSciviewer.maxDecodedMegabytes" if this machine has the memory for it.',
      );
    }
  }

  private evict() {
    let values = 0;
    for (const v of this.cache.values()) values += v.data.length;
    while (values > this.maxCachedValues && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as number;
      values -= this.cache.get(oldest)!.data.length;
      this.cache.delete(oldest);
    }
  }

  get cachedPages(): number[] { return [...this.cache.keys()]; }

  /**
   * Decode a page before it is asked for, so stepping through a stack finds
   * the next slice ready. Leaves any failure for the real request to report.
   * True if it decoded.
   *
   * Never at the cost of the page most recently served, which is the one on
   * screen: the viewer is about to ask for all of it in place of its preview.
   * Where the two do not fit in the cache together - one slice over half the
   * budget - reading ahead would only have that page decoded twice.
   */
  prefetch(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount || this.cache.has(index)) return false;
    try {
      const m = this.pages.meta(index);
      let shown: CachedSlice | undefined;
      for (const v of this.cache.values()) shown = v;
      if (shown && shown.data.length + m.width * m.height * m.samplesPerPixel > this.maxCachedValues) return false;
      this.getSlice(index);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A display window that suits the whole stack rather than just its first
   * slice, one per channel.
   *
   * Auto-contrast from slice 0 alone falls apart the moment a stack's slices
   * sit at different levels: hold that window and every later slice saturates
   * to flat white. Sampling across the stack and taking the union of the
   * per-slice windows gives one range that shows all of it, which is what makes
   * holding the range across slices useful instead of merely consistent.
   *
   * Channels are sampled apart because they are windowed apart: a 0..100
   * channel given a union taken with a 0..5000 one comes out nearly black.
   *
   * Sampling is bounded by pixels rather than page count, so a stack of large
   * slices reads fewer of them, and a slice that will not decode is skipped
   * rather than allowed to stop the file opening.
   */
  stackWindows(maxSamples = 8, valueBudget = 64 * 1024 * 1024): (Range | undefined)[] | undefined {
    if (this.pageCount <= 1) return undefined;

    // ImageJ's page order puts channels fastest, so channel c is every
    // channels-th page starting at c.
    const channels = Math.min(Math.max(1, this.stack.channels || 1), this.pageCount);
    const perSlice = Math.max(1, this.meta.width * this.meta.height * this.meta.samplesPerPixel);
    const affordable = Math.floor(Math.min(maxSamples, valueBudget / perSlice) / channels);

    const windows: (Range | undefined)[] = [];
    for (let c = 0; c < channels; c++) {
      const count = Math.ceil((this.pageCount - c) / channels);
      const samples = Math.min(count, Math.max(2, affordable));

      let min = Infinity;
      let max = -Infinity;
      let seen = 0;
      // Counted down so the channel's own first slice is sampled last: it is the
      // one about to be shown, and on a stack of pages too large for the cache to
      // hold two, whatever is sampled after it would evict it and force a second
      // decode.
      for (let k = samples - 1; k >= 0; k--) {
        // Evenly spaced, always including the channel's first and last slice.
        const nth = samples === 1 ? 0 : Math.round((k * (count - 1)) / (samples - 1));
        try {
          const { range } = autoAdjust(this.getSlice(c + nth * channels).stats, 0);
          if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) continue;
          min = Math.min(min, range.min);
          max = Math.max(max, range.max);
          seen++;
        } catch {
          // A page that will not decode should not stop the stack from opening.
        }
      }

      const usable = seen > 0 && Number.isFinite(min) && Number.isFinite(max) && max > min;
      windows.push(usable ? { min, max } : undefined);
    }
    return windows.some(w => w) ? windows : undefined;
  }

  /**
   * A slice for the webview. With a `step` above 1, or a `region`, only a
   * preview travels (see subsample), but the statistics are always of the
   * whole slice, so the histogram and any auto-contrast taken from it do not
   * depend on what was sent.
   */
  payload(index: number, encoding: PixelEncoding = 'binary', step = 1, region?: unknown): SlicePayload {
    const { data, stats, meta } = this.getSlice(index);
    // The viewer chooses a preview from the page on screen, and the pages of
    // one file can differ in size - a thumbnail among full slices, say. A page
    // this small gains nothing from a preview, so it goes whole.
    const whole = data.byteLength < this.minPreviewBytes;
    const k = whole ? 1 : Math.max(1, Math.floor(step) || 1);
    const r = whole ? undefined : clipRegion(region, meta.width, meta.height);
    const sent = k > 1 || r ? subsample(data, meta.width, meta.height, meta.samplesPerPixel, k, r) : data;
    const bytes = new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength);
    return {
      type: 'slice',
      index,
      width: meta.width,
      height: meta.height,
      samplesPerPixel: meta.samplesPerPixel,
      dtype: meta.dtype,
      ...(encoding === 'base64' ? { base64: toBase64(bytes) } : { pixels: ownBuffer(bytes) }),
      step: k,
      ...(r ? { region: r } : {}),
      littleEndian: isLittleEndianHost(),
      stats: serializeStats(stats),
    };
  }

  dispose() {
    this.cache.clear();
    this.ownedReader?.close?.();
    this.pages.close?.();
  }
}

/**
 * The pixel at the centre of every step x step block of a region (the whole
 * slice by default) - nearest-neighbour thinning, so every value in the
 * preview is one that was measured. With one sample per device pixel it draws
 * the same as the full slice, which the GPU would thin the same way, at a
 * fraction of the bytes to move. At step 1 it is a plain crop.
 */
export function subsample(
  data: NumericArray, width: number, height: number, spp: number, step: number,
  region: Region = { x: 0, y: 0, width, height },
): NumericArray {
  const size = sampledSize(region.width, region.height, step);
  const out = new (data.constructor as new (n: number) => NumericArray)(size.width * size.height * spp);
  const off = step >> 1;
  const lastX = region.x + region.width - 1;
  const lastY = region.y + region.height - 1;
  let o = 0;
  for (let y = 0; y < size.height; y++) {
    const row = Math.min(lastY, region.y + y * step + off) * width;
    for (let x = 0; x < size.width; x++) {
      const i = (row + Math.min(lastX, region.x + x * step + off)) * spp;
      for (let s = 0; s < spp; s++) out[o++] = data[i + s];
    }
  }
  return out;
}

/**
 * VS Code sends the whole ArrayBuffer behind a view, so a view into anything
 * larger is copied down to its own bytes first. Decoded pages are allocated to
 * size, so in practice this returns its argument.
 */
function ownBuffer(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}
