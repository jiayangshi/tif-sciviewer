/**
 * Multi-file stacks, in the spirit of ImageJ's File > Import > Image Sequence.
 *
 * A selection of single-image TIFFs is presented as one stack: page N of the
 * sequence is page N of the concatenated files. Deliberately free of any
 * `vscode` import so it can be unit-tested in plain Node; callers hand in a
 * factory that turns an opaque id (a URI string in the extension, a path in
 * tests) into a reader.
 */
import { deflateRawSync, inflateRawSync } from 'zlib';
import { TiffFile, ByteReader } from './tiff/decoder';
import { PageMeta, DecodedPage, StackMeta } from './tiff/types';

/** The page-level surface `SliceSource` needs; `TiffFile` already satisfies it. */
export interface PageProvider {
  readonly pageCount: number;
  meta(page: number): PageMeta;
  decode(page: number): DecodedPage;
  stackMeta(): StackMeta;
  close?(): void;
}

// ---------------------------------------------------------------- ordering

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Order an image sequence the way a person reads numbers, so `slice_2` lands
 * before `slice_10`. Explorer hands over its selection in click order, which is
 * never the order the slices belong in.
 */
export function naturalCompare(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  // Collator ignores case and width; fall back to a byte order so that two
  // names it considers equal still sort deterministically.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortSequence(ids: string[]): string[] {
  return [...ids].sort(naturalCompare);
}

// ------------------------------------------------------------- uri round-trip

/** Query key carrying the member list on a stack's editor URI. */
export const SEQUENCE_QUERY = 'sequence';

interface Encoded {
  v: 1;
  /** Shared prefix, stored once - an image sequence usually lives in one folder. */
  base: string;
  items: string[];
}

