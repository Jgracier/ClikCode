/** The chat: a webview view in the ClikCode activity bar container (movable
 * to the secondary side bar like any view), and optionally an editor tab
 * opened from the editor title bar. Every open surface shows the same chat. */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ChatModel } from './model';
import type { FromWebview, ToWebview } from './webview-protocol';

const POST_INTERVAL_MS = 40;

interface Surface {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  ready: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'clikcode.chat';
  static readonly panelType = 'clikcode.chatEditor';
  private view: (Surface & { host: vscode.WebviewView }) | undefined;
  private panel: (Surface & { host: vscode.WebviewPanel }) | undefined;
  private latest: ChatModel | undefined;
  private postTimer: NodeJS.Timeout | undefined;
  private readonly outbox: ToWebview[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: FromWebview) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const surface = { host: view, webview: view.webview, get visible() { return view.visible; }, ready: false };
    this.view = surface;
    this.attach(surface);
    view.onDidDispose(() => { if (this.view === surface) this.view = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible && this.latest) this.update(this.latest); });
  }

  /** The chat as an editor tab beside the active editor, as Claude Code and
   * Codex open theirs; a second click brings the existing tab forward. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.host.reveal(this.panel.host.viewColumn ?? vscode.ViewColumn.Beside);
      return;
    }
    this.restorePanel(vscode.window.createWebviewPanel(ChatViewProvider.panelType, 'ClikCode', vscode.ViewColumn.Beside, { retainContextWhenHidden: true }));
  }

  /** Also the serializer's entry point: a tab left open reopens with VS Code. */
  restorePanel(panel: vscode.WebviewPanel): void {
    this.panel?.host.dispose();
    panel.iconPath = { light: vscode.Uri.joinPath(this.extensionUri, 'media', 'editor-light.svg'), dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'editor-dark.svg') };
    const surface = { host: panel, webview: panel.webview, get visible() { return panel.visible; }, ready: false };
    this.panel = surface;
    this.attach(surface);
    panel.onDidDispose(() => { if (this.panel === surface) this.panel = undefined; });
    panel.onDidChangeViewState(() => { if (panel.visible && this.latest) this.update(this.latest); });
  }

  private attach(surface: Surface): void {
    surface.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    surface.webview.html = this.html(surface.webview);
    surface.webview.onDidReceiveMessage((message: FromWebview) => {
      if (message.type === 'ready') {
        surface.ready = true;
        if (this.latest) void surface.webview.postMessage({ type: 'model', model: this.latest } satisfies ToWebview);
        for (const queued of this.outbox.splice(0)) void surface.webview.postMessage(queued);
      }
      this.onMessage(message);
    });
  }

  private surfaces(): Surface[] {
    return [this.panel, this.view].filter((surface): surface is NonNullable<typeof surface> => Boolean(surface));
  }

  get visible(): boolean {
    return this.surfaces().some((surface) => surface.visible);
  }

  /** Coalesced: a stream of deltas repaints at most every 40 ms. */
  update(model: ChatModel): void {
    this.latest = model;
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      const model = this.latest;
      if (!model) return;
      for (const surface of this.surfaces()) if (surface.ready) void surface.webview.postMessage({ type: 'model', model } satisfies ToWebview);
    }, POST_INTERVAL_MS);
  }

  /** One-off messages (focus, a draft) go to the surface in front: the
   * editor tab when it is open, else the side bar view. */
  post(message: ToWebview): void {
    const target = this.panel ?? this.view;
    if (target?.ready) void target.webview.postMessage(message);
    else this.outbox.push(message);
  }

  async reveal(): Promise<void> {
    if (this.panel) {
      this.panel.host.reveal(this.panel.host.viewColumn, false);
      return;
    }
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
