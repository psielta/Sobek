import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** Entry name under dist/webview, e.g. "board" -> dist/webview/board.js */
  entry: string;
  title: string;
  /** Serialized JSON injected as window.__SOBEK_STATE__ before the bundle loads. */
  initialState?: unknown;
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { webview, extensionUri, entry, title } = options;
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.js`)
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.css`)
  );
  const state = JSON.stringify(options.initialState ?? null).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__SOBEK_STATE__ = ${state};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
