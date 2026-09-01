/**
 * The display-range mapping, kept as pure functions so the exact ImageJ
 * rounding can be unit-tested away from any canvas.
 *
 * ij.process.FloatProcessor.create8BitImage:
 *   scale  = 255.0/(max-min)
 *   value  = max(pixel-min, 0)
 *   ivalue = (int)(value*scale + 0.5)   // truncation, after adding 0.5
 *   if (ivalue>255) ivalue = 255
 */
import { NumericArray } from '../tiff/types';
import { Lut } from './luts';

export interface MapOptions {
  channels?: number;
  /** Map only this sample of an interleaved image; -1 maps every sample. */
  channel?: number;
  /** Receives 1 wherever the source value was NaN or +/-Inf. */
  mask?: Uint8Array;
  /**
   * Set when the caller already knows there are no NaN/Inf values - the
   * statistics pass counts them, so this is free information. It lets the
   * per-frame loop drop its finiteness test entirely, which is most of the
   * cost on a multi-megapixel float image.
   */
  assumeFinite?: boolean;
}

/**
 * Map raw values to 0..255 display indices. `out.length` must be the number of
 * pixels being mapped. Returns how many pixels were non-finite.
 */
export function mapTo8Bit(
  data: NumericArray, min: number, max: number, out: Uint8Array, opts: MapOptions = {},
): number {
  const channels = opts.channels ?? 1;
  const channel = opts.channel ?? -1;
  const mask = opts.mask;
  if (mask) mask.fill(0);

  // A degenerate range is the limit of an infinitely steep ramp: everything at
  // or above the level is white, everything below is black.
  const degenerate = !(max > min);
  const scale = degenerate ? 0 : 255 / (max - min);

  const start = channel >= 0 ? channel : 0;
  const step = channel >= 0 ? channels : 1;

  if (degenerate) {
    let nonFinite = 0;
    let o = 0;
    for (let i = start; i < data.length; i += step, o++) {
      const v = data[i];
      if (!Number.isFinite(v)) { out[o] = 0; if (mask) mask[o] = 1; nonFinite++; continue; }
      out[o] = v >= max ? 255 : 0;
    }
    return nonFinite;
  }

  // Integer data cannot hold NaN or Inf, and a float image whose statistics
  // reported none does not need re-checking. That leaves a branch-free inner
  // loop, which matters because this runs per animation frame over every pixel
  // while a contrast slider is being dragged.
  const isFloat = data instanceof Float32Array || data instanceof Float64Array;
  const noChecks = !isFloat || opts.assumeFinite === true;

  if (noChecks && step === 1) {
    const n = data.length;
    for (let i = 0; i < n; i++) {
      let value = data[i] - min;
      if (value < 0) value = 0;
      const f = value * scale + 0.5;
      // f is at most 255.5 here unless the range is pathologically narrow, in
      // which case the comparison catches Infinity before the truncation.
      out[i] = f > 255 ? 255 : f | 0;
    }
    return 0;
  }

  let nonFinite = 0;
  let o = 0;
  for (let i = start; i < data.length; i += step, o++) {
    const v = data[i];
    if (isFloat && !Number.isFinite(v)) {
      out[o] = 0;
      if (mask) mask[o] = 1;
      nonFinite++;
      continue;
    }
    let value = v - min;
    if (value < 0) value = 0;
    const f = value * scale + 0.5;
    out[o] = f > 255 ? 255 : f | 0;
  }
  return nonFinite;
}

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Pack r,g,b into one word matching the in-memory byte order of RGBA data. */
function packPixel(r: number, g: number, b: number): number {
  return HOST_LITTLE_ENDIAN
    ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

/**
 * 257 packed words per LUT: 0..255 for the table, plus the NaN colour at 256.
 * Cached against the LUT instance, which getLut() also caches, so the table is
 * built once per LUT rather than once per frame.
 */
const packedLuts = new WeakMap<Lut, { key: string; table: Uint32Array }>();

function packedLut(lut: Lut, nanColor: [number, number, number]): Uint32Array {
  const key = nanColor.join(',');
  const hit = packedLuts.get(lut);
  if (hit && hit.key === key) return hit.table;
  const table = new Uint32Array(257);
  for (let i = 0; i < 256; i++) table[i] = packPixel(lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]);
  table[256] = packPixel(nanColor[0], nanColor[1], nanColor[2]);
  packedLuts.set(lut, { key, table });
  return table;
}

/**
 * Apply a 256-entry RGB table, exactly as ij.process.LUT does.
 *
 * Writing one 32-bit word per pixel instead of four bytes is worth roughly 4x
 * here, and this runs over every pixel on every frame of a slider drag.
 */
export function composeRGBA(
  indices: Uint8Array, lut: Lut, rgba: Uint8ClampedArray,
  mask?: Uint8Array, nanColor: [number, number, number] = [255, 0, 0],
): void {
  const n = indices.length;
  if (rgba.byteOffset % 4 === 0 && rgba.byteLength >= n * 4) {
    const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
    const table = packedLut(lut, nanColor);
    if (mask) {
      for (let i = 0; i < n; i++) words[i] = mask[i] ? table[256] : table[indices[i]];
    } else {
      for (let i = 0; i < n; i++) words[i] = table[indices[i]];
    }
    return;
  }

  // Misaligned destination: fall back to byte writes.
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (mask && mask[i]) {
      rgba[p] = nanColor[0]; rgba[p + 1] = nanColor[1]; rgba[p + 2] = nanColor[2]; rgba[p + 3] = 255;
      continue;
    }
    const k = indices[i] * 3;
    rgba[p] = lut[k];
    rgba[p + 1] = lut[k + 1];
    rgba[p + 2] = lut[k + 2];
    rgba[p + 3] = 255;
  }
}

/**
 * Colour images take the same display range on every channel and bypass the
 * LUT, which is what ImageJ's ColorProcessor does.
 */
export function renderColor(
  data: NumericArray, samplesPerPixel: number, min: number, max: number, rgba: Uint8ClampedArray,
): void {
  const degenerate = !(max > min);
  const scale = degenerate ? 0 : 255 / (max - min);
  const pixels = (data.length / samplesPerPixel) | 0;
  const map = (v: number) => {
    if (!Number.isFinite(v)) return 0;
    if (degenerate) return v >= max ? 255 : 0;
    let value = v - min;
    if (value < 0) value = 0;
    const iv = Math.trunc(value * scale + 0.5);
    return iv > 255 ? 255 : iv;
  };
  // A fourth sample is left opaque on purpose. TIFF only promises it is alpha
  // when ExtraSamples says so, and in scientific stacks it is far more often a
  // fourth measurement channel - honouring it as alpha would silently blank
  // out real data.
  for (let i = 0, p = 0, s = 0; i < pixels; i++, p += 4, s += samplesPerPixel) {
    rgba[p] = map(data[s]);
    rgba[p + 1] = map(data[s + 1]);
    rgba[p + 2] = map(data[s + 2]);
    rgba[p + 3] = 255;
  }
}

/**
 * Format a raw value for the status readout the way ImageJ does: integers
 * plainly, floats with enough digits to distinguish neighbouring CT numbers.
 */
export function formatValue(v: number, isFloatData: boolean): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  if (!isFloatData) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(4);
  return v.toFixed(4).replace(/\.?0+$/, '') || '0';
}
