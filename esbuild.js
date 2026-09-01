const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const common = { bundle: true, minify: !watch, sourcemap: watch, logLevel: 'info' };

async function main() {
  const ctxExt = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  });
  const ctxWeb = await esbuild.context({
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'media/viewer.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  });
  const ctxLib = await esbuild.context({
    ...common,
    minify: false,
    entryPoints: ['src/lib.ts'],
    outfile: 'dist/lib.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  });
  if (watch) { await ctxExt.watch(); await ctxWeb.watch(); await ctxLib.watch(); }
  else {
    await ctxExt.rebuild(); await ctxWeb.rebuild(); await ctxLib.rebuild();
    await ctxExt.dispose(); await ctxWeb.dispose(); await ctxLib.dispose();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
