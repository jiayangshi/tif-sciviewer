/**
 * A from-scratch TIFF reader in the spirit of ij.io.TiffDecoder: it targets the
 * scientific subset (float/signed/16-bit, stacks, LZW/Deflate/PackBits) rather
 * than the baseline 8-bit RGB subset that browsers and ImageIO handle.
 */
import {
  DType, NumericArray, PageMeta, DecodedPage, StackMeta, TAG, COMPRESSION_NAMES, PHOTOMETRIC,
} from './types';
import {
  lzwDecode, packBitsDecode, inflateDecode, undoHorizontalPredictor,
  undoFloatingPointPredictor, reverseBits,
} from './codecs';

/** Random access over the file. Lets us avoid holding a whole stack in memory. */
export interface ByteReader {
  size: number;
  read(offset: number, length: number): Uint8Array;
  close?(): void;
}

export class BufferReader implements ByteReader {
  constructor(private buf: Uint8Array) {}
  get size() { return this.buf.length; }
  read(offset: number, length: number): Uint8Array {
    if (offset < 0 || offset + length > this.buf.length) {
      throw new Error(`Read past end of file (offset ${offset}, length ${length}, size ${this.buf.length})`);
    }
    return this.buf.subarray(offset, offset + length);
  }
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8,
};

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Resolved scalar/array value. ASCII resolves to string. */
  value: number[] | string;
}

export class TiffFile {
  readonly littleEndian: boolean;
  readonly bigTiff: boolean;
  readonly ifdOffsets: number[] = [];
  private entriesCache = new Map<number, Map<number, Entry>>();
  private metaCache = new Map<number, PageMeta>();

  constructor(private reader: ByteReader) {
    const head = reader.read(0, 8);
    const bom = String.fromCharCode(head[0], head[1]);
    if (bom === 'II') this.littleEndian = true;
    else if (bom === 'MM') this.littleEndian = false;
    else throw new Error(`Not a TIFF file: expected "II" or "MM" magic, got "${bom}"`);

    const version = this.u16(head, 2);
    if (version === 42) {
      this.bigTiff = false;
      this.ifdOffsets.push(this.u32(head, 4));
    } else if (version === 43) {
      this.bigTiff = true;
      const h2 = reader.read(0, 16);
      const offsetSize = this.u16(h2, 4);
      if (offsetSize !== 8) throw new Error(`Unsupported BigTIFF offset size ${offsetSize}`);
      this.ifdOffsets.push(Number(this.u64(h2, 8)));
    } else {
      throw new Error(`Unsupported TIFF version ${version} (expected 42 or 43/BigTIFF)`);
    }
    this.scanIfds();
  }

