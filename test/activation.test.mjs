import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { writeSequence, writeSliceTif, expectedValue } from '../tools/make-sequence.mjs';
import { phantomSlice } from '../tools/phantom.mjs';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const lib = createRequire(import.meta.url)(path.join(ROOT, 'dist', 'lib.cjs'));

/**
 * Load the built extension against a stub `vscode`, so activation, editor
 * registration and the message handler are exercised without a running VS Code.
 */
function makeUri({ scheme = 'file', path = '', query = '' }) {
  return {
    scheme, path, query,
    get fsPath() { return path; },
    with(o) { return makeUri({ scheme, path, query, ...o }); },
    toString() { return `${scheme}://${path}${query ? `?${query}` : ''}`; },
  };
}

function loadExtension(settings = {}) {
  const calls = { registered: [], commands: [], disposables: [], handlers: {}, executed: [], saveDialogs: [] };
  const stub = {
    Uri: {
      joinPath: (base, ...parts) => makeUri({ scheme: base.scheme, path: [base.path, ...parts].join('/') }),
      file: p => makeUri({ path: p }),
      parse: (s) => {
        const m = /^([a-zA-Z][\w+.-]*):\/\/([^?]*)(?:\?(.*))?$/.exec(s);
        if (!m) throw new Error(`cannot parse uri: ${s}`);
        return makeUri({ scheme: m[1], path: m[2], query: m[3] ?? '' });
      },
    },
    window: {
      registerCustomEditorProvider: (viewType, provider, opts) => {
        calls.registered.push({ viewType, provider, opts });
        return { dispose() {} };
      },
      showErrorMessage: m => calls.commands.push(['error', m]),
      showInformationMessage: m => calls.commands.push(['info', m]),
      showWarningMessage: m => calls.commands.push(['warn', m]),
      setStatusBarMessage: () => ({ dispose() {} }),
      showSaveDialog: async (opts) => { calls.saveDialogs.push(opts); return undefined; },
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: (id, fn) => {
        calls.commands.push(['register', id]);
        calls.handlers[id] = fn;
        return { dispose() {} };
      },
      executeCommand: async (...args) => { calls.executed.push(args); },
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      fs: { readFile: async () => new Uint8Array(0), writeFile: async () => {} },
    },
    env: { clipboard: { writeText: async () => {} } },
  };

  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub;
    return original.call(this, request, parent, isMain);
  };
  try {
    const require = createRequire(import.meta.url);
    const p = require.resolve(path.join(ROOT, 'dist', 'extension.js'));
    delete require.cache[p];
    return { ext: require(p), calls, stub };
  } finally {
    Module._load = original;
  }
}

describe('extension activation', () => {
  test('the bundle exports activate and deactivate', () => {
    const { ext } = loadExtension();
    assert.equal(typeof ext.activate, 'function');
    assert.equal(typeof ext.deactivate, 'function');
  });

  test('activate registers the custom editor and the command', () => {
    const { ext, calls } = loadExtension();
    const subscriptions = [];
    ext.activate({ subscriptions, extensionUri: { scheme: 'file', path: ROOT } });

    assert.equal(calls.registered.length, 1, 'one custom editor provider');
    assert.equal(calls.registered[0].viewType, 'tifSciviewer.preview');
    assert.ok(calls.registered[0].opts.webviewOptions.retainContextWhenHidden);
    assert.ok(calls.commands.some(c => c[0] === 'register' && c[1] === 'tifSciviewer.openWith'));
    assert.ok(subscriptions.length >= 2, 'everything registered must be disposable');
    ext.deactivate();
  });

  test('the generated HTML is CSP-locked and points at the bundled assets', () => {
    const { ext, calls } = loadExtension();
    ext.activate({ subscriptions: [], extensionUri: { scheme: 'file', path: ROOT } });
    const provider = calls.registered[0].provider;

    let html = '';
    const panel = {
      webview: {
        cspSource: 'vscode-webview://test',
        set options(v) { this._options = v; },
        get options() { return this._options; },
        set html(v) { html = v; },
        get html() { return html; },
        asWebviewUri: u => ({ toString: () => `https://webview/${String(u.path).split('/').pop()}` }),
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    const doc = {
      uri: { scheme: 'file', path: '/tmp/x.tif', fsPath: '/tmp/x.tif' },
      fileSize: 10, pageCount: 1,
      meta: { width: 1, height: 1, dtype: 'float32', bitsPerSample: [32], samplesPerPixel: 1, compression: 1, photometric: 1, planarConfig: 1 },
      stack: {}, slicePayload: () => ({ type: 'slice' }),
    };
    return provider.resolveCustomEditor(doc, panel, {}).then(() => {
      assert.match(html, /Content-Security-Policy/);
      assert.match(html, /script-src 'nonce-[A-Za-z0-9]{32}'/, 'scripts must be nonce-gated');
      assert.match(html, /default-src 'none'/);
      assert.match(html, /viewer\.js/);
      assert.match(html, /viewer\.css/);
      assert.ok(!/<script(?![^>]*nonce)/.test(html), 'no script tag without a nonce');
      assert.ok(panel.webview.options.enableScripts);
      assert.equal(panel.webview.options.localResourceRoots.length, 1, 'assets restricted to media/');
    });
  });
});

describe('packaged artifacts', () => {
  test('every file the manifest points at exists and is non-empty', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const f of [pkg.main, 'media/viewer.js', 'media/viewer.css']) {
      const p = path.join(ROOT, f);
      assert.ok(fs.existsSync(p), `${f} is missing - run npm run build`);
      assert.ok(fs.statSync(p).size > 1000, `${f} looks empty`);
    }
  });

  test('the webview bundle is browser-only', () => {
    const js = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
    assert.ok(!/require\(["']zlib["']\)/.test(js), 'zlib must not reach the webview');
    assert.ok(!/\bmodule\.exports\b/.test(js), 'should be an IIFE, not CommonJS');
  });

  test('the manifest claims tif and tiff, and runs on the remote host', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const patterns = pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern);
    assert.ok(patterns.includes('*.tif'));
    assert.ok(patterns.includes('*.tiff'));
    assert.deepEqual(pkg.extensionKind, ['workspace'], 'must decode where the files are');
    assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
      'runtime dependencies would break installing on an arbitrary remote');
  });
});

