export type DType =
  | 'uint8' | 'int8'
  | 'uint16' | 'int16'
  | 'uint32' | 'int32'
  | 'uint64' | 'int64'
  | 'float32' | 'float64';

export type NumericArray =
  | Uint8Array | Int8Array
  | Uint16Array | Int16Array
  | Uint32Array | Int32Array
  | Float32Array | Float64Array;

export const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  FillOrder: 266,
  ImageDescription: 270,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  ResolutionUnit: 296,
  Software: 305,
  DateTime: 306,
  Predictor: 317,
  ColorMap: 320,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  ExtraSamples: 338,
  SampleFormat: 339,
  ImageJMetadataByteCounts: 50838,
  ImageJMetadata: 50839,
} as const;

export const COMPRESSION_NAMES: Record<number, string> = {
  1: 'none', 2: 'CCITT 1D', 3: 'Group 3 Fax', 4: 'Group 4 Fax', 5: 'LZW',
  6: 'old JPEG', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits', 32946: 'ZIP',
  33003: 'JPEG 2000', 34925: 'LZMA', 50000: 'Zstd', 50001: 'WebP', 50002: 'JPEG XL',
};

export const PHOTOMETRIC = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  RGB: 2,
  Palette: 3,
  TransparencyMask: 4,
  CMYK: 5,
  YCbCr: 6,
} as const;

/** Everything we learn about a page without touching its pixel data. */
export interface PageMeta {
  index: number;
  width: number;
  height: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  sampleFormat: number[];
  dtype: DType;
  compression: number;
  compressionName: string;
  photometric: number;
  planarConfig: number;
  predictor: number;
  fillOrder: number;
  rowsPerStrip: number;
  tileWidth?: number;
  tileHeight?: number;
  colorMap?: Uint16Array;
  extraSamples?: number[];
  description?: string;
  software?: string;
  resolution?: { x: number; y: number; unit: number };
}

export interface DecodedPage {
  width: number;
  height: number;
  samplesPerPixel: number;
  dtype: DType;
  /** Interleaved samples, length = width * height * samplesPerPixel. */
  data: NumericArray;
}

/** Logical shape/axis information recovered from ImageDescription. */
export interface StackMeta {
  /** Total pages in the file. */
  pages: number;
  channels: number;
  slices: number;
  frames: number;
  hyperstack: boolean;
  /** Display range saved by ImageJ, if present. */
  savedMin?: number;
  savedMax?: number;
  unit?: string;
  spacing?: number;
  /** Logical array shape as recorded by tifffile, if present. */
  shape?: number[];
  /** Human-readable note about where this came from. */
  source: 'imagej' | 'tifffile' | 'pages' | 'sequence';
}

export function bytesPerSample(dtype: DType): number {
  switch (dtype) {
    case 'uint8': case 'int8': return 1;
    case 'uint16': case 'int16': return 2;
    case 'uint32': case 'int32': case 'float32': return 4;
    case 'uint64': case 'int64': case 'float64': return 8;
  }
}

export function isFloat(dtype: DType): boolean {
  return dtype === 'float32' || dtype === 'float64';
}
