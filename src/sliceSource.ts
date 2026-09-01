/**
 * Page decoding, caching and wire encoding. Deliberately free of any `vscode`
 * import so it can be unit-tested in plain Node.
 */
import { TiffFile, ByteReader } from './tiff/decoder';
import { PageMeta, StackMeta, NumericArray } from './tiff/types';
import { computeStats, Stats } from './imagej/stats';
import { SlicePayload, SerializableStats, toBase64, isLittleEndianHost } from './wire';

export type { SlicePayload, SerializableStats } from './wire';

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
  private tiff: TiffFile;
  readonly meta: PageMeta;
  readonly stack: StackMeta;

  /** Insertion-ordered LRU, bounded by total pixels rather than page count. */
  private cache = new Map<number, CachedSlice>();

  constructor(
    private reader: ByteReader,
    private maxCachedValues = 64 * 1024 * 1024,
    private maxDecodedBytes = 512 * 1024 * 1024,
  ) {
    this.tiff = new TiffFile(reader);
    this.meta = this.tiff.meta(0);
    this.stack = this.tiff.stackMeta();
  }

  get pageCount(): number { return this.tiff.pageCount; }
  pageMeta(index: number): PageMeta { return this.tiff.meta(index); }

  getSlice(index: number): CachedSlice {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit); // refresh LRU position
      return hit;
    }
    const meta = this.tiff.meta(index);
    this.checkSize(meta);
    const page = this.tiff.decode(index);
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
    this.reader.close?.();
  }
}