describe('Open as Stack', () => {
  const activate = () => {
    const loaded = loadExtension();
    loaded.ext.activate({ subscriptions: [], extensionUri: { scheme: 'file', path: ROOT } });
    return loaded;
  };
  const files = (...names) => names.map(n => makeUri({ path: `/data/recon/${n}` }));

  test('the command is registered', () => {
    const { calls } = activate();
    assert.ok(calls.commands.some(c => c[0] === 'register' && c[1] === 'tifSciviewer.openAsStack'));
  });

  test('the selection is sorted into slice order, whatever order it was clicked in', async () => {
    const { calls } = activate();
    const picked = files('slice_0010.tif', 'slice_0002.tif', 'slice_0001.tif');
    await calls.handlers['tifSciviewer.openAsStack'](picked[1], picked);

    const [command, uri, viewType] = calls.executed.at(-1);
    assert.equal(command, 'vscode.openWith');
    assert.equal(viewType, 'tifSciviewer.preview');
    assert.deepEqual(
      lib.sequenceFromQuery(uri.query).map(m => m.split('/').pop()),
      ['slice_0001.tif', 'slice_0002.tif', 'slice_0010.tif'],
    );
    assert.equal(uri.path, '/data/recon/slice_0001.tif', 'the tab is named after the first slice');
  });

  test('files that are not TIFFs are left out', async () => {
    const { calls } = activate();
    const picked = files('a.tif', 'notes.txt', 'b.TIFF', 'plot.png');
    await calls.handlers['tifSciviewer.openAsStack'](picked[0], picked);

    const [, uri] = calls.executed.at(-1);
    assert.deepEqual(
      lib.sequenceFromQuery(uri.query).map(m => m.split('/').pop()),
      ['a.tif', 'b.TIFF'],
    );
  });

  test('a single file opens as itself, not as a one-slice stack', async () => {
    const { calls } = activate();
    const [one] = files('only.tif');
    await calls.handlers['tifSciviewer.openAsStack'](one, [one]);

    const [command, uri] = calls.executed.at(-1);
    assert.equal(command, 'vscode.openWith');
    assert.equal(uri.query, '', 'no sequence query for a lone file');
  });

  test('a selection with no TIFFs in it says so instead of opening nothing', async () => {
    const { calls } = activate();
    const picked = files('notes.txt');
    await calls.handlers['tifSciviewer.openAsStack'](picked[0], picked);

    assert.equal(calls.executed.length, 0, 'nothing should be opened');
    assert.ok(calls.commands.some(c => c[0] === 'warn' && /Select the \.tif files/.test(c[1])));
  });

  test('the round trip survives spaces and other awkward characters in paths', async () => {
    const { calls } = activate();
    const picked = [
      makeUri({ path: '/data/my scan (1)/s_2.tif' }),
      makeUri({ path: '/data/my scan (1)/s_1.tif' }),
    ];
    await calls.handlers['tifSciviewer.openAsStack'](picked[0], picked);

    const [, uri] = calls.executed.at(-1);
    assert.deepEqual(lib.sequenceFromQuery(uri.query), [
      'file:///data/my scan (1)/s_1.tif',
      'file:///data/my scan (1)/s_2.tif',
    ]);
  });
});