  // ---- primitive readers -------------------------------------------------
  private u16(b: Uint8Array, o: number) {
    return this.littleEndian ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
  }
  private u32(b: Uint8Array, o: number) {
    return this.littleEndian
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  private u64(b: Uint8Array, o: number): bigint {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return dv.getBigUint64(o, this.littleEndian);
  }

  /** Walk the IFD chain up front; cheap (a few hundred bytes per page). */
  private scanIfds() {
    const seen = new Set<number>();
    let offset = this.ifdOffsets[0];
    this.ifdOffsets.length = 0;
    while (offset > 0 && offset < this.reader.size) {
      if (seen.has(offset)) break; // malformed circular chain
      seen.add(offset);
      this.ifdOffsets.push(offset);
      const countBytes = this.bigTiff ? 8 : 2;
      const entrySize = this.bigTiff ? 20 : 12;
      const head = this.reader.read(offset, countBytes);
      const n = this.bigTiff ? Number(this.u64(head, 0)) : this.u16(head, 0);
      if (n < 0 || n > 100000) throw new Error(`Implausible IFD entry count ${n} at offset ${offset}`);
      const nextOffsetPos = offset + countBytes + n * entrySize;
      const tail = this.reader.read(nextOffsetPos, this.bigTiff ? 8 : 4);
      offset = this.bigTiff ? Number(this.u64(tail, 0)) : this.u32(tail, 0);
    }
    if (this.ifdOffsets.length === 0) throw new Error('TIFF contains no image file directories');
  }

  get pageCount(): number { return this.ifdOffsets.length; }

  private entries(page: number): Map<number, Entry> {
    const cached = this.entriesCache.get(page);
    if (cached) return cached;

    const offset = this.ifdOffsets[page];
    const countBytes = this.bigTiff ? 8 : 2;
    const entrySize = this.bigTiff ? 20 : 12;
    const head = this.reader.read(offset, countBytes);
    const n = this.bigTiff ? Number(this.u64(head, 0)) : this.u16(head, 0);
    const block = this.reader.read(offset + countBytes, n * entrySize);
    const map = new Map<number, Entry>();

    for (let i = 0; i < n; i++) {
      const base = i * entrySize;
      const tag = this.u16(block, base);
      const type = this.u16(block, base + 2);
      const count = this.bigTiff ? Number(this.u64(block, base + 4)) : this.u32(block, base + 4);
      const valueFieldOffset = base + (this.bigTiff ? 12 : 8);
      const valueFieldSize = this.bigTiff ? 8 : 4;
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (size === 0) continue; // unknown tag type: skip rather than fail

      let bytes: Uint8Array;
      if (size <= valueFieldSize) {
        bytes = block.subarray(valueFieldOffset, valueFieldOffset + size);
      } else {
        const dataOffset = this.bigTiff
          ? Number(this.u64(block, valueFieldOffset))
          : this.u32(block, valueFieldOffset);
        if (dataOffset + size > this.reader.size) continue; // truncated tag: ignore
        bytes = this.reader.read(dataOffset, size);
      }
      map.set(tag, { tag, type, count, value: this.decodeValue(type, count, bytes) });
    }
    this.entriesCache.set(page, map);
    return map;
  }

  private decodeValue(type: number, count: number, b: Uint8Array): number[] | string {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const le = this.littleEndian;
    switch (type) {
      case 2: { // ASCII, NUL-terminated (possibly several)
        let s = '';
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return s.replace(/\0+$/, '');
      }
      case 1: case 7: return Array.from(b);
      case 6: return Array.from(new Int8Array(b.buffer, b.byteOffset, count));
      case 3: return range(count, i => dv.getUint16(i * 2, le));
      case 8: return range(count, i => dv.getInt16(i * 2, le));
      case 4: case 13: return range(count, i => dv.getUint32(i * 4, le));
      case 9: return range(count, i => dv.getInt32(i * 4, le));
      case 5: return range(count, i => dv.getUint32(i * 8, le) / (dv.getUint32(i * 8 + 4, le) || 1));
      case 10: return range(count, i => dv.getInt32(i * 8, le) / (dv.getInt32(i * 8 + 4, le) || 1));
      case 11: return range(count, i => dv.getFloat32(i * 4, le));
      case 12: return range(count, i => dv.getFloat64(i * 8, le));
      case 16: case 18: return range(count, i => Number(dv.getBigUint64(i * 8, le)));
      case 17: return range(count, i => Number(dv.getBigInt64(i * 8, le)));
      default: return [];
    }
  }

  private nums(page: number, tag: number): number[] | undefined {
    const e = this.entries(page).get(tag);
    if (!e) return undefined;
    return typeof e.value === 'string' ? undefined : e.value;
  }
  private num(page: number, tag: number, fallback: number): number {
    const v = this.nums(page, tag);
    return v && v.length ? v[0] : fallback;
  }
  private str(page: number, tag: number): string | undefined {
    const e = this.entries(page).get(tag);
    return typeof e?.value === 'string' ? e.value : undefined;
  }

  // ---- metadata ----------------------------------------------------------
  meta(page: number): PageMeta {
    const cached = this.metaCache.get(page);
    if (cached) return cached;
    if (page < 0 || page >= this.pageCount) throw new Error(`Page ${page} out of range (0..${this.pageCount - 1})`);

    const width = this.num(page, TAG.ImageWidth, 0);
    const height = this.num(page, TAG.ImageLength, 0);
    if (!width || !height) throw new Error(`Page ${page} has no ImageWidth/ImageLength`);

    const spp = this.num(page, TAG.SamplesPerPixel, 1);
    const bps = this.nums(page, TAG.BitsPerSample) ?? [1];
    while (bps.length < spp) bps.push(bps[0]);
    const sf = this.nums(page, TAG.SampleFormat) ?? [1];
    while (sf.length < spp) sf.push(sf[0]);

    const compression = this.num(page, TAG.Compression, 1);
    const colorMapRaw = this.nums(page, TAG.ColorMap);

    const m: PageMeta = {
      index: page,
      width, height,
      samplesPerPixel: spp,
      bitsPerSample: bps,
      sampleFormat: sf,
      dtype: dtypeOf(bps[0], sf[0]),
      compression,
      compressionName: COMPRESSION_NAMES[compression] ?? `unknown (${compression})`,
      photometric: this.num(page, TAG.Photometric, spp >= 3 ? PHOTOMETRIC.RGB : PHOTOMETRIC.BlackIsZero),
      planarConfig: this.num(page, TAG.PlanarConfiguration, 1),
      predictor: this.num(page, TAG.Predictor, 1),
      fillOrder: this.num(page, TAG.FillOrder, 1),
      rowsPerStrip: this.num(page, TAG.RowsPerStrip, height),
      tileWidth: this.nums(page, TAG.TileWidth)?.[0],
      tileHeight: this.nums(page, TAG.TileLength)?.[0],
      colorMap: colorMapRaw ? Uint16Array.from(colorMapRaw) : undefined,
      extraSamples: this.nums(page, TAG.ExtraSamples),
      description: this.str(page, TAG.ImageDescription),
      software: this.str(page, TAG.Software),
    };
    const xr = this.nums(page, TAG.XResolution)?.[0];
    const yr = this.nums(page, TAG.YResolution)?.[0];
    if (xr) m.resolution = { x: xr, y: yr ?? xr, unit: this.num(page, TAG.ResolutionUnit, 2) };

    if (bps.some(b => b !== bps[0])) {
      throw new Error(`Mixed bit depths per sample (${bps.join(', ')}) are not supported`);
    }
    this.metaCache.set(page, m);
    return m;
  }

  /**
   * Recover logical axes. ImageJ's own ImageDescription wins; failing that we
   * look for the JSON block tifffile writes; failing that, pages are slices.
   */
  stackMeta(): StackMeta {
    const desc = this.meta(0).description ?? '';
    const pages = this.pageCount;

    if (/^ImageJ=/m.test(desc)) {
      const get = (k: string) => {
        const m = desc.match(new RegExp(`^${k}=(.*)$`, 'm'));
        return m ? m[1].trim() : undefined;
      };
      const numOr = (k: string, d: number) => { const v = get(k); const n = v ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };
      const images = numOr('images', pages);
      const channels = numOr('channels', 1);
      const frames = numOr('frames', 1);
      const slices = numOr('slices', Math.max(1, Math.round(images / (channels * frames))));
      const min = get('min'); const max = get('max');
      return {
        pages: Math.max(pages, images),
        channels, slices, frames,
        hyperstack: get('hyperstack') === 'true' || channels > 1 || frames > 1,
        savedMin: min !== undefined && Number.isFinite(Number(min)) ? Number(min) : undefined,
        savedMax: max !== undefined && Number.isFinite(Number(max)) ? Number(max) : undefined,
        unit: get('unit'),
        spacing: get('spacing') ? Number(get('spacing')) : undefined,
        source: 'imagej',
      };
    }

    const trimmed = desc.trim();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        if (Array.isArray(j.shape)) {
          const shape: number[] = j.shape.map(Number);
          // Trailing axes are y,x (plus a sample axis for RGB); the rest stack.
          const spp = this.meta(0).samplesPerPixel;
          const imageAxes = spp > 1 && shape.length >= 3 ? 3 : 2;
          const lead = shape.slice(0, Math.max(0, shape.length - imageAxes));
          const slices = lead.length ? lead.reduce((a, b) => a * b, 1) : 1;
          return {
            pages, channels: 1, slices: Math.max(slices, 1), frames: 1,
            hyperstack: lead.length > 1, shape, source: 'tifffile',
          };
        }
      } catch { /* not JSON we understand; fall through */ }
    }

