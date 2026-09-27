/** The chat panel: a webview view in the ClikCode activity bar container
 * (movable to the secondary side bar like any view). */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ChatModel } from './model';
import type { FromWebview, ToWebview } from './webview-protocol';

const POST_INTERVAL_MS = 40;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'clikcode.chat';
  private view: vscode.WebviewView | undefined;
  private latest: ChatModel | undefined;
  private postTimer: NodeJS.Timeout | undefined;
  private readonly outbox: ToWebview[] = [];
  private ready = false;

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: FromWebview) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: FromWebview) => {
      if (message.type === 'ready') {
        this.ready = true;
        if (this.latest) void view.webview.postMessage({ type: 'model', model: this.latest } satisfies ToWebview);
        for (const queued of this.outbox.splice(0)) void view.webview.postMessage(queued);
      }
      this.onMessage(message);
    });
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.ready = false; } });
    view.onDidChangeVisibility(() => { if (view.visible && this.latest) this.update(this.latest); });
  }

  get visible(): boolean {
    return Boolean(this.view?.visible);
  }

  /** Coalesced: a stream of deltas repaints at most every 40 ms. */
  update(model: ChatModel): void {
    this.latest = model;
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      if (this.view && this.ready && this.latest) void this.view.webview.postMessage({ type: 'model', model: this.latest } satisfies ToWebview);
    }, POST_INTERVAL_MS);
  }

  post(message: ToWebview): void {
    if (this.view && this.ready) void this.view.webview.postMessage(message);
    else this.outbox.push(message);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>ClikCode</title>
</head>
<body>
<header id="header"></header>
<div id="banner" hidden></div>
<main id="log"><div id="transcript"></div><div id="live"></div></main>
<section id="approvals"></section>
<section id="queued"></section>
<footer>
  <div id="status" class="muted"></div>
  <div class="composer">
    <textarea id="input" rows="1" aria-label="Message"></textarea>
    <div class="composer-actions">
      <button id="stop" class="secondary" title="Stop (Esc)" hidden>Stop</button>
      <button id="send" title="Send (Enter)">Send</button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
