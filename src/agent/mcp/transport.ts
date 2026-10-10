/** The two ways to reach an MCP server: a child process speaking
 * newline-delimited JSON-RPC on stdio, or an HTTP endpoint (streamable HTTP,
 * falling back to the older HTTP+SSE pairing when the server predates it).
 *
 * Both present the same small surface so the client above them never asks
 * which one it has. Written by hand rather than taken from
 * @modelcontextprotocol/sdk: `dependencies` is empty on purpose (see
 * package.json), the SDK brings a validator and an HTTP server framework this
 * client would never run, and the part of the protocol a tool-calling client
 * needs is three requests and two notifications.
 */
import { JsonRpcPeer } from '../../harness/transport/jsonrpc-peer.js';
import { spawnPortable } from '../../harness/transport/spawn.js';
import type { McpServerSpec } from './config.js';
import { McpSignInRequired, type McpAuth } from './oauth.js';

type Message = Record<string, any>;

interface RequestOptions { timeoutMs: number; signal?: AbortSignal }

export interface McpTransportHandlers {
  onNotification?(method: string, params: Message): void;
  /** Fired once, when the connection is gone for good (crash, EOF, 404 session). */
  onClose?(error: Error): void;
}

export interface McpTransport {
  request(method: string, params: Message, options: RequestOptions): Promise<Message>;
  notify(method: string, params?: Message): void;
  /** Sent on every HTTP request after initialize, as the spec requires. */
  setProtocolVersion(version: string): void;
  readonly closed: boolean;
  /** The server's own last words (stderr), for an error the user can act on. */
  detail(): string;
  close(): Promise<void>;
  /** Synchronous and unconditional, for `process.on('exit')`. */
  killNow(): void;
}

export class McpRequestError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = 'McpRequestError'; }
}

function cancelledError(): Error {
  return Object.assign(new Error('MCP request cancelled'), { name: 'AbortError' });
}

/** Races `start` against the caller's abort, and tells the server about an
 * abandoned request so it can stop the work instead of finishing it for
 * nobody. `start` reports the id its request went out under. */
