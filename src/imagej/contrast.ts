/**
 * Ports of the two ImageJ contrast algorithms. See docs/IMAGEJ_ANALYSIS.md
 * sections 3 and 4 for the original Java these mirror.
 */
import { Stats } from './stats';

export const AUTO_THRESHOLD = 5000;

export interface Range { min: number; max: number }

/**
 * ij.plugin.frame.ContrastAdjuster.autoAdjust.
 *
 * `state` carries the `autoThreshold` field across clicks: each press halves it
 * for a progressively tighter stretch, resetting to 5000 once it drops below
 * 10. Returns the new display range and the updated state.
 */
export function autoAdjust(stats: Stats, previousAutoThreshold: number): { range: Range; autoThreshold: number } {
  let autoThreshold = previousAutoThreshold;
  if (autoThreshold < 10) autoThreshold = AUTO_THRESHOLD;
  else autoThreshold = Math.floor(autoThreshold / 2);

  const { histogram, pixelCount } = stats;
  // Bins holding more than 10% of the image are treated as empty. This is what
  // stops a constant CT background plateau from swallowing the stretch.
  const limit = Math.floor(pixelCount / 10);
  const threshold = Math.floor(pixelCount / autoThreshold);

  let i = -1;
  let found = false;
  let count = 0;
  do {
    i++;
    count = histogram[i];
    if (count > limit) count = 0;
    found = count > threshold;
  } while (!found && i < 255);
  const hmin = i;

  i = 256;
  found = false;
  do {
    i--;
    count = histogram[i];
    if (count > limit) count = 0;
    found = count > threshold;
  } while (!found && i > 0);
  const hmax = i;

  if (hmax >= hmin) {
    let min = stats.histMin + hmin * stats.binSize;
    let max = stats.histMin + hmax * stats.binSize;
    if (min === max) { min = stats.min; max = stats.max; }
    return { range: { min, max }, autoThreshold };
  }
  return { range: { min: stats.min, max: stats.max }, autoThreshold };
}

/**
 * ij.plugin.ContrastEnhancer.stretchHistogram — the Process > Enhance Contrast
 * command. Cumulative, so `saturated` percent of pixels really are clipped,
 * split between the two ends.
 */
export function stretchHistogram(stats: Stats, saturated = 0.35): Range {
  const { histogram, pixelCount } = stats;
  const threshold = saturated > 0 ? Math.floor((pixelCount * saturated) / 200.0) : 0;

  let i = -1;
  let count = 0;
  let found = false;
  do {
    i++;
    count += histogram[i];
    found = count > threshold;
  } while (!found && i < 255);
  const hmin = i;

  i = 256;
  count = 0;
  found = false;
  do {
    i--;
    count += histogram[i];
    found = count > threshold;
  } while (!found && i > 0);
  const hmax = i;

  if (hmax > hmin) {
    const min = stats.histMin + hmin * stats.binSize;
    const max = stats.histMin + hmax * stats.binSize;
    if (min !== max) return { min, max };
  }
  return { min: stats.min, max: stats.max };
}

/** Reset: the full data range, exactly as ImageJ's Reset button does. */
export function resetRange(stats: Stats): Range {
  if (stats.dtype === 'uint8') return { min: 0, max: 255 };
  return { min: stats.min, max: stats.max };
}

/**
 * Brightness/contrast sliders as derived views over (min, max), matching how
 * ImageJ's two lower sliders behave. Both take and return 0..1.
 */
export function fromBrightnessContrast(full: Range, brightness: number, contrast: number): Range {
  const fullRange = full.max - full.min || 1;
  // contrast 0.5 == unchanged width; 1 == very narrow window; 0 == very wide.
  const slope = contrast <= 0.5 ? contrast * 2 : 1 / ((1 - contrast) * 2 || 1e-6);
  const width = fullRange / Math.max(slope, 1e-6);
  const center = full.max - brightness * fullRange;
  return { min: center - width / 2, max: center + width / 2 };
}

export function toBrightnessContrast(full: Range, cur: Range): { brightness: number; contrast: number } {
  const fullRange = full.max - full.min || 1;
  const width = cur.max - cur.min || 1e-9;
  const center = (cur.min + cur.max) / 2;
  const slope = fullRange / width;
  const contrast = slope <= 1 ? slope / 2 : 1 - 1 / (2 * slope);
  const brightness = (full.max - center) / fullRange;
  return {
    brightness: Math.min(1, Math.max(0, brightness)),
    contrast: Math.min(1, Math.max(0, contrast)),
  };
}
