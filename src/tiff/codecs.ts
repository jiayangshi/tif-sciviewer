/**
 * Decompression codecs, mirroring the set ij.io.ImageReader supports.
 */
import * as zlib from 'zlib';

/**
 * TIFF LZW (spec section 13). Differs from GIF LZW in two ways: codes are
 * packed MSB-first, and the code width increases one code *early*, which is the
 * classic source of off-by-one bugs here.
 *
 * Every dictionary entry past the 256 roots is the string of the code before
 * it plus one byte - and that is exactly what was just written to the output,
 * contiguously. So an entry is kept as where it starts in the output and how
 * long it is, and emitting it is a forward copy, with no chain to walk. On a
 * 4096x4096 float32 slice this is several times quicker than walking prefix
 * chains, which is the difference between a stack that keeps up and one that
 * does not.
 */
export function lzwDecode(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  const MAX = 4096;
  const start = new Int32Array(MAX);
  const length = new Int32Array(MAX).fill(1, 0, 256);

  const inLen = input.length;
  let inPos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let outPos = 0;
  let next = 258;
  let codeWidth = 9;
  let oldCode = -1;
  let oldPos = 0; // where oldCode's string was written

  while (outPos < expectedLength) {
    while (bitCount < codeWidth) {
      if (inPos >= inLen) return out; // truncation reads as EOI
      bitBuf = ((bitBuf << 8) | input[inPos++]) & 0xffffff;
      bitCount += 8;
    }
    bitCount -= codeWidth;
    const code = (bitBuf >>> bitCount) & ((1 << codeWidth) - 1);

    if (code === 257) break; // EOI
    if (code === 256) { next = 258; codeWidth = 9; oldCode = -1; continue; }

    const at = outPos;
    if (code < 256) {
      out[outPos++] = code;
    } else if (code < next) {
      const end = Math.min(outPos + length[code], expectedLength);
      for (let s = start[code]; outPos < end;) out[outPos++] = out[s++];
    } else if (oldCode >= 0) {
      // KwKwK: the code is the one about to be defined - oldCode's string
      // followed by its own first byte.
      const end = Math.min(outPos + length[oldCode], expectedLength);
      for (let s = oldPos; outPos < end;) out[outPos++] = out[s++];
      if (outPos < expectedLength) out[outPos++] = out[oldPos];
    } else {
      break; // a code that names nothing: the stream is corrupt
    }

    if (oldCode >= 0 && next < MAX) {
      // oldCode's string, then the first byte of this one: contiguous in the output.
      start[next] = oldPos;
      length[next] = length[oldCode] + 1;
      next++;
    }
    oldCode = code;
    oldPos = at;
    if (next + 1 === 512) codeWidth = 10;
    else if (next + 1 === 1024) codeWidth = 11;
    else if (next + 1 === 2048) codeWidth = 12;
  }
  return out;
}

/** PackBits run-length decoding (TIFF spec section 9). */
export function packBitsDecode(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expectedLength) {
    // The count byte is signed.
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) {
      const count = n + 1;
      for (let k = 0; k < count && i < input.length && o < expectedLength; k++) out[o++] = input[i++];
    } else if (n !== -128) {
      const count = 1 - n;
      const b = input[i++];
      for (let k = 0; k < count && o < expectedLength; k++) out[o++] = b;
    }
    // n === -128 is a no-op filler byte.
  }
  return out;
}

export function inflateDecode(input: Uint8Array): Uint8Array {
  // Adobe Deflate (8) and ZIP (32946) both carry a zlib wrapper in practice,
  // but a few writers emit raw deflate; fall back rather than fail.
  try {
    return new Uint8Array(zlib.inflateSync(Buffer.from(input.buffer, input.byteOffset, input.byteLength)));
  } catch {
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(input.buffer, input.byteOffset, input.byteLength)));
  }
}

/**
 * Predictor 2: horizontal differencing. Values are cumulative sums along each
 * row, taken per sample (channel), at the image's bit depth.
 */
