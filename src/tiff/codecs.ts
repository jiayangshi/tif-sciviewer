/**
 * Decompression codecs, mirroring the set ij.io.ImageReader supports.
 */
import * as zlib from 'zlib';

/**
 * TIFF LZW (spec section 13). Differs from GIF LZW in two ways: codes are
 * packed MSB-first, and the code width increases one code *early*, which is the
 * classic source of off-by-one bugs here.
 */
export function lzwDecode(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let outPos = 0;

  // Dictionary as (prefix, suffix) pairs so we never allocate per-entry arrays.
  const MAX = 4096;
  const prefix = new Int32Array(MAX);
  const suffix = new Uint8Array(MAX);
  const length = new Int32Array(MAX);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; length[i] = 1; }

  let next = 258;
  let codeWidth = 9;
  let bitPos = 0;
  const totalBits = input.length * 8;
  // Scratch big enough for the longest possible dictionary entry.
  const scratch = new Uint8Array(MAX);

  const readCode = (): number => {
    if (bitPos + codeWidth > totalBits) return 257; // treat truncation as EOI
    let code = 0;
    for (let i = 0; i < codeWidth; i++) {
      const byte = input[(bitPos + i) >> 3];
      const bit = (byte >> (7 - ((bitPos + i) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += codeWidth;
    return code;
  };

  const emit = (code: number): number => {
    // Walk the prefix chain backwards into scratch, then copy forwards.
    let n = 0;
    let c = code;
    while (c >= 0) { scratch[n++] = suffix[c]; c = prefix[c]; }
    for (let i = n - 1; i >= 0; i--) {
      if (outPos < expectedLength) out[outPos++] = scratch[i];
    }
    return scratch[n - 1]; // first byte of the entry
  };

  const reset = () => {
    next = 258;
    codeWidth = 9;
  };

  let oldCode = -1;
  for (;;) {
    const code = readCode();
    if (code === 257) break;            // EOI
    if (code === 256) { reset(); oldCode = -1; continue; }

    if (oldCode === -1) {
      emit(code);
      oldCode = code;
    } else {
      let firstByte: number;
      if (code < next) {
        firstByte = emit(code);
      } else {
        // KwKwK case: the code is the one we are about to define.
        let c = oldCode;
        while (prefix[c] >= 0) c = prefix[c];
        firstByte = suffix[c];
        // emit oldCode's string followed by its own first byte
        emitEntryPlusByte(oldCode, firstByte);
      }
      if (next < MAX) {
        prefix[next] = oldCode;
        suffix[next] = firstByte;
        length[next] = length[oldCode] + 1;
        next++;
      }
      oldCode = code;
    }
    if (next + 1 === 512) codeWidth = 10;
    else if (next + 1 === 1024) codeWidth = 11;
    else if (next + 1 === 2048) codeWidth = 12;
    if (outPos >= expectedLength) break;
  }

  function emitEntryPlusByte(code: number, extra: number) {
    let n = 0;
    let c = code;
    while (c >= 0) { scratch[n++] = suffix[c]; c = prefix[c]; }
    for (let i = n - 1; i >= 0; i--) {
      if (outPos < expectedLength) out[outPos++] = scratch[i];
    }
    if (outPos < expectedLength) out[outPos++] = extra;
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
  if (bitsPerSample === 8) {
    const rowBytes = width * samples;
    for (let y = 0; y < height; y++) {
      const base = y * rowBytes;
      for (let x = samples; x < rowBytes; x++) data[base + x] = (data[base + x] + data[base + x - samples]) & 0xff;
    }
  } else if (bitsPerSample === 16) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rowVals = width * samples;
    for (let y = 0; y < height; y++) {
      const base = y * rowVals * 2;
      for (let x = samples; x < rowVals; x++) {
        const cur = view.getUint16(base + x * 2, littleEndian);
        const prev = view.getUint16(base + (x - samples) * 2, littleEndian);
        view.setUint16(base + x * 2, (cur + prev) & 0xffff, littleEndian);
      }
    }
  } else if (bitsPerSample === 32) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rowVals = width * samples;
    for (let y = 0; y < height; y++) {
      const base = y * rowVals * 4;
      for (let x = samples; x < rowVals; x++) {
        const cur = view.getUint32(base + x * 4, littleEndian);
        const prev = view.getUint32(base + (x - samples) * 4, littleEndian);
        view.setUint32(base + x * 4, (cur + prev) >>> 0, littleEndian);
      }
    }
  } else {
    throw new Error(`Predictor 2 is not defined for ${bitsPerSample}-bit samples`);
  }
}

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
  const rowBytes = width * samples * bytesPerSample;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const base = y * rowBytes;
    for (let i = 1; i < rowBytes; i++) data[base + i] = (data[base + i] + data[base + i - 1]) & 0xff;
    const count = width * samples;
    for (let i = 0; i < count; i++) {
      for (let b = 0; b < bytesPerSample; b++) {
        // Plane b holds byte b (most significant first) of every sample.
        const src = data[base + b * count + i];
        const dstByte = littleEndian ? bytesPerSample - 1 - b : b;
        tmp[i * bytesPerSample + dstByte] = src;
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