    return { pages, channels: 1, slices: pages, frames: 1, hyperstack: false, source: 'pages' };
  }

  // ---- pixels ------------------------------------------------------------
  decode(page: number): DecodedPage {
    const m = this.meta(page);
    if (m.compression === 6 || m.compression === 7) {
      throw new Error('JPEG-compressed TIFF is not supported. Re-save with compression=None, LZW, or Deflate.');
    }
    if (m.compression === 34925 || m.compression === 50000 || m.compression === 33003) {
      throw new Error(`${m.compressionName} compression is not supported. Re-save with tifffile using compression='zlib' or none.`);
    }
    if (m.photometric === PHOTOMETRIC.YCbCr || m.photometric === PHOTOMETRIC.CMYK) {
      throw new Error(`Photometric interpretation ${m.photometric} is not supported`);
    }

    const spp = m.samplesPerPixel;
    const out = allocate(m.dtype, m.width * m.height * spp);
    const tiled = m.tileWidth !== undefined && m.tileHeight !== undefined;

    if (tiled) this.decodeTiled(page, m, out);
    else this.decodeStripped(page, m, out);

    // Palette images keep their raw index here; the colour map is applied at
    // display time. Everything else is already numeric.
    return { width: m.width, height: m.height, samplesPerPixel: spp, dtype: m.dtype, data: out };
  }

  private chunk(m: PageMeta, offset: number, byteCount: number, uncompressedLength: number): Uint8Array {
    let raw = this.reader.read(offset, byteCount);
    if (m.fillOrder === 2) { raw = raw.slice(); reverseBits(raw); }
    switch (m.compression) {
      case 1: return raw;
      case 5: return lzwDecode(raw, uncompressedLength);
      case 8: case 32946: return inflateDecode(raw);
      case 32773: return packBitsDecode(raw, uncompressedLength);
      default:
        throw new Error(`Unsupported compression: ${m.compressionName}`);
    }
  }

  private applyPredictor(m: PageMeta, data: Uint8Array, w: number, h: number, samplesInChunk: number) {
    if (m.predictor === 2) {
      undoHorizontalPredictor(data, w, h, samplesInChunk, m.bitsPerSample[0], this.littleEndian);
    } else if (m.predictor === 3) {
      undoFloatingPointPredictor(data, w, h, samplesInChunk, m.bitsPerSample[0], this.littleEndian);
    } else if (m.predictor !== 1) {
      throw new Error(`Unsupported predictor ${m.predictor}`);
    }
  }

  private decodeStripped(page: number, m: PageMeta, out: NumericArray) {
    const offsets = this.nums(page, TAG.StripOffsets);
    const counts = this.nums(page, TAG.StripByteCounts);
    if (!offsets || !counts) throw new Error(`Page ${page} has no StripOffsets/StripByteCounts`);

    const bits = m.bitsPerSample[0];
    const spp = m.samplesPerPixel;
    const planar = m.planarConfig === 2;
    const planes = planar ? spp : 1;
    const samplesPerPlane = planar ? 1 : spp;
    const rowsPerStrip = Math.min(m.rowsPerStrip, m.height);
    const stripsPerPlane = Math.ceil(m.height / rowsPerStrip);

    for (let p = 0; p < planes; p++) {
      for (let s = 0; s < stripsPerPlane; s++) {
        const idx = p * stripsPerPlane + s;
        if (idx >= offsets.length) break;
        const y0 = s * rowsPerStrip;
        const rows = Math.min(rowsPerStrip, m.height - y0);
        const uncompressed = Math.ceil((m.width * samplesPerPlane * bits) / 8) * rows;
        let bytes = this.chunk(m, offsets[idx], counts[idx], uncompressed);
        if (m.predictor !== 1) {
          bytes = copyIfShared(bytes);
          this.applyPredictor(m, bytes, m.width, rows, samplesPerPlane);
        }
        this.scatter(bytes, out, m, m.width, y0, 0, m.width, rows, samplesPerPlane, planar ? p : -1);
      }
    }
  }

  private decodeTiled(page: number, m: PageMeta, out: NumericArray) {
    const offsets = this.nums(page, TAG.TileOffsets);
    const counts = this.nums(page, TAG.TileByteCounts);
    if (!offsets || !counts) throw new Error(`Page ${page} is tiled but has no TileOffsets/TileByteCounts`);

    const tw = m.tileWidth!;
    const th = m.tileHeight!;
    const bits = m.bitsPerSample[0];
    const spp = m.samplesPerPixel;
    const planar = m.planarConfig === 2;
    const planes = planar ? spp : 1;
    const samplesPerPlane = planar ? 1 : spp;
    const across = Math.ceil(m.width / tw);
    const down = Math.ceil(m.height / th);

    for (let p = 0; p < planes; p++) {
      for (let ty = 0; ty < down; ty++) {
        for (let tx = 0; tx < across; tx++) {
          const idx = p * across * down + ty * across + tx;
          if (idx >= offsets.length) break;
          // Tiles are always full-size on disk, padded at the right/bottom edge.
          const uncompressed = Math.ceil((tw * samplesPerPlane * bits) / 8) * th;
          let bytes = this.chunk(m, offsets[idx], counts[idx], uncompressed);
          if (m.predictor !== 1) {
            bytes = copyIfShared(bytes);
            this.applyPredictor(m, bytes, tw, th, samplesPerPlane);
          }
          const w = Math.min(tw, m.width - tx * tw);
          const h = Math.min(th, m.height - ty * th);
          this.scatter(bytes, out, m, tw, ty * th, tx * tw, w, h, samplesPerPlane, planar ? p : -1);
        }
      }
    }
  }

  /**
   * Copy one decompressed chunk into the interleaved output raster.
   * `chunkWidth` is the on-disk row width (tile width, or image width for
   * strips); `w`/`h` is the valid region. `plane` >= 0 selects the destination
   * sample for planar layouts.
   */
  private scatter(
    bytes: Uint8Array, out: NumericArray, m: PageMeta,
    chunkWidth: number, y0: number, x0: number, w: number, h: number,
    samplesPerRow: number, plane: number,
  ) {
    const bits = m.bitsPerSample[0];
    const spp = m.samplesPerPixel;
    const le = this.littleEndian;

    if (bits < 8) { this.scatterSubByte(bytes, out as Uint8Array, m, chunkWidth, y0, x0, w, h, bits); return; }

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPer = bits / 8;
    const rowBytes = chunkWidth * samplesPerRow * bytesPer;
    const fmt = m.sampleFormat[0];

    // Fast path: uncompressed, host-endian, chunky data laid out exactly as the
    // destination wants it. This is what `tifffile` writes by default, and a
    // bulk `set()` is roughly an order of magnitude quicker than stepping a
    // DataView per sample.
    if (plane < 0 && (bytesPer === 1 || le === HOST_LITTLE_ENDIAN)) {
      const src = typedView(bytes, bits, fmt);
      if (src) {
        const valuesPerRow = chunkWidth * samplesPerRow;
        const copyPerRow = w * spp;
        for (let y = 0; y < h; y++) {
          const from = y * valuesPerRow;
          out.set(src.subarray(from, from + copyPerRow), ((y0 + y) * m.width + x0) * spp);
        }
        return;
      }
    }

    const read = readerFor(bits, fmt, dv, le);
    if (!read) throw new Error(`Unsupported sample: ${bits}-bit, SampleFormat ${fmt}`);

    for (let y = 0; y < h; y++) {
      const srcRow = y * rowBytes;
      const dstRow = ((y0 + y) * m.width + x0) * spp;
      if (plane < 0) {
        const n = w * spp;
        for (let i = 0; i < n; i++) out[dstRow + i] = read(srcRow + i * bytesPer);
      } else {
        for (let x = 0; x < w; x++) out[dstRow + x * spp + plane] = read(srcRow + x * bytesPer);
      }
    }
  }

  private scatterSubByte(
    bytes: Uint8Array, out: Uint8Array, m: PageMeta,
    chunkWidth: number, y0: number, x0: number, w: number, h: number, bits: number,
  ) {
    const spp = m.samplesPerPixel;
    const rowBytes = Math.ceil((chunkWidth * spp * bits) / 8);
    const mask = (1 << bits) - 1;
    // Scale so 1-bit and 4-bit images land on a sensible 0..255 display range.
    const scale = m.photometric === PHOTOMETRIC.Palette ? 1 : 255 / mask;
    for (let y = 0; y < h; y++) {
      let bit = y * rowBytes * 8;
      const dstRow = ((y0 + y) * m.width + x0) * spp;
      for (let i = 0; i < w * spp; i++) {
        const byte = bytes[bit >> 3];
        const shift = 8 - bits - (bit & 7);
        out[dstRow + i] = Math.round(((byte >> shift) & mask) * scale);
        bit += bits;
      }
    }
  }
}

