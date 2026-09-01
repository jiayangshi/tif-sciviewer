/**
 * Lookup tables ported from ij.plugin.LutLoader. Each is a flat RGB table of
 * 256*3 bytes, applied after the min/max mapping just like ij.process.LUT.
 */
export type Lut = Uint8Array; // length 768, r,g,b interleaved

function interpolate(r: number[], g: number[], b: number[]): Lut {
  // LutLoader.interpolate: expand an n-entry control table to 256 entries.
  const n = r.length;
  const lut = new Uint8Array(768);
  const scale = n / 256;
  for (let i = 0; i < 256; i++) {
    const i1 = Math.floor(i * scale);
    let i2 = i1 + 1;
    if (i2 === n) i2 = n - 1;
    const frac = i * scale - i1;
    lut[i * 3] = Math.round((1 - frac) * r[i1] + frac * r[i2]);
    lut[i * 3 + 1] = Math.round((1 - frac) * g[i1] + frac * g[i2]);
    lut[i * 3 + 2] = Math.round((1 - frac) * b[i1] + frac * b[i2]);
  }
  return lut;
}

function ramp(fr: number, fg: number, fb: number): Lut {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    lut[i * 3] = Math.round(i * fr);
    lut[i * 3 + 1] = Math.round(i * fg);
    lut[i * 3 + 2] = Math.round(i * fb);
  }
  return lut;
}

function grays(): Lut { return ramp(1, 1, 1); }

function invertedGrays(): Lut {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const v = 255 - i;
    lut[i * 3] = v; lut[i * 3 + 1] = v; lut[i * 3 + 2] = v;
  }
  return lut;
}

function fire(): Lut {
  const r = [0, 0, 1, 25, 49, 73, 98, 122, 146, 162, 173, 184, 195, 207, 217, 229, 240, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255];
  const g = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 35, 57, 79, 101, 117, 133, 147, 161, 175, 190, 205, 219, 234, 248, 255, 255, 255, 255];
  const b = [0, 61, 96, 130, 165, 192, 220, 227, 210, 181, 151, 122, 93, 64, 35, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 98, 160, 223, 255];
  return interpolate(r, g, b);
}

function ice(): Lut {
  const r = [0, 0, 0, 0, 0, 0, 19, 29, 50, 48, 79, 112, 134, 158, 186, 201, 217, 229, 242, 250, 250, 250, 250, 251, 250, 250, 250, 250, 251, 251, 243, 230];
  const g = [156, 165, 176, 184, 190, 196, 193, 184, 171, 162, 146, 125, 107, 93, 81, 87, 92, 97, 95, 93, 93, 90, 85, 69, 64, 54, 47, 35, 19, 0, 4, 0];
  const b = [140, 147, 158, 166, 170, 176, 209, 220, 234, 225, 236, 246, 250, 251, 250, 250, 245, 230, 230, 222, 202, 180, 163, 142, 123, 114, 106, 94, 84, 64, 26, 27];
  return interpolate(r, g, b);
}

function spectrum(): Lut {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = hsbToRgb(i / 255, 1, 1);
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
  }
  return lut;
}

/** java.awt.Color.getHSBColor, which is what LutLoader.spectrum uses. */
function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) { const g = Math.round(v * 255); return [g, g, g]; }
  const hh = (h - Math.floor(h)) * 6;
  const f = hh - Math.floor(hh);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const to = (x: number) => Math.round(x * 255 + 0.5) > 255 ? 255 : Math.floor(x * 255 + 0.5);
  switch (Math.floor(hh)) {
    case 0: return [to(v), to(t), to(p)];
    case 1: return [to(q), to(v), to(p)];
    case 2: return [to(p), to(v), to(t)];
    case 3: return [to(p), to(q), to(v)];
    case 4: return [to(t), to(p), to(v)];
    default: return [to(v), to(p), to(q)];
  }
}

function threeThreeTwo(): Lut {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    lut[i * 3] = i & 0xe0;
    lut[i * 3 + 1] = (i << 3) & 0xe0;
    lut[i * 3 + 2] = (i << 6) & 0xc0;
  }
  return lut;
}

export const LUT_NAMES = [
  'Grays', 'Inverted Grays', 'Fire', 'Ice', 'Spectrum', '3-3-2 RGB', 'Red', 'Green', 'Blue',
] as const;
export type LutName = typeof LUT_NAMES[number];

const BUILDERS: Record<LutName, () => Lut> = {
  'Grays': grays,
  'Inverted Grays': invertedGrays,
  'Fire': fire,
  'Ice': ice,
  'Spectrum': spectrum,
  '3-3-2 RGB': threeThreeTwo,
  'Red': () => ramp(1, 0, 0),
  'Green': () => ramp(0, 1, 0),
  'Blue': () => ramp(0, 0, 1),
};

const cache = new Map<string, Lut>();

export function getLut(name: string): Lut {
  const key = (LUT_NAMES as readonly string[]).includes(name) ? name : 'Grays';
  let lut = cache.get(key);
  if (!lut) { lut = BUILDERS[key as LutName](); cache.set(key, lut); }
  return lut;
}