function commonBase(ids: string[]): string {
  if (ids.length === 0) return '';
  let prefix = ids[0];
  for (const id of ids) {
    let i = 0;
    while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  // Cut back to a separator so each remainder is a whole file name.
  const cut = prefix.lastIndexOf('/');
  return cut >= 0 ? prefix.slice(0, cut + 1) : '';
}

/**
 * Pack the member list into something that survives in a URI query. The list
 * travels with the editor rather than living in a side table, so a stack tab
 * still resolves after a window reload.
 *
 * Slice names in a sequence are nearly identical to one another, so deflate
 * takes a 2000-file volume from tens of kilobytes to a couple - worth doing
 * when the result has to sit in a URI. Raw deflate is deterministic, so
 * reopening the same selection lands on the same tab instead of a second one.
 */
export function encodeSequence(ids: string[]): string {
  const base = commonBase(ids);
  const payload: Encoded = { v: 1, base, items: ids.map(id => id.slice(base.length)) };
  return deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
    .toString('base64url');
}

/** The `query` to hang on a stack's editor URI. */
export function sequenceQuery(ids: string[]): string {
  return `${SEQUENCE_QUERY}=${encodeSequence(ids)}`;
}

/** Member list carried by a URI query, or undefined if this is a plain file. */
export function sequenceFromQuery(query: string): string[] | undefined {
  if (!query) return undefined;
  const value = new URLSearchParams(query).get(SEQUENCE_QUERY);
  return value ? decodeSequence(value) : undefined;
}

export function decodeSequence(encoded: string): string[] {
  let payload: Encoded;
  try {
    payload = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
  } catch {
    throw new Error('This stack cannot be reopened: its file list is not readable.');
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('This stack cannot be reopened: its file list is not readable.');
  }
  const base = typeof payload.base === 'string' ? payload.base : '';
  return payload.items.map(item => base + String(item));
}

// ------------------------------------------------------------- page mapping

export interface SequenceEntry {
  /** Opaque id handed back to the reader factory. */
  id: string;
  /** Trailing path segment, shown against the slice slider. */
  name: string;
  pages: number;
  /** Global index of this file's first page. */
  start: number;
  bytes: number;
}

export type ReaderFactory = (id: string) => ByteReader;

export function baseName(id: string): string {
  const withoutQuery = id.split('?')[0];
  const segment = withoutQuery.split('/').pop() ?? withoutQuery;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Presents N files as one page-addressable stack.
 *
 * Headers for every member are read up front - that is what makes the slider
 * length and the shape check honest - but pixels stay on disk until a slice is
 * actually shown, and only a handful of files are held open at a time.
 */
export class SequenceSource implements PageProvider {
  readonly entries: SequenceEntry[] = [];
  readonly pageCount: number;
  readonly totalBytes: number;

  private open = new Map<number, { tiff: TiffFile; reader: ByteReader }>();

  constructor(
    ids: string[],
    private openReader: ReaderFactory,
    private maxOpenFiles = 8,
  ) {
    if (ids.length === 0) throw new Error('A stack needs at least one file.');

    let start = 0;
    let bytes = 0;
    let shape: { width: number; height: number; spp: number; dtype: string } | undefined;
    let shapeFrom = '';

    for (const id of ids) {
      const name = baseName(id);
      let reader: ByteReader;
      try {
        reader = this.openReader(id);
      } catch (e) {
        throw new Error(`${name} could not be opened: ${message(e)}`);
      }
      try {
        const tiff = new TiffFile(reader);
        const meta = tiff.meta(0);
        const here = {
          width: meta.width, height: meta.height,
          spp: meta.samplesPerPixel, dtype: meta.dtype as string,
        };
        if (!shape) {
          shape = here;
          shapeFrom = name;
        } else if (
          here.width !== shape.width || here.height !== shape.height
          || here.spp !== shape.spp || here.dtype !== shape.dtype
        ) {
          throw new Error(
            `${name} is ${describeShape(here)} but ${shapeFrom} is ${describeShape(shape)}. `
            + 'Every file in a stack has to have the same shape and pixel type.',
          );
        }
        this.entries.push({ id, name, pages: tiff.pageCount, start, bytes: reader.size });
        start += tiff.pageCount;
        bytes += reader.size;
      } catch (e) {
        throw new Error(`${name}: ${message(e)}`);
      } finally {
        reader.close?.();
      }
    }

    this.pageCount = start;
    this.totalBytes = bytes;
  }

  /** Which file a global page index falls in. */
  locate(page: number): { fileIndex: number; localPage: number; entry: SequenceEntry } {
    if (!Number.isInteger(page) || page < 0 || page >= this.pageCount) {
      throw new Error(`Slice ${page} is outside the stack (${this.pageCount} slices).`);
    }
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.entries[mid].start <= page) lo = mid; else hi = mid - 1;
    }
    const entry = this.entries[lo];
    return { fileIndex: lo, localPage: page - entry.start, entry };
  }

  /** One label per global page, for the viewer's slice readout. */
  sliceLabels(): string[] {
    const labels: string[] = [];
    for (const e of this.entries) {
      for (let p = 0; p < e.pages; p++) {
        labels.push(e.pages > 1 ? `${e.name} [${p + 1}/${e.pages}]` : e.name);
      }
    }
    return labels;
  }

  meta(page: number): PageMeta {
    const { fileIndex, localPage } = this.locate(page);
    // Report the global index so size/decode errors name the slice the user is on.
    return { ...this.tiffFor(fileIndex).meta(localPage), index: page };
  }

  decode(page: number): DecodedPage {
    const { fileIndex, localPage, entry } = this.locate(page);
    try {
      return this.tiffFor(fileIndex).decode(localPage);
    } catch (e) {
      throw new Error(`${entry.name}: ${message(e)}`);
    }
  }

  stackMeta(): StackMeta {
    return {
      pages: this.pageCount,
      channels: 1,
      slices: this.pageCount,
      frames: 1,
      hyperstack: false,
      source: 'sequence',
    };
  }

  /** Open handles are pooled: a 500-file stack must not need 500 descriptors. */
  private tiffFor(fileIndex: number): TiffFile {
    const hit = this.open.get(fileIndex);
    if (hit) {
      this.open.delete(fileIndex);
      this.open.set(fileIndex, hit); // refresh LRU position
      return hit.tiff;
    }
    const reader = this.openReader(this.entries[fileIndex].id);
    let tiff: TiffFile;
    try {
      tiff = new TiffFile(reader);
    } catch (e) {
      reader.close?.();
      throw e;
    }
    this.open.set(fileIndex, { tiff, reader });
    while (this.open.size > this.maxOpenFiles) {
      const oldest = this.open.keys().next().value as number;
      this.open.get(oldest)!.reader.close?.();
      this.open.delete(oldest);
    }
    return tiff;
  }

  get openFileCount(): number { return this.open.size; }

  close() {
    for (const { reader } of this.open.values()) reader.close?.();
    this.open.clear();
  }
}

function describeShape(s: { width: number; height: number; spp: number; dtype: string }): string {
  return `${s.width}x${s.height}${s.spp > 1 ? `x${s.spp}` : ''} ${s.dtype}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