// ---- helpers -------------------------------------------------------------

function range(n: number, f: (i: number) => number): number[] {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = f(i);
  return a;
}

function copyIfShared(a: Uint8Array): Uint8Array {
  // chunk() may hand back a view straight into the file buffer; predictors
  // mutate in place, so never write through such a view.
  return new Uint8Array(a);
}

export function dtypeOf(bits: number, sampleFormat: number): DType {
  if (sampleFormat === 3) {
    if (bits === 32) return 'float32';
    if (bits === 64) return 'float64';
    if (bits === 16) return 'float32'; // half floats widen on read
    throw new Error(`Unsupported float width: ${bits} bits`);
  }
  const signed = sampleFormat === 2;
  switch (bits) {
    case 1: case 2: case 4: case 8: return signed ? 'int8' : 'uint8';
    case 16: return signed ? 'int16' : 'uint16';
    case 32: return signed ? 'int32' : 'uint32';
    case 64: return 'float64'; // 64-bit ints are widened; > 2^53 loses precision
    default: throw new Error(`Unsupported bit depth: ${bits}`);
  }
}

export function allocate(dtype: DType, n: number): NumericArray {
  switch (dtype) {
    case 'uint8': return new Uint8Array(n);
    case 'int8': return new Int8Array(n);
    case 'uint16': return new Uint16Array(n);
    case 'int16': return new Int16Array(n);
    case 'uint32': return new Uint32Array(n);
    case 'int32': return new Int32Array(n);
    case 'float32': return new Float32Array(n);
    default: return new Float64Array(n);
  }
}

