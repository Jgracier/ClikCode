/** The webview's line to the extension: posting, requests answered by a
 * `response`, and what is kept across a reload of the page. */
import type { FromWebview, ToWebview, WebviewRequest } from '../webview-protocol';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void; getState(): unknown; setState(state: unknown): void };

// Outside a webview (unit tests) there is no host to talk to.
const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

export const post = (message: FromWebview): void => vscode.postMessage(message);

let counter = 0;
export function uid(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();

/** A request to the extension (and through it, ClikCode). */
export function request<T>(body: WebviewRequest): Promise<T> {
  const id = uid();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (data) => resolve(data as T), reject });
    post({ type: 'request', id, request: body });
  });
}

type Listener = (message: ToWebview) => void;
const listeners = new Set<Listener>();

export function listen(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'response') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.data);
    else waiting.reject(new Error(message.error ?? 'failed'));
    return;
  }
  for (const listener of [...listeners]) listener(message);
});

export interface Saved { draft?: string; sessionId?: string }

export function saved(): Saved {
  return (vscode.getState() as Saved | undefined) ?? {};
}

export function save(patch: Partial<Saved>): void {
  vscode.setState({ ...saved(), ...patch });
}

export function command(name: string, ...args: unknown[]): void {
  post({ type: 'command', command: name, ...(args.length ? { args } : {}) });
}