describe('the Open as Stack menu entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('sits on the explorer context menu', () => {
    const entries = pkg.contributes.menus['explorer/context'] ?? [];
    assert.ok(entries.some(e => e.command === 'tifSciviewer.openAsStack'),
      'without this the feature cannot be reached by right-clicking');
  });

  test('is hidden from the command palette, where there is no selection', () => {
    const entries = pkg.contributes.menus.commandPalette ?? [];
    const entry = entries.find(e => e.command === 'tifSciviewer.openAsStack');
    assert.ok(entry && entry.when === 'false');
  });

  test('its when-clause really matches tif and nothing else', () => {
    const entry = pkg.contributes.menus['explorer/context']
      .find(e => e.command === 'tifSciviewer.openAsStack');
    // Pull the regex literal back out of the when-clause and run it, so an
    // over-escaped backslash cannot silently stop the item from ever showing.
    const m = /^resourceExtname =~ \/(.+)\/([a-z]*)$/.exec(entry.when);
    assert.ok(m, `when-clause is not a regex match: ${entry.when}`);
    const re = new RegExp(m[1], m[2]);
    for (const ext of ['.tif', '.tiff', '.TIF', '.TIFF']) {
      assert.ok(re.test(ext), `should match ${ext}`);
    }
    for (const ext of ['.txt', '.png', '.tifx', 'tif']) {
      assert.ok(!re.test(ext), `should not match ${ext}`);
    }
  });

  test('every menu entry points at a command that exists', () => {
    const declared = new Set(pkg.contributes.commands.map(c => c.command));
    for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
      for (const e of entries) {
        assert.ok(declared.has(e.command), `${menu} refers to unknown command ${e.command}`);
      }
    }
  });
});