export const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * A typed-array view over decompressed bytes, when the element type has a
 * direct JS equivalent. Returns null when it does not (64-bit ints, half
 * floats), or when the offset is not aligned for that element size.
 */
function typedView(bytes: Uint8Array, bits: number, fmt: number): NumericArray | null {
  const width = bits / 8;
  if (bytes.byteOffset % width !== 0) return null;
  const n = (bytes.byteLength / width) | 0;
  const { buffer, byteOffset } = bytes;
  if (fmt === 3) {
    if (bits === 32) return new Float32Array(buffer, byteOffset, n);
    if (bits === 64) return new Float64Array(buffer, byteOffset, n);
    return null;
  }
  const signed = fmt === 2;
  switch (bits) {
    // 8-bit needs no byte-order agreement, so RGB images take this path too.
    case 8: return signed ? new Int8Array(buffer, byteOffset, n) : new Uint8Array(buffer, byteOffset, n);
    case 16: return signed ? new Int16Array(buffer, byteOffset, n) : new Uint16Array(buffer, byteOffset, n);
    case 32: return signed ? new Int32Array(buffer, byteOffset, n) : new Uint32Array(buffer, byteOffset, n);
    default: return null;
  }
}

function readerFor(bits: number, fmt: number, dv: DataView, le: boolean): ((o: number) => number) | null {
  if (fmt === 3) {
    if (bits === 32) return o => dv.getFloat32(o, le);
    if (bits === 64) return o => dv.getFloat64(o, le);
    if (bits === 16) return o => halfToFloat(dv.getUint16(o, le));
    return null;
  }
  const signed = fmt === 2;
  switch (bits) {
    case 8: return signed ? (o => dv.getInt8(o)) : (o => dv.getUint8(o));
    case 16: return signed ? (o => dv.getInt16(o, le)) : (o => dv.getUint16(o, le));
    case 32: return signed ? (o => dv.getInt32(o, le)) : (o => dv.getUint32(o, le));
    case 64: return signed
      ? (o => Number(dv.getBigInt64(o, le)))
      : (o => Number(dv.getBigUint64(o, le)));
    default: return null;
  }
}

export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}
