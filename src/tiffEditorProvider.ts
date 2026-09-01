import * as vscode from 'vscode';
import { TiffDocument } from './tiffDocument';
import { COMPRESSION_NAMES } from './tiff/types';
import { pageHtml } from './webviewHtml';

export class TiffEditorProvider implements vscode.CustomReadonlyEditorProvider<TiffDocument> {
  public static readonly viewType = 'tifSciviewer.preview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TiffEditorProvider.viewType,
      new TiffEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<TiffDocument> {
    return TiffDocument.create(uri);
  }

  async resolveCustomEditor(
    document: TiffDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    panel.webview.html = this.html(panel.webview);

    // postMessage resolves false once the panel is gone; that is not an error.
    const post = (msg: unknown) => { void panel.webview.postMessage(msg); };

    const sendSlice = (index: number) => {
      try {
        post(document.slicePayload(index));
      } catch (e) {
        post({ type: 'error', message: describe(e), fatal: index === 0 });
      }
    };

    const sub = panel.webview.onDidReceiveMessage((msg: { type: string; [k: string]: unknown }) => {
      switch (msg.type) {
        case 'ready': {
          const cfg = vscode.workspace.getConfiguration('tifSciviewer');
          try {
            post({
              type: 'init',
              fileName: document.uri.path.split('/').pop() ?? 'image.tif',
              fileSize: document.fileSize,
              pageCount: document.pageCount,
              meta: describeMeta(document),
              stack: document.stack,
              config: {
                autoContrastOnOpen: cfg.get('autoContrastOnOpen', true),
                defaultLut: cfg.get('defaultLut', 'Grays'),
                recomputeRangePerSlice: cfg.get('recomputeRangePerSlice', false),
                saturatedPercent: cfg.get('saturatedPercent', 0.35),
              },
            });
            sendSlice(0);
          } catch (e) {
            post({ type: 'error', message: describe(e), fatal: true });
          }
          break;
        }
        case 'requestSlice':
          sendSlice(Number(msg.index) || 0);
          break;
        case 'copy':
          void vscode.env.clipboard.writeText(String(msg.text ?? ''));
          void vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
          break;
        case 'notify':
          void vscode.window.showInformationMessage(String(msg.message ?? ''));
          break;
        case 'reportError':
          void vscode.window.showErrorMessage(`TIFF viewer: ${String(msg.message ?? '')}`);
          break;
        case 'savePng':
          void savePng(document.uri, String(msg.dataUrl ?? ''), Number(msg.sliceIndex) || 0);
          break;
      }
    });

    panel.onDidDispose(() => sub.dispose());
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f)).toString();
    return pageHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      cssUri: media('viewer.css'),
      jsUri: media('viewer.js'),
    });
  }
}

/**
 * The webview sandbox blocks downloads, so the export round-trips through the
 * host, which owns the save dialog and the filesystem.
 */
async function savePng(sourceUri: vscode.Uri, dataUrl: string, sliceIndex: number): Promise<void> {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
    void vscode.window.showErrorMessage('TIFF viewer: the rendered image could not be read.');
    return;
  }
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');

  const base = (sourceUri.path.split('/').pop() ?? 'image.tif').replace(/\.tiff?$/i, '');
  const suffix = sliceIndex > 0 ? `_z${String(sliceIndex).padStart(4, '0')}` : '';
  const target = await vscode.window.showSaveDialog({
    defaultUri: sourceUri.with({ path: sourceUri.path.replace(/[^/]+$/, `${base}${suffix}.png`) }),
    filters: { 'PNG image': ['png'] },
    title: 'Save the current view as PNG',
  });
  if (!target) return;

  try {
    await vscode.workspace.fs.writeFile(target, bytes);
    void vscode.window.showInformationMessage(`Saved ${target.path.split('/').pop()}`);
  } catch (e) {
    void vscode.window.showErrorMessage(`TIFF viewer: could not save the PNG - ${describe(e)}`);
  }
}

function describeMeta(doc: TiffDocument) {
  const m = doc.meta;
  return {
    width: m.width,
    height: m.height,
    dtype: m.dtype,
    bitsPerSample: m.bitsPerSample[0],
    samplesPerPixel: m.samplesPerPixel,
    compression: COMPRESSION_NAMES[m.compression] ?? String(m.compression),
    photometric: m.photometric,
    planarConfig: m.planarConfig,
    tiled: m.tileWidth !== undefined,
    software: m.software,
    description: m.description,
    resolution: m.resolution,
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