function cancellable(
  transport: Pick<McpTransport, 'notify'>, options: RequestOptions,
  start: (onId: (id: number) => void) => Promise<Message>,
): Promise<Message> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let id: number | undefined;
    const onAbort = (): void => {
      if (id !== undefined) transport.notify('notifications/cancelled', { requestId: id, reason: 'cancelled by the user' });
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    start((value) => { id = value; }).then(resolve, (error: unknown) => {
      // A timed-out request is abandoned too; say so, as for an abort.
      if (id !== undefined && (error as { code?: unknown })?.code === 'ERR_JSONRPC_TIMEOUT') {
        transport.notify('notifications/cancelled', { requestId: id, reason: 'timed out' });
      }
      reject(error);
    }).finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

/** Servers a client cannot serve still get an answer, so they never block
 * waiting on one. `ping` is the only request a tools-only client can meet. */
function answerServerRequest(method: string): Promise<unknown> | undefined {
  return method === 'ping' ? Promise.resolve({}) : undefined;
}

// ── stdio ────────────────────────────────────────────────────────────────────

export function stdioTransport(
  spec: Extract<McpServerSpec, { transport: 'stdio' }>, handlers: McpTransportHandlers,
): McpTransport {
  // Detached on POSIX so a Ctrl-C at the terminal reaches ClikCode, which
  // decides what it means, rather than silently killing every server in the
  // foreground process group. Their own group also lets one signal take down
  // the grandchildren an `npx` launcher leaves behind.
  const detached = process.platform !== 'win32';
  const child = spawnPortable(spec.command, [...spec.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
    detached,
    windowsHide: true,
  });
  // A server idling between turns must not keep a finished headless run
  // alive. Every request carries a timer, which keeps the loop alive while
  // an answer is actually awaited.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
  const peer = new JsonRpcPeer(child, {
    label: `MCP server ${spec.name}`,
    detached,
    // The manager owns shutdown; forwarding SIGINT would kill servers on a
    // Ctrl-C that only meant "stop this turn".
    forwardParentSignals: false,
    onRequest: (method) => answerServerRequest(method),
    onNotification: (method, params) => handlers.onNotification?.(method, params),
    onClose: (error) => handlers.onClose?.(error),
  });
  const transport: McpTransport = {
    request: (method, params, options) => cancellable(transport, options,
      (onId) => peer.request(method, params, { timeoutMs: options.timeoutMs, onId })),
    notify: (method, params) => { peer.notify(method, params); },
    setProtocolVersion: () => undefined,
    get closed() { return peer.closed; },
    detail: () => peer.failureDetail(),
    close: () => peer.shutdown({ graceMs: 1000, killMs: 1000 }),
    killNow: () => peer.kill('SIGKILL'),
  };
  return transport;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface SseEvent { event: string; data: string }

/** Server-sent events from a fetch body. Blank-line framed; multi-line data
 * joined with newlines; comments and ids ignored, as nothing here resumes. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block: string): SseEvent | undefined => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
        const parsed = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (parsed) yield parsed;
      }
    }
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

interface HttpPending { method: string; resolve(value: Message): void; reject(error: Error): void; timer: NodeJS.Timeout }

type Fetch = typeof fetch;

export class HttpTransport implements McpTransport {
  private readonly pending = new Map<number, HttpPending>();
  /** Aborted on shutdown, so no request or open stream outlives the transport. */
  private readonly lifetime = new AbortController();
  private readonly streams = new Set<AbortController>([this.lifetime]);
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion?: string;
  /** Set once the legacy transport's GET stream has named where to POST. */
  private sseEndpoint?: string;
  private mode: 'streamable' | 'sse';
  private isClosed = false;
  private lastError = '';

  constructor(
    private readonly spec: Extract<McpServerSpec, { transport: 'http' | 'sse' }>,
    private readonly handlers: McpTransportHandlers,
    private readonly fetchImpl: Fetch = fetch,
    /** The server's OAuth credential (oauth.ts), when ClikCode holds one or
     * may: sent on every request, refreshed on a 401. */
    private readonly auth?: McpAuth,
  ) {
    this.mode = spec.transport === 'sse' ? 'sse' : 'streamable';
  }

  get closed(): boolean { return this.isClosed; }
  detail(): string { return this.lastError; }
  setProtocolVersion(version: string): void { this.protocolVersion = version; }

  request(method: string, params: Message, options: RequestOptions): Promise<Message> {
    return cancellable(this, options, (onId) => new Promise<Message>((resolve, reject) => {
      if (this.isClosed) return reject(new McpRequestError(`MCP server ${this.spec.name} is closed`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(Object.assign(new McpRequestError(`MCP server ${this.spec.name} ${method} timed out after ${Math.round(options.timeoutMs / 1000)}s`), { code: 'ERR_JSONRPC_TIMEOUT' }));
      }, options.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      onId(id);
      this.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => this.settle(id, undefined, error));
    }));
  }

  notify(method: string, params?: Message): void {
    if (this.isClosed) return;
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    const sessionId = this.mode === 'streamable' ? this.sessionId : undefined;
    this.shut(new Error(`MCP server ${this.spec.name} was shut down`));
    // Ending the session tells the server it may free what it holds for us.
    // Best effort: a server that ignores DELETE (405) is within the spec.
    if (sessionId) {
      const authorization = await this.auth?.authorization().catch(() => undefined);
      await this.fetchImpl(this.spec.url, {
        method: 'DELETE', headers: { ...this.spec.headers, 'mcp-session-id': sessionId, ...(authorization ? { authorization } : {}) }, signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
    }
  }

  killNow(): void { this.shut(new Error(`MCP server ${this.spec.name} was shut down`)); }

  private shut(error: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const controller of this.streams) controller.abort();
    this.streams.clear();
    for (const [id] of [...this.pending]) this.settle(id, undefined, error);
    this.handlers.onClose?.(error);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.spec.headers,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...extra,
    };
  }

  /** A request with the credential attached. A 401 gets one fresh token and
   * one retry; a server that still refuses, or whose credential is gone,
   * needs a sign-in -- reported, never started from here (oauth.ts). */
  private async authorizedFetch(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const authorization = await this.auth?.authorization();
      const response = await this.fetchImpl(url, { ...init, headers: { ...init.headers, ...(authorization ? { authorization } : {}) } });
      if (response.status !== 401 || !this.auth) return response;
      const verdict = await this.auth.unauthorized(response.headers.get('www-authenticate'), authorization, attempt > 0);
      if (verdict === 'fail') return response;
      await response.body?.cancel().catch(() => undefined);
      if (verdict === 'sign-in') throw new McpSignInRequired(this.spec.name);
    }
  }

  private async send(message: Message): Promise<void> {
    if (this.mode === 'sse') return this.sendLegacy(message);
    const response = await this.authorizedFetch(this.spec.url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(message),
      signal: this.lifetime.signal,
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim().slice(0, 500);
      // A server from before streamable HTTP answers the first POST with one
      // of these; the spec's compatibility rule is to try the old GET stream.
      if (message.method === 'initialize' && [400, 404, 405].includes(response.status) && this.spec.transport === 'http') {
        this.mode = 'sse';
        // Kept for the failure message: when the old transport fails too, the
        // server's own refusal of the new one is usually the real reason.
        this.streamableRefusal = `HTTP ${response.status}${text ? `: ${text}` : ''}`;
        return this.sendLegacy(message);
      }
      // A 404 for an established session means the server forgot it; the
      // connection is dead and the manager will start a fresh one.
      if (response.status === 404 && this.sessionId) this.shut(new McpRequestError(`MCP server ${this.spec.name} ended the session`));
      this.lastError = `HTTP ${response.status}${text ? `: ${text}` : ''}`;
      throw new McpRequestError(`MCP server ${this.spec.name} answered ${this.lastError}`);
    }
    if (response.status === 202 || !response.body) return;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      // Read in the background: the answer may be preceded by notifications,
      // and the request's promise settles when its own response arrives.
      void this.consumeStream(response.body, undefined);
      return;
    }
    const text = await response.text();
    if (!text.trim()) return;
    this.dispatchAll(JSON.parse(text));
  }

  private async sendLegacy(message: Message): Promise<void> {
    const endpoint = this.sseEndpoint ?? await this.openLegacyStream();
    const response = await this.authorizedFetch(endpoint, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(message),
      signal: this.lifetime.signal,
    });
    if (!response.ok) {
      this.lastError = `HTTP ${response.status}`;
      throw new McpRequestError(`MCP server ${this.spec.name} answered ${this.lastError}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  private legacyOpening?: Promise<string>;
  /** The streamable-HTTP answer that sent this connection to the legacy transport. */
  private streamableRefusal?: string;

  /** The old transport: one long GET whose first event says where to POST,
   * and every answer comes back down that same stream. */
  private openLegacyStream(): Promise<string> {
    this.legacyOpening ??= (async () => {
      const controller = new AbortController();
      this.streams.add(controller);
      const response = await this.authorizedFetch(this.spec.url, {
        method: 'GET', headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        this.lastError = this.streamableRefusal ? `${this.streamableRefusal} (and HTTP ${response.status} to the legacy event stream)` : `HTTP ${response.status}`;
        throw new McpRequestError(this.streamableRefusal
          ? `MCP server ${this.spec.name} answered ${this.lastError}`
          : `MCP server ${this.spec.name} did not open an event stream (${this.lastError})`);
      }
      return new Promise<string>((resolve, reject) => {
        void this.consumeStream(response.body!, (endpoint) => {
          this.sseEndpoint = new URL(endpoint, this.spec.url).toString();
          resolve(this.sseEndpoint);
        }).then(() => {
          reject(new McpRequestError(`MCP server ${this.spec.name} closed its event stream before naming an endpoint`));
          // The legacy stream IS the connection; when it ends, so do we.
          this.shut(new McpRequestError(`MCP server ${this.spec.name} closed its event stream`));
        });
      });
    })();
    return this.legacyOpening;
  }

  private async consumeStream(body: ReadableStream<Uint8Array>, onEndpoint: ((endpoint: string) => void) | undefined): Promise<void> {
    try {
      for await (const event of readSseEvents(body)) {
        if (event.event === 'endpoint') { onEndpoint?.(event.data.trim()); continue; }
        if (event.event !== 'message') continue;
        try { this.dispatchAll(JSON.parse(event.data)); } catch { /* one bad event must not end the stream */ }
      }
    } catch (error) {
      if (!this.isClosed) this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private dispatchAll(parsed: unknown): void {
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message && typeof message === 'object') this.dispatch(message as Message);
    }
  }

  private dispatch(message: Message): void {
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (!hasId) {
        try { this.handlers.onNotification?.(message.method, message.params ?? {}); } catch { /* a handler bug must not kill the transport */ }
        return;
      }
      const answered = answerServerRequest(message.method);
      if (answered) void answered.then((result) => this.send({ jsonrpc: '2.0', id: message.id, result }).catch(() => undefined));
      else void this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } }).catch(() => undefined);
      return;
    }
    if (hasId) this.settle(Number(message.id), message);
  }

  private settle(id: number, message: Message | undefined, failure?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (failure !== undefined) entry.reject(failure instanceof Error ? failure : new Error(String(failure)));
    else if (message?.error) {
      entry.reject(new McpRequestError(String(message.error.message ?? `${entry.method} failed`), typeof message.error.code === 'number' ? message.error.code : undefined));
    } else entry.resolve((message?.result as Message) ?? {});
  }
}

export function openTransport(spec: McpServerSpec, handlers: McpTransportHandlers, fetchImpl?: Fetch, auth?: McpAuth): McpTransport {
  return spec.transport === 'stdio' ? stdioTransport(spec, handlers) : new HttpTransport(spec, handlers, fetchImpl, auth);
}