/** A webview panel that records what was posted and can feed messages back. */
function fakePanel() {
  const posted = [];
  let handler = () => {};
  return {
    posted,
    send: (msg) => handler(msg),
    webview: {
      cspSource: 'vscode-webview://test',
      options: undefined,
      html: '',
      asWebviewUri: u => ({ toString: () => `https://webview/${String(u.path).split('/').pop()}` }),
      onDidReceiveMessage: (fn) => { handler = fn; return { dispose() {} }; },
      postMessage: async (m) => { posted.push(m); return true; },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

describe('a stack document, end to end through the extension host', () => {
  const COUNT = 6, W = 40, H = 24;
  let dir, paths;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tif-seq-host-'));
    paths = writeSequence(dir, { count: COUNT, width: W, height: H });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Drive the real command, then open whatever URI it produced. */
  async function openStack(files = paths, settings = {}) {
    const loaded = loadExtension(settings);
    loaded.ext.activate({ subscriptions: [], extensionUri: { scheme: 'file', path: ROOT } });
    const picked = files.map(p => makeUri({ path: p }));
    await loaded.calls.handlers['tifSciviewer.openAsStack'](picked[0], picked);
    const [, uri] = loaded.calls.executed.at(-1);
    const provider = loaded.calls.registered[0].provider;
    return { ...loaded, uri, provider };
  }

  test('the URI the command builds opens as one stack of all the files', async () => {
    const { provider, uri } = await openStack();
    const doc = await provider.openCustomDocument(uri);

    assert.equal(doc.pageCount, COUNT, 'every selected file is a slice');
    assert.equal(doc.sequence.count, COUNT);
    assert.deepEqual(doc.sequence.labels, paths.map(p => path.basename(p)));
    assert.equal(doc.stack.slices, COUNT);
    assert.equal(doc.stack.source, 'sequence');
    assert.ok(doc.fileSize > 0, 'file size is the whole stack');
    doc.dispose();
  });

  test('slices come back from the right file', async () => {
    const { provider, uri } = await openStack();
    const doc = await provider.openCustomDocument(uri);
    const probe = 17;

    for (let n = 0; n < COUNT; n++) {
      const payload = doc.slicePayload(n);
      assert.equal(payload.width, W);
      assert.equal(payload.height, H);
      const values = lib.viewOf(lib.payloadBytes(payload), 'float32', payload.littleEndian);
      assert.equal(values[probe], expectedValue(W, H, probe, n, COUNT), `slice ${n}`);
    }
    doc.dispose();
  });

  // Two files can share a name: a selection may span folders, and a member that
  // is itself multi-page gives all of its pages the same one. Saving a PNG of
  // each must not offer the same path twice and overwrite the first.
  test('slices that share a name get distinct PNG names', async () => {
    const twins = ['one', 'two'].map(sub =>
      writeSliceTif(path.join(dir, sub, 'img.tif'),
        { width: W, height: H, pixels: phantomSlice(W, H, 0.5) }));
    const { provider, uri, calls } = await openStack(twins);
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    panel.send({ type: 'ready' });

    for (const index of [0, 1]) {
      panel.send({ type: 'savePng', dataUrl: 'data:image/png;base64,aGk=', sliceIndex: index });
    }
    await new Promise(r => setImmediate(r));
    const offered = calls.saveDialogs.map(o => o.defaultUri.path);
    assert.equal(offered.length, 2);
    assert.notEqual(offered[0], offered[1], `both slices offered ${offered[0]}`);
    assert.match(offered[1], /img_z0001\.png$/);
    doc.dispose();
  });

  test('a name that picks out one slice is kept as it is', async () => {
    const { provider, uri, calls } = await openStack();
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    panel.send({ type: 'ready' });
    panel.send({ type: 'savePng', dataUrl: 'data:image/png;base64,aGk=', sliceIndex: 3 });
    await new Promise(r => setImmediate(r));
    assert.match(calls.saveDialogs[0].defaultUri.path, /slice_0004\.png$/);
    doc.dispose();
  });

  // Sampling decodes pages, so it should not run for settings that discard it.
  test('the stack is only sampled when the viewer will use the result', async () => {
    const initFor = async (settings) => {
      const { provider, uri } = await openStack(paths, settings);
      const doc = await provider.openCustomDocument(uri);
      const panel = fakePanel();
      await provider.resolveCustomEditor(doc, panel, {});
      panel.send({ type: 'ready' });
      const init = panel.posted.find(m => m.type === 'init');
      doc.dispose();
      return init;
    };
    assert.ok((await initFor({})).stackAuto, 'by default the stack is windowed as a whole');
    assert.equal((await initFor({ recomputeRangePerSlice: true })).stackAuto, undefined,
      'each slice windows itself, so the survey would be thrown away');
    assert.equal((await initFor({ autoContrastOnOpen: false })).stackAuto, undefined,
      'nothing is auto-windowed on open, so the survey would be thrown away');
  });

  // Its guard compares import.meta.url against argv[1]: a space percent-encodes
  // in the first and not the second, and macOS temp directories are symlinks,
  // which Node resolves in the first and not the second. Either mismatch used
  // to make the CLI exit 0 having written nothing - as the VS Code task and the
  // "Open as Stack" launch config would, on a workspace path with a space.
  test('the generator CLI runs from a path with a space or a symlink in it', () => {
    const where = fs.mkdtempSync(path.join(os.tmpdir(), 'tif cli-'));
    try {
      fs.mkdirSync(path.join(where, 'tools'));
      for (const f of ['make-sequence.mjs', 'phantom.mjs']) {
        fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(where, 'tools', f));
      }
      const out = path.join(where, 'out');
      const run = spawnSync(process.execPath, [path.join(where, 'tools', 'make-sequence.mjs'), out, '2'],
        { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.existsSync(out) ? fs.readdirSync(out).length : 0, 2,
        `wrote nothing; stdout was ${JSON.stringify(run.stdout)}`);
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  test('the viewer is told it is looking at a sequence', async () => {
    const { provider, uri } = await openStack();
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});

    panel.send({ type: 'ready' });
    const init = panel.posted.find(m => m.type === 'init');
    assert.ok(init, 'the viewer must be initialised');
    assert.equal(init.pageCount, COUNT);
    assert.equal(init.sequence.count, COUNT);
    assert.equal(init.sequence.labels[0], path.basename(paths[0]));
    assert.match(init.fileName, /\(6 files\)/, 'the title should say how many files');

    // The first slice is pushed without being asked for.
    assert.ok(panel.posted.some(m => m.type === 'slice' && m.index === 0));

    panel.send({ type: 'requestSlice', index: 4 });
    const slice = panel.posted.filter(m => m.type === 'slice').at(-1);
    assert.equal(slice.index, 4);
    doc.dispose();
  });

  test('slice requests choose their encoding and sampling, within bounds', async () => {
    // Pages of 8 MB, the smallest the host will send as previews.
    const BW = 2048, BH = 1024;
    const big = [0, 1].map(n => writeSliceTif(path.join(dir, 'big', `b_${n}.tif`), {
      width: BW, height: BH, pixels: Float32Array.from({ length: BW * BH }, (_, i) => (i % 977) + n),
    }));
    const { provider, uri } = await openStack(big, { autoContrastOnOpen: false });
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    panel.send({ type: 'ready' });
    const ask = msg => { panel.send({ type: 'requestSlice', ...msg }); return panel.posted.at(-1); };

    const plainSlice = ask({ index: 1 });
    assert.equal(plainSlice.pixels.constructor.name, 'Uint8Array', 'binary by default');
    assert.equal(plainSlice.base64, undefined);
    assert.equal(plainSlice.step, 1);

    const text = ask({ index: 1, encoding: 'base64' });
    assert.equal(text.pixels, undefined);
    assert.deepEqual(Buffer.from(lib.payloadBytes(text)), Buffer.from(plainSlice.pixels));

    const preview = ask({ index: 1, step: 4 });
    assert.equal(preview.step, 4);
    assert.equal(preview.width, BW, 'the slice keeps its own dimensions');
    assert.equal(preview.pixels.byteLength, (BW / 4) * (BH / 4) * 4);

    const crop = ask({ index: 1, region: { x: 4, y: 2, width: 10, height: 6 } });
    assert.deepEqual(crop.region, { x: 4, y: 2, width: 10, height: 6 });
    assert.equal(crop.pixels.byteLength, 10 * 6 * 4);
    assert.equal(ask({ index: 1, region: { x: 'a' } }).region, undefined, 'a nonsense region means all of it');

    assert.equal(ask({ index: 1, step: 'lots' }).step, 1, 'nonsense means every pixel');
    assert.equal(ask({ index: 1, step: -3 }).step, 1);
    assert.equal(ask({ index: 1, step: 1e9 }).step, 64, 'and there is a limit');
    doc.dispose();

    // A small page is sent whole whatever is asked, as a file can mix page sizes.
    const small = await openStack();
    const sdoc = await small.provider.openCustomDocument(small.uri);
    const spanel = fakePanel();
    await small.provider.resolveCustomEditor(sdoc, spanel, {});
    spanel.send({ type: 'ready' });
    spanel.send({ type: 'requestSlice', index: 2, step: 4, region: { x: 1, y: 1, width: 5, height: 5 } });
    const whole = spanel.posted.at(-1);
    assert.equal(whole.step, 1);
    assert.equal(whole.region, undefined);
    assert.equal(whole.pixels.byteLength, W * H * 4);
    sdoc.dispose();
  });

  test('a read-ahead hint decodes quietly, and the request after it is served', async () => {
    // No auto-contrast on open, so no survey decodes page 3 before the hint does.
    const { provider, uri } = await openStack(paths, { autoContrastOnOpen: false });
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    panel.send({ type: 'ready' });
    const before = panel.posted.length;
    panel.send({ type: 'prefetch', index: 3 });
    panel.send({ type: 'prefetch', index: 999 });
    assert.equal(panel.posted.length, before, 'a hint gets no reply, not even for a bad page');
    assert.equal(doc.prefetch(3), false, 'page 3 is already decoded');
    assert.equal(doc.prefetch(4), true, 'while a page nobody hinted at was not');
    panel.send({ type: 'requestSlice', index: 3 });
    assert.equal(panel.posted.at(-1).index, 3);
    doc.dispose();
  });

  test('a slice that cannot be served says which one it was', async () => {
    const { provider, uri } = await openStack();
    const doc = await provider.openCustomDocument(uri);
    const panel = fakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    panel.send({ type: 'ready' });
    panel.send({ type: 'requestSlice', index: COUNT + 3 });
    const err = panel.posted.at(-1);
    assert.equal(err.type, 'error');
    assert.equal(err.index, COUNT + 3, 'the viewer matches it to the request it has out');
    assert.equal(err.fatal, false);
    doc.dispose();
  });

  test('a plain single file is still opened the old way', async () => {
    const loaded = loadExtension();
    loaded.ext.activate({ subscriptions: [], extensionUri: { scheme: 'file', path: ROOT } });
    const provider = loaded.calls.registered[0].provider;
    const doc = await provider.openCustomDocument(makeUri({ path: paths[0] }));

    assert.equal(doc.pageCount, 1);
    assert.equal(doc.sequence, undefined, 'no sequence metadata for a lone file');
    doc.dispose();
  });

  test('a mismatched file is refused with a message naming it', async () => {
    const odd = writeSequence(path.join(dir, 'odd'), { count: 1, width: W + 8, height: H })[0];
    const { provider, uri } = await openStack([...paths, odd]);
    await assert.rejects(
      () => provider.openCustomDocument(uri),
      (e) => /slice_0001\.tif/.test(e.message) && /same shape/.test(e.message),
    );
  });
});
