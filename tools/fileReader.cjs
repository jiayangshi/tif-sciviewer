// The extension's positional reader, exposed to the benchmark without pulling
// in the `vscode` module that src/tiffDocument.ts depends on.
const fs = require('fs');
class FileByteReader {
  constructor(path) {
    this.fd = fs.openSync(path, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  read(offset, length) {
    if (length === 0) return new Uint8Array(0);
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
module.exports = { FileByteReader };
