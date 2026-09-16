import * as vscode from 'vscode';
import { TiffEditorProvider } from './tiffEditorProvider';
import { sortSequence, sequenceQuery } from './sequence';

const IS_TIFF = /\.tiff?$/i;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(TiffEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('tifSciviewer.openWith', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage('Open a .tif file first, or run this from its context menu.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, TiffEditorProvider.viewType);
    }),

    /**
     * ImageJ's File > Import > Image Sequence, driven from the Explorer
     * selection. VS Code passes the clicked item first and the whole selection
     * second; the selection is what matters here.
     */
    vscode.commands.registerCommand(
      'tifSciviewer.openAsStack',
      async (clicked?: vscode.Uri, selection?: vscode.Uri[]) => {
        const picked = (selection?.length ? selection : clicked ? [clicked] : [])
          .filter(u => IS_TIFF.test(u.path));

        if (picked.length === 0) {
          void vscode.window.showWarningMessage(
            'Select the .tif files you want stacked in the Explorer, then run this from their context menu.',
          );
          return;
        }
        if (picked.length === 1) {
          await vscode.commands.executeCommand('vscode.openWith', picked[0], TiffEditorProvider.viewType);
          return;
        }

        const ordered = sortSequence(picked.map(u => u.toString()));
        const target = vscode.Uri.parse(ordered[0], true).with({ query: sequenceQuery(ordered) });
        await vscode.commands.executeCommand('vscode.openWith', target, TiffEditorProvider.viewType);
      },
    ),
  );
}

export function deactivate() { /* nothing to tear down */ }
