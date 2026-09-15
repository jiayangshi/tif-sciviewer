/**
 * Page decoding, caching and wire encoding. Deliberately free of any `vscode`
 * import so it can be unit-tested in plain Node.
 */
import { TiffFile, ByteReader } from './tiff/decoder';
import { PageMeta, StackMeta, NumericArray } from './tiff/types';
import { computeStats, Stats } from './imagej/stats';
import { autoAdjust, Range } from './imagej/contrast';
import { SlicePayload, SerializableStats, toBase64, isLittleEndianHost } from './wire';
import { PageProvider } from './sequence';

export type { SlicePayload, SerializableStats } from './wire';

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
      for (let k = 0; k < samples; k++) {
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

  payload(index: number): SlicePayload {
    const { data, stats, meta } = this.getSlice(index);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return {
      type: 'slice',
      index,
      width: meta.width,
      height: meta.height,
      samplesPerPixel: meta.samplesPerPixel,
      dtype: meta.dtype,
      base64: toBase64(bytes),
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
