/**
 * Port of ij.process.ImageStatistics: the 256-bin histogram summary that every
 * auto-contrast decision in ImageJ is made from.
 */
import { DType, NumericArray } from '../tiff/types';

export const N_BINS = 256;

export interface Stats {
  /** Number of finite pixels that entered the statistics. */
  pixelCount: number;
  /** Pixels excluded because they were NaN or +/-Inf. */
  nonFiniteCount: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  histogram: Int32Array;
  histMin: number;
  histMax: number;
  binSize: number;
  dtype: DType;
}

/**
 * ImageJ pins 8-bit histograms to 0..255 with a bin size of 1; everything wider
 * gets 256 bins spanning the real data range. Auto-contrast results differ
 * noticeably if you get this wrong, so it is reproduced exactly.
 */
export function computeStats(data: NumericArray, dtype: DType, channels = 1, channel = -1): Stats {
  const stride = channels;
  const start = channel >= 0 ? channel : 0;
  const step = channel >= 0 ? stride : 1;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let nonFinite = 0;

  // Optimistic first pass with no per-pixel finiteness test. NaN never wins a
  // comparison, so it cannot corrupt min/max, and it always poisons the sum -
  // which is exactly the signal that a careful second pass is needed. Most
  // images have no NaN or Inf at all and never pay for the check.
  for (let i = start; i < data.length; i += step) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    count++;
  }

  if (!Number.isFinite(sum) || !Number.isFinite(sumSq) || !Number.isFinite(min) || !Number.isFinite(max)) {
    // NaN/Inf are excluded rather than poisoning mean/stdDev, which is a
    // deliberate improvement on ImageJ's behaviour for float CT data.
    min = Infinity; max = -Infinity; sum = 0; sumSq = 0; count = 0;
    for (let i = start; i < data.length; i += step) {
      const v = data[i];
      if (!Number.isFinite(v)) { nonFinite++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
      count++;
    }
  }

  if (count === 0) {
    return {
      pixelCount: 0, nonFiniteCount: nonFinite, min: 0, max: 0, mean: 0, stdDev: 0,
      histogram: new Int32Array(N_BINS), histMin: 0, histMax: 0, binSize: 1, dtype,
    };
  }

  // Three binning rules, all from ImageJ:
  //  - 8-bit: the histogram *is* the value count, 0..255, bin size 1
  //    (ij.process.ByteProcessor.getHistogram).
  //  - other integers: 256 bins spanning min..max inclusive, hence the +1
  //    (ij.process.ShortStatistics.getHistogram).
  //  - float: 256 bins spanning min..max (ij.process.FloatStatistics).
  const eightBit = dtype === 'uint8' || dtype === 'int8';
  const integer = dtype !== 'float32' && dtype !== 'float64';

  let histMin: number;
  let histMax: number;
  let binSize: number;
  let scale: number;
  if (eightBit) {
    histMin = dtype === 'int8' ? -128 : 0;
    histMax = histMin + 255;
    binSize = 1;
    scale = 1;
  } else if (integer) {
    histMin = min; histMax = max;
    const span = histMax - histMin + 1;
    binSize = span / N_BINS;
    scale = N_BINS / span;
  } else {
    histMin = min; histMax = max;
    const span = histMax - histMin;
    binSize = span / N_BINS;
    scale = span > 0 ? N_BINS / span : 0;
  }

  const histogram = new Int32Array(N_BINS);
  for (let i = start; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    let idx = eightBit ? v - histMin : Math.floor(scale * (v - histMin));
    if (idx >= N_BINS) idx = N_BINS - 1;
    else if (idx < 0) idx = 0;
    histogram[idx]++;
  }

  const mean = sum / count;
  // Same variance form ImageJ uses (ij.process.ImageStatistics.calculateStdDev).
  let stdDev = (count * sumSq - sum * sum) / count;
  stdDev = stdDev > 0 ? Math.sqrt(stdDev / (count - 1 || 1)) : 0;

  return {
    pixelCount: count, nonFiniteCount: nonFinite, min, max, mean, stdDev,
    histogram, histMin, histMax, binSize, dtype,
  };
}

/** Value at the centre of a bin, for axis labelling. */
export function binValue(stats: Stats, bin: number): number {
  return stats.histMin + bin * stats.binSize;
}
