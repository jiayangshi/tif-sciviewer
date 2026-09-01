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
   * Pixel bytes as base64.
   *
   * Structured clone of an ArrayBuffer is not dependable across every
   * extension-host/webview transport VS Code uses - notably Remote-SSH and
   * vscode.dev, which are exactly the setups this extension exists for. Base64
   * costs 33% bandwidth and one decode pass, and always survives the trip.
   */
  base64: string;
  /** Byte order of the payload, so the webview can view or swap as needed. */
  littleEndian: boolean;
  stats: SerializableStats;
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