export function undoHorizontalPredictor(
  data: Uint8Array, width: number, height: number, samples: number, bitsPerSample: number, littleEndian: boolean,
): void {
  const rowVals = width * samples;
  if (bitsPerSample === 8) {
    for (let y = 0; y < height; y++) {
      const base = y * rowVals;
      for (let x = samples; x < rowVals; x++) data[base + x] = (data[base + x] + data[base + x - samples]) & 0xff;
    }
    return;
  }
  if (bitsPerSample !== 16 && bitsPerSample !== 32) {
    throw new Error(`Predictor 2 is not defined for ${bitsPerSample}-bit samples`);
  }
  const bytes = bitsPerSample / 8;
  if (data.byteLength < height * rowVals * bytes) {
    // A truncated strip. Name it, rather than let the rows it lacks read as zero.
    throw new Error(`Predictor 2 data is shorter than its ${height} rows (${data.byteLength} bytes)`);
  }
  // In host byte order a typed array does the arithmetic, and wraps on store.
  if (littleEndian === HOST_LE && data.byteOffset % bytes === 0) {
    const n = (data.byteLength / bytes) | 0;
    const v = bytes === 2 ? new Uint16Array(data.buffer, data.byteOffset, n) : new Uint32Array(data.buffer, data.byteOffset, n);
    for (let y = 0; y < height; y++) {
      const base = y * rowVals;
      for (let x = samples; x < rowVals; x++) v[base + x] = v[base + x] + v[base + x - samples];
    }
    return;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let y = 0; y < height; y++) {
    const base = y * rowVals * bytes;
    for (let x = samples; x < rowVals; x++) {
      if (bytes === 2) {
        const cur = view.getUint16(base + x * 2, littleEndian);
        const prev = view.getUint16(base + (x - samples) * 2, littleEndian);
        view.setUint16(base + x * 2, (cur + prev) & 0xffff, littleEndian);
      } else {
        const cur = view.getUint32(base + x * 4, littleEndian);
        const prev = view.getUint32(base + (x - samples) * 4, littleEndian);
        view.setUint32(base + x * 4, (cur + prev) >>> 0, littleEndian);
      }
    }
  }
}

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Predictor 3: floating-point predictor. Bytes are stored de-interleaved
 * (all high bytes of the row, then the next byte plane, ...) and horizontally
 * differenced as *bytes*. Undo the differencing, then re-interleave. The byte
 * planes are always in big-endian order within a sample.
 */
export function undoFloatingPointPredictor(
  data: Uint8Array, width: number, height: number, samples: number, bitsPerSample: number, littleEndian: boolean,
): void {
  const bytesPerSample = bitsPerSample / 8;
  const count = width * samples;
  const rowBytes = count * bytesPerSample;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const base = y * rowBytes;
    let acc = data[base];
    for (let i = 1; i < rowBytes; i++) { acc = (acc + data[base + i]) & 0xff; data[base + i] = acc; }
    // Plane b holds byte b (most significant first) of every sample; the
    // common widths are unrolled, which this per-row loop spends most of its time on.
    const p = base;
    if (bytesPerSample === 4) {
      const [a, b, c, d] = littleEndian ? [3, 2, 1, 0] : [0, 1, 2, 3];
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        tmp[o + a] = data[p + i];
        tmp[o + b] = data[p + count + i];
        tmp[o + c] = data[p + 2 * count + i];
        tmp[o + d] = data[p + 3 * count + i];
      }
    } else {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < bytesPerSample; k++) {
          tmp[i * bytesPerSample + (littleEndian ? bytesPerSample - 1 - k : k)] = data[p + k * count + i];
        }
      }
    }
    data.set(tmp, base);
  }
}

export function reverseBits(data: Uint8Array): void {
  // FillOrder 2: each byte's bits are stored least-significant first.
  for (let i = 0; i < data.length; i++) {
    let b = data[i];
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
    data[i] = b;
  }
}
