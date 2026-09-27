/**
 * The extension-host <-> webview contract. Kept free of any decoder or Node
 * import so the webview bundle stays browser-only.
 */
import { DType, NumericArray } from './tiff/types';

export interface SerializableStats {
  pixelCount: number;
  nonFiniteCount: number;
  min: number; max: number; mean: number; stdDev: number;
  histMin: number; histMax: number; binSize: number;
  histogram: number[];
  dtype: DType;
}

export interface SlicePayload {
  type: 'slice';
  index: number;
  width: number;
  height: number;
  samplesPerPixel: number;
  dtype: DType;
  /**
   * Pixel bytes, as they sit in memory.
   *
   * For an extension whose `engines.vscode` is 1.57 or later, VS Code lifts
   * typed arrays out of a webview message and ships them alongside the JSON as
   * binary, over every transport it runs the extension host behind - local,
   * Remote-SSH, tunnels. Base64 in a JSON string was used before this, and for
   * a 4096x4096 float32 slice it came to an 85 MB string built, stringified,
   * parsed and decoded char by char on every step through a stack: most of
   * half a second, against a few milliseconds for the bytes themselves.
   *
   * It must be a plain Uint8Array over a buffer of exactly its own length:
   * VS Code recognises views by constructor name, so a Node Buffer would fall
   * through to JSON, and it sends the whole underlying ArrayBuffer.
   */
  pixels?: Uint8Array;
  /** The same bytes as base64, sent only to a webview that saw `pixels` arrive broken. */
  base64?: string;
  /**
   * 1 when every pixel is here. Otherwise the pixels are a preview holding
   * every step-th pixel each way (see sampledSize), while width, height and
   * stats still describe the whole slice.
   */
  step: number;
  /** Set when the pixels cover only this part of the slice; absent for all of it. */
  region?: Region;
  /** Byte order of the payload, so the webview can view or swap as needed. */
  littleEndian: boolean;
  stats: SerializableStats;
}

/** A rectangle of a slice, in the slice's own pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A requested region cut to a width x height slice, on whole pixels. Undefined
 * when that leaves nothing, or leaves the whole slice: either way, all of it.
 */
export function clipRegion(r: unknown, width: number, height: number): Region | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const q = r as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const x0 = Math.max(0, Math.floor(num(q.x)));
  const y0 = Math.max(0, Math.floor(num(q.y)));
  const x1 = Math.min(width, Math.ceil(num(q.x) + num(q.width)));
  const y1 = Math.min(height, Math.ceil(num(q.y) + num(q.height)));
  if (!(x1 > x0 && y1 > y0)) return undefined;
  if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Pages at least this big travel as previews while a stack is moving; below it
 * the whole page is cheap enough to send every time.
 */
export const PREVIEW_MIN_BYTES = 8 * 1024 * 1024;

/** Dimensions of a slice sampled at every `step`-th pixel in each direction. */
export function sampledSize(width: number, height: number, step: number): { width: number; height: number } {
  return { width: Math.ceil(width / step), height: Math.ceil(height / step) };
}

/** How a slice's pixels travel: see SlicePayload.pixels. */
export type PixelEncoding = 'binary' | 'base64';

/**
 * The bytes a payload carries, whichever way they came. Undefined when they did
 * not survive the trip, which is the webview's cue to ask for base64 instead.
 * `ArrayBuffer.isView` rather than `instanceof`, which a view made in another
 * realm fails.
 */
export function payloadBytes(p: { pixels?: unknown; base64?: unknown }): Uint8Array | undefined {
  const px = p.pixels;
  if (px !== undefined && px !== null && ArrayBuffer.isView(px)) {
    return new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
  }
  if (typeof p.base64 === 'string') return fromBase64(p.base64);
  return undefined;
}

export function isLittleEndianHost(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/** Chunked, so a large slice never overflows the argument limit of fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const b = Buffer.from(s, 'base64');
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function elementSize(dtype: DType): number {
  switch (dtype) {
    case 'uint8': case 'int8': return 1;
    case 'uint16': case 'int16': return 2;
    case 'uint32': case 'int32': case 'float32': return 4;
    default: return 8;
  }
}

/** Typed-array view over decoded bytes, byte-swapping if the hosts disagree. */
export function viewOf(bytes: Uint8Array, dtype: DType, littleEndian: boolean): NumericArray {
  const width = elementSize(dtype);
  let buf = bytes;
  if (width > 1 && littleEndian !== isLittleEndianHost()) {
    buf = bytes.slice();
    for (let i = 0; i + width <= buf.length; i += width) {
      for (let a = 0, b = width - 1; a < b; a++, b--) {
        const t = buf[i + a]; buf[i + a] = buf[i + b]; buf[i + b] = t;
      }
    }
  } else if (bytes.byteOffset % width !== 0) {
    buf = bytes.slice(); // typed arrays require an aligned byte offset
  }
  const { buffer, byteOffset, byteLength } = buf;
  const n = (byteLength / width) | 0;
  switch (dtype) {
    case 'uint8': return new Uint8Array(buffer, byteOffset, n);
    case 'int8': return new Int8Array(buffer, byteOffset, n);
    case 'uint16': return new Uint16Array(buffer, byteOffset, n);
    case 'int16': return new Int16Array(buffer, byteOffset, n);
    case 'uint32': return new Uint32Array(buffer, byteOffset, n);
    case 'int32': return new Int32Array(buffer, byteOffset, n);
    case 'float32': return new Float32Array(buffer, byteOffset, n);
    default: return new Float64Array(buffer, byteOffset, n);
  }
}
