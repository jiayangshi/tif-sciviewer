import * as fs from 'fs';
import * as vscode from 'vscode';
import { BufferReader, ByteReader } from './tiff/decoder';
import { SliceSource, SlicePayload } from './sliceSource';
import { PageMeta, StackMeta } from './tiff/types';
import { SequenceSource, sequenceFromQuery, baseName } from './sequence';

/**
 * Positional reads straight off disk. A 200-page float32 stack is several GB;
 * only the pages being looked at are ever materialised.
 */
export class FileByteReader implements ByteReader {
  private fd: number;
  readonly size: number;
  constructor(path: string) {
    this.fd = fs.openSync(path, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  read(offset: number, length: number): Uint8Array {
    if (length === 0) return new Uint8Array(0);
    if (offset < 0 || offset + length > this.size) {
      throw new Error(`Read past end of file (offset ${offset}, length ${length}, size ${this.size})`);
    }
    // allocUnsafe draws from a shared pool, so byteOffset is arbitrary and the
    // decoder's typed-array fast path would be disqualified. Anything over
    // Buffer.poolSize/2 is allocated standalone at offset 0 anyway; below that
    // the copy is negligible.
    const buf = length > 8192 ? Buffer.allocUnsafeSlow(length) : Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(this.fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, read);
  }
  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

/** Set when the document is a stack assembled from several files. */
export interface SequenceInfo {
  count: number;
  /** One entry per slice, naming the file it came from. */
  labels: string[];
  /** Folder the members share, for the title. */
  folder: string;
}

export class TiffDocument implements vscode.CustomDocument {
  private constructor(
    readonly uri: vscode.Uri,
    private source: SliceSource,
    readonly fileSize: number,
    readonly sequence?: SequenceInfo,
  ) {}

  static async create(uri: vscode.Uri): Promise<TiffDocument> {
    const maxMb = vscode.workspace.getConfiguration('tifSciviewer').get('maxDecodedMegabytes', 512);
    const maxBytes = Math.max(1, maxMb) * 1024 * 1024;
    const CACHE_VALUES = 64 * 1024 * 1024;

    const members = sequenceFromQuery(uri.query);
    if (members) return TiffDocument.createSequence(uri, members, CACHE_VALUES, maxBytes);

    if (uri.scheme === 'file') {
      const reader = new FileByteReader(uri.fsPath);
      try {
        return new TiffDocument(uri, new SliceSource(reader, CACHE_VALUES, maxBytes), reader.size);
      } catch (e) {
        reader.close();
        throw e;
      }
    }
    // Virtual filesystems (git:, vscode-vfs:, ...) offer no positional read.
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TiffDocument(
      uri, new SliceSource(new BufferReader(bytes), CACHE_VALUES, maxBytes), bytes.byteLength,
    );
  }

  /**
   * A stack built from a multi-select. Members are read positionally like any
   * other file, so selecting 500 slices costs 500 header reads, not 500 decodes.
   */
  private static createSequence(
    uri: vscode.Uri, members: string[], cacheValues: number, maxBytes: number,
  ): TiffDocument {
    const uris = members.map(m => vscode.Uri.parse(m, true));
    const remote = uris.find(u => u.scheme !== 'file');
    if (remote) {
      throw new Error(
        `A stack can only be built from files on disk, but ${baseName(remote.toString())} is `
        + `"${remote.scheme}:". Open these one at a time instead.`,
      );
    }

    const seq = new SequenceSource(members, id => new FileByteReader(vscode.Uri.parse(id, true).fsPath));
    try {
      const source = new SliceSource(seq, cacheValues, maxBytes);
      const folder = baseName(uris[0].path.replace(/\/[^/]*$/, '')) || 'stack';
      return new TiffDocument(uri, source, seq.totalBytes, {
        count: seq.entries.length,
        labels: seq.sliceLabels(),
        folder,
      });
    } catch (e) {
      seq.close();
      throw e;
    }
  }

  get meta(): PageMeta { return this.source.meta; }
  get stack(): StackMeta { return this.source.stack; }
  get pageCount(): number { return this.source.pageCount; }

  slicePayload(index: number): SlicePayload { return this.source.payload(index); }

  /** Per channel, a display window representative of the whole stack; undefined for one page. */
  stackWindows() { return this.source.stackWindows(); }

  dispose(): void { this.source.dispose(); }
}
