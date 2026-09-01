import * as vscode from 'vscode';
import { TiffEditorProvider } from './tiffEditorProvider';

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
  );
}

export function deactivate() { /* nothing to tear down */ }
