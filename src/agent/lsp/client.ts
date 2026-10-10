/** The LSP base protocol over a child's stdio: `Content-Length` framed
 * JSON-RPC 2.0, requests matched to responses by id, notifications handed to
 * listeners, and the few server-to-client requests a server blocks on
 * answered with neutral defaults. */
import type { ChildProcess } from 'node:child_process';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One message as the wire carries it. The length counts bytes, not characters. */
export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Splits a byte stream into messages: chunks may cut a header, a body or a
 * multi-byte character anywhere. A header block without a length is skipped. */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return out;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(header);
      if (!length) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const start = headerEnd + 4;
      const end = start + Number(length[1]);
      if (this.buffer.length < end) return out;
      const body = this.buffer.subarray(start, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      try { out.push(JSON.parse(body) as JsonRpcMessage); } catch { /* fail-open-ok: a garbled message is dropped, the stream goes on */ }
    }
  }
}

export class LspRequestError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** A JSON-RPC peer on a spawned server. `closed` once the process is gone;
 * every request still waiting then fails with what the server last printed. */
export class LspConnection {
  private readonly decoder = new MessageDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private nextId = 1;
  private stderrTail = '';
  closed = false;
  exitReason?: string;

  constructor(private readonly child: ChildProcess, private readonly name: string, private readonly workspaceFolders: unknown = null) {
    child.stdout!.on('data', (chunk: Buffer) => { for (const message of this.decoder.push(chunk)) this.dispatch(message); });
    child.stderr?.on('data', (chunk: Buffer) => { this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-1000); });
    child.stdin!.on('error', () => undefined);
    child.once('error', (error) => this.close(error.message));
    child.once('exit', (code, signal) => this.close(signal ? `exited (${signal})` : `exited with code ${code}`));
  }

  /** The last thing the server wrote to stderr, one line. */
  get lastError(): string {
    return this.stderrTail.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300) ?? '';
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new LspRequestError(this.closedMessage()));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        settle();
        this.notify('$/cancelRequest', { id });
        reject(new LspRequestError('cancelled'));
      };
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        settle();
        this.notify('$/cancelRequest', { id });
        reject(new LspRequestError(`${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { settle(); resolve(value as T); },
        reject: (error) => { settle(); reject(error); },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: JsonRpcMessage): void {
    try { this.child.stdin!.write(encodeMessage(message)); } catch { /* fail-open-ok: the exit handler reports a dead server */ }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined && message.id !== null) {
      this.write({ jsonrpc: '2.0', id: message.id, ...serverRequestAnswer(message.method, message.params, this.workspaceFolders) });
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) {
        try { listener(message.method, message.params); } catch { /* a listener fault must not stop the stream */ }
      }
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (message.error) pending.reject(new LspRequestError(message.error.message, message.error.code));
    else pending.resolve(message.result ?? null);
  }

  private closedMessage(): string {
    const detail = this.lastError;
    return `${this.name} ${this.exitReason ?? 'is not running'}${detail ? `: ${detail}` : ''}`;
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = reason;
    const error = new LspRequestError(this.closedMessage());
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
  }
}

/** What a server asks of its client while it works. Configuration gets
 * "nothing set" for each item; progress tokens and capability registrations
 * are accepted; anything else is declined rather than left hanging. */
function serverRequestAnswer(method: string, params: unknown, workspaceFolders: unknown): Pick<JsonRpcMessage, 'result' | 'error'> {
  switch (method) {
    case 'workspace/configuration': {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      return { result: Array.isArray(items) ? items.map(() => null) : [] };
    }
    case 'window/workDoneProgress/create':
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/showMessageRequest':
    case 'workspace/diagnostic/refresh':
    case 'workspace/semanticTokens/refresh':
    case 'workspace/inlayHint/refresh':
    case 'workspace/codeLens/refresh':
      return { result: null };
    case 'workspace/workspaceFolders':
      return { result: workspaceFolders };
    default:
      return { error: { code: -32601, message: `Unhandled method ${method}` } };
  }
}
