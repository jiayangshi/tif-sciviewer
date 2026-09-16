#!/usr/bin/env node
/**
 * Write a folder of single-slice TIFFs - the shape of data that comes out of a
 * CT reconstruction, and the thing "Open as Stack" exists to put back together.
 *
 * Used two ways: as a CLI to make something to click on in the Extension
 * Development Host, and by test/sequence.test.mjs, which needs slices whose
 * pixel values it can predict.
 *
 *   node tools/make-sequence.mjs out/recon 24
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { phantomSlice } from './phantom.mjs';

const DTYPES = {
  float32: { bits: 32, format: 3, write: (b, v, o) => b.writeFloatLE(v, o) },
  uint16: { bits: 16, format: 1, write: (b, v, o) => b.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v))), o) },
};

/**
 * One uncompressed, single-strip, little-endian page - written the way tifffile
 * writes, which is what the decoder is tuned for.
 */
export function writeSliceTif(file, { width, height, pixels, dtype = 'float32' }) {
  const spec = DTYPES[dtype];
  if (!spec) throw new Error(`unsupported dtype ${dtype}`);
  const bytesPer = spec.bits / 8;
  const body = Buffer.alloc(width * height * bytesPer);
  for (let i = 0; i < pixels.length; i++) spec.write(body, pixels[i], i * bytesPer);

  const DESC = Buffer.from(`{"shape": [${height}, ${width}]}\0`, 'ascii');
  const tags = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, spec.bits], [259, 3, 1, 1],
    [262, 3, 1, 1], [270, 2, DESC.length, null], [273, 4, 1, null], [277, 3, 1, 1],
    [278, 4, 1, height], [279, 4, 1, body.length], [339, 3, 1, spec.format],
  ];

  const IFD_OFFSET = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = IFD_OFFSET + ifdSize;
  const descOffset = cursor; cursor += DESC.length;
  const dataOffset = cursor + (cursor % 2);

  const head = Buffer.alloc(dataOffset);
  head.write('II', 0, 'ascii');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(IFD_OFFSET, 4);
  head.writeUInt16LE(tags.length, IFD_OFFSET);

  tags.forEach(([tag, type, count, value], i) => {
    const o = IFD_OFFSET + 2 + i * 12;
    head.writeUInt16LE(tag, o);
    head.writeUInt16LE(type, o + 2);
    head.writeUInt32LE(count, o + 4);
    const v = tag === 270 ? descOffset : tag === 273 ? dataOffset : value;
    // SHORT values that fit inline sit in the low half of the value field.
    if (type === 3 && count === 1) head.writeUInt16LE(v, o + 8);
    else head.writeUInt32LE(v, o + 8);
  });
  head.writeUInt32LE(0, IFD_OFFSET + 2 + tags.length * 12); // no next IFD
  DESC.copy(head, descOffset);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, body]));
  return file;
}

/**
 * One slice of a synthetic volume, cut at evenly spaced depths through it.
 *
 * Slices differ in what they contain - organs come and go, the body tapers,
 * the spine passes vertebra and disc - which is what actually varies through a
 * reconstruction. Two earlier versions got this wrong in instructive ways:
 *
 *  - `phantom + n` moved every slice a whole unit up the scale, so a display
 *    window held from slice 1 drew every other slice flat white.
 *  - Scaling the phantom's contrast fixed that, but shifting or scaling one
 *    image leaves a histogram drawn over its own min..max exactly the same, so
 *    every slice drew an identical histogram and the demo could never show
 *    whether the histogram follows the slice.
 *
 * Materials keep their values through the volume and air stays at -1, so one
 * display window covers every slice and none of them saturate.
 */
export function sliceValues(width, height, n, count) {
  return phantomSlice(width, height, count > 1 ? n / (count - 1) : 0.5);
}

/** A stack's worth of slices, written one file each. */
export function writeSequence(dir, {
  count = 8, width = 48, height = 32, prefix = 'slice_', pad = 4,
  dtype = 'float32',
} = {}) {
  const paths = [];
  for (let n = 0; n < count; n++) {
    const pixels = sliceValues(width, height, n, count);
    const name = `${prefix}${String(n + 1).padStart(pad, '0')}.tif`;
    paths.push(writeSliceTif(path.join(dir, name), { width, height, pixels, dtype }));
  }
  return paths;
}

/**
 * The value writeSequence puts at `index` of slice `n`. Comes from the same
 * function the writer uses, so the two cannot drift apart.
 */
export function expectedValue(width, height, index, n, count) {
  return sliceValues(width, height, n, count)[index];
}

// Compare like with like. A template of `file://${process.argv[1]}` skipped this
// whole block whenever the path held a space or any non-ASCII character, which
// percent-encode in import.meta.url; realpath because Node resolves symlinks
// there and not in argv (every macOS temp directory is one).
const invokedDirectly = process.argv[1]
  && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const dir = process.argv[2] ?? 'out/sequence';
  const count = Number(process.argv[3] ?? 24);
  const written = writeSequence(dir, { count, width: 256, height: 256 });
  console.log(`wrote ${written.length} slices to ${dir}/`);
  console.log(`  ${path.basename(written[0])} … ${path.basename(written[written.length - 1])}`);
  console.log('Select them all in the Explorer, right-click, "Open as Stack".');
}
