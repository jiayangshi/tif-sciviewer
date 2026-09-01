import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * Load the built extension against a stub `vscode`, so activation, editor
 * registration and the message handler are exercised without a running VS Code.
 */
function loadExtension() {
  const calls = { registered: [], commands: [], disposables: [] };
  const stub = {
    Uri: {
      joinPath: (base, ...parts) => ({ ...base, path: [base.path, ...parts].join('/'), toString: () => [base.path, ...parts].join('/') }),
      file: p => ({ scheme: 'file', path: p, fsPath: p, with(o) { return { ...this, ...o }; }, toString: () => p }),
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
      showSaveDialog: async () => undefined,
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: (id, fn) => { calls.commands.push(['register', id]); return { dispose() {} }; },
      executeCommand: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (_k, d) => d }),
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
