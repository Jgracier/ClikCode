/** Where the chat is drawn: webviews, each one a ClikCode chat.
 *
 * The side bar chat lives in the secondary side bar (the right-hand one), as
 * Claude Code's and Codex's do, or in an activity bar container of its own on
 * a VS Code too old to take a secondary side bar contribution; both views are
 * the same chat. Every editor tab is a chat of its own, with its own
 * conversation, so any number can be open side by side.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ChatModel } from './model';
import type { FromWebview, ToWebview } from './webview-protocol';
export { supportsSecondarySidebar } from './compat';

export const VIEW_IDS = { secondary: 'clikcode.chatSecondary', activity: 'clikcode.chat' } as const;
export const PANEL_TYPE = 'clikcode.chatEditor';

/** One webview showing a chat. Messages posted before the page says it is
 * ready wait for it. */
export class WebviewSurface implements vscode.Disposable {
  ready = false;
  focused = false;
  lastFocusedAt = 0;
  /** The model this page was last sent (see ClikCodeController.postModel). */
  sentModel: ChatModel | undefined;
  private readonly outbox: ToWebview[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly probes = new Map<string, (result: unknown) => void>();

  constructor(
    readonly webview: vscode.Webview,
    readonly kind: 'sidebar' | 'tab',
    private readonly isVisible: () => boolean,
    extensionUri: vscode.Uri,
    onMessage: (surface: WebviewSurface, message: FromWebview) => void,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    };
    webview.html = chatHtml(webview, extensionUri, kind);
    this.disposables.push(webview.onDidReceiveMessage((message: FromWebview) => {
      if (message.type === 'ready') {
        this.ready = true;
        for (const queued of this.outbox.splice(0)) void webview.postMessage(queued);
      }
      if (message.type === 'focusChanged') {
        this.focused = message.focused;
        if (message.focused) this.lastFocusedAt = Date.now();
      }
      if (message.type === 'probeResult') {
        this.probes.get(message.id)?.(message.result);
        this.probes.delete(message.id);
        return;
      }
      onMessage(this, message);
    }));
  }

  get visible(): boolean {
    return this.isVisible();
  }

  post(message: ToWebview): void {
    if (this.ready) void this.webview.postMessage(message);
    else if (message.type !== 'model' && message.type !== 'patch') this.outbox.push(message);
  }

  /** Integration tests: read or drive the page. */
  probe(action: 'query' | 'click' | 'type' | 'key', selector: string, text?: string): Promise<unknown> {
    const id = randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.probes.delete(id); reject(new Error(`probe ${action} ${selector} timed out`)); }, 30_000);
      this.probes.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.post({ type: 'probe', id, action, selector, ...(text !== undefined ? { text } : {}) });
    });
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
  }
}

function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, kind: 'sidebar' | 'tab'): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path));
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
<link rel="stylesheet" href="${asset('dist', 'codicon.css')}">
<link rel="stylesheet" href="${asset('dist', 'webview.css')}">
<title>ClikCode</title>
</head>
<body data-surface="${kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
}
