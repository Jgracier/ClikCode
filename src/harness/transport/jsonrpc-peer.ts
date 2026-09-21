/** One newline-delimited JSON-RPC peer over a child process. ACP and the Codex
 * app-server both speak this framing; keeping the lifecycle here means pending
 * requests, EPIPE, partial lines and process-tree shutdown are solved once
 * instead of drifting apart in two hand-rolled copies. */
import type { ChildProcess } from 'node:child_process';
import { killProcessTreePortable } from './spawn.js';

export type JsonRpcMessage = Record<string, any>;

export const JSONRPC_SETUP_TIMEOUT_MS = 20_000;
const NOISE_LIMIT = 8000;
/** `exit` can precede `close` indefinitely when a grandchild inherited the
 * pipes. Output completeness matters, so `close` is preferred, but callers
 * must never hang on a process that is already gone. */
const CLOSE_AFTER_EXIT_MS = 500;

export interface JsonRpcRequestOptions {
  /** No timeout when omitted: a prompt request legitimately runs for hours. */
  timeoutMs?: number;
  /** Treat the timeout as an idle window: any inbound message restarts it.
   * Used for history-replaying setup calls that stream while they work. */
  idleReset?: boolean;
}

export interface JsonRpcPeerOptions {
  /** Human label used in error messages, e.g. `copilot ACP`. */
  label: string;
  /** ACP requires the `jsonrpc: "2.0"` member; Codex app-server omits it. */
  jsonrpcVersion?: boolean;
  /** True when the child was spawned `detached` on POSIX, so signals should
   * target its process group and take grandchildren down with it. */
  detached?: boolean;
  /** Forward parent SIGINT/SIGTERM/SIGHUP to the child tree. Default true. */
  forwardParentSignals?: boolean;
  /** Server-initiated request. Return a promise of the JSON-RPC `result`, or
   * `undefined` (synchronously) for an unknown method, answered with -32601. */
  onRequest?: (method: string, params: JsonRpcMessage, id: number | string) => Promise<unknown> | undefined;
  onNotification?: (method: string, params: JsonRpcMessage) => void;
  /** Fired exactly once, after every pending request has been rejected. */
  onClose?: (error: Error) => void;
}

export interface JsonRpcShutdownOptions {
  /** Protocol-level cancel (e.g. `turn/interrupt`) attempted before signals. */
  cancel?: () => Promise<unknown> | void;
  /** Budget for cancel + stdin EOF to produce an exit before SIGTERM. */
  graceMs?: number;
  /** Delay between SIGTERM and SIGKILL. */
  killMs?: number;
}

export class JsonRpcError extends Error {
  constructor(message: string, readonly rpcCode?: number, readonly data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

interface Pending {
  method: string;
  resolve: (value: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  idleReset: boolean;
}

export class JsonRpcPeer {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private lineBuffer = '';
  private stderrTail = '';
  private stdoutNoise = '';
  private isClosed = false;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private closeFallback?: NodeJS.Timeout;
  private shutdownPromise?: Promise<void>;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly signalCleanup: Array<() => void> = [];

  constructor(private readonly child: ChildProcess, private readonly options: JsonRpcPeerOptions) {
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => this.receive(String(chunk)));
    child.stderr?.on('data', (chunk: string | Buffer) => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-NOISE_LIMIT); });
    // A child that exits mid-write raises EPIPE asynchronously on the stream.
    // Without a listener that is an uncaught exception that kills ClikCode.
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.once('error', (error) => { this.markExited(null, null); this.handleClose(error instanceof Error ? error : new Error(String(error))); });
    child.once('exit', (code, signal) => {
      this.markExited(code, signal);
      if (this.isClosed) return;
      this.closeFallback = setTimeout(() => this.handleClose(), CLOSE_AFTER_EXIT_MS);
    });
    child.once('close', (code, signal) => { this.markExited(code, signal); this.handleClose(); });
    if (options.forwardParentSignals !== false) this.installSignalForwarding();
  }

  get closed(): boolean { return this.isClosed; }
  get pendingCount(): number { return this.pending.size; }

  /** Best available explanation for a dead child: stderr, then stray stdout. */
  failureDetail(): string {
    return this.stderrTail.trim() || this.stdoutNoise.trim();
  }

  /** Fire-and-forget write. A no-op once the peer is closed or stdin is gone. */
  send(message: JsonRpcMessage): boolean {
    const stdin = this.child.stdin;
    if (this.isClosed || this.exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
    const framed = this.options.jsonrpcVersion === false ? message : { jsonrpc: '2.0', ...message };
    try {
      stdin.write(`${JSON.stringify(framed)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  notify(method: string, params?: JsonRpcMessage): boolean {
    return this.send(params === undefined ? { method } : { method, params });
  }

  request(method: string, params: JsonRpcMessage, options: JsonRpcRequestOptions = {}): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      if (this.isClosed || this.exited) return reject(this.closedError());
      const id = this.nextId++;
      const entry: Pending = { method, resolve, reject, idleReset: options.idleReset === true };
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(Object.assign(new JsonRpcError(`${this.options.label} ${method} timed out after ${Math.round(options.timeoutMs! / 1000)}s`), { code: 'ERR_JSONRPC_TIMEOUT' }));
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      if (!this.send({ id, method, params })) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(this.closedError());
      }
    });
  }

  /** Reject in-flight requests without closing the peer. Turn-scoped calls
   * such as `turn/steer` must settle when their turn ends, even though the
   * server may never answer them. */
  rejectPending(error: Error, filter?: (method: string) => boolean): void {
    for (const [id, entry] of [...this.pending]) {
      if (filter && !filter(entry.method)) continue;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** Resolves once the child has exited (immediately if it already has). */
  waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => { this.exitWaiters.push(resolve); });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exited) return;
    killProcessTreePortable(this.child, signal, this.options.detached === true);
  }

  /** cancel -> stdin EOF -> (graceMs) SIGTERM -> (killMs) SIGKILL. Idempotent;
   * resolves when the child is gone or SIGKILL has been delivered. */
  shutdown(options: JsonRpcShutdownOptions = {}): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(options);
    return this.shutdownPromise;
  }

  private async runShutdown(options: JsonRpcShutdownOptions): Promise<void> {
    if (this.exited) return;
    const graceMs = options.graceMs ?? 2000;
    const killMs = options.killMs ?? 3000;
    const exit = this.waitForExit();
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'timeout'>((resolve) => { graceTimer = setTimeout(() => resolve('timeout'), graceMs); });
    try {
      let timedOut = false;
      if (options.cancel) {
        const cancelled = Promise.resolve().then(() => options.cancel!()).then(() => undefined, () => undefined);
        timedOut = await Promise.race([cancelled, exit, grace]) === 'timeout';
      }
      if (this.exited) return;
      // Stdio servers treat EOF as the polite request to leave.
      try { this.child.stdin?.end(); } catch { /* already gone */ }
      if (!timedOut) await Promise.race([exit, grace]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
    if (this.exited) return;
    this.kill('SIGTERM');
    let killTimer: NodeJS.Timeout | undefined;
    const escalate = new Promise<void>((resolve) => { killTimer = setTimeout(resolve, killMs); });
    await Promise.race([exit, escalate]);
    if (killTimer) clearTimeout(killTimer);
    if (!this.exited) this.kill('SIGKILL');
  }

  private closedError(): Error {
    const detail = this.failureDetail();
    const status = this.exitSignal ? `stopped (${this.exitSignal})` : this.exited ? `exited ${this.exitCode ?? 1}` : 'closed';
    return Object.assign(new JsonRpcError(detail || `${this.options.label} ${status}`), { code: 'ERR_JSONRPC_CLOSED' });
  }

  private markExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    for (const cleanup of this.signalCleanup.splice(0)) cleanup();
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }

  private handleClose(cause?: Error): void {
    if (this.isClosed) return;
    if (this.closeFallback) clearTimeout(this.closeFallback);
    // A final response may sit in the buffer without a trailing newline.
    const tail = this.lineBuffer;
    this.lineBuffer = '';
    if (tail.trim()) this.handleLine(tail);
    const error = cause ?? this.closedError();
    this.isClosed = true;
    this.rejectPending(error);
    this.options.onClose?.(error);
  }

  private receive(chunk: string): void {
    if (this.isClosed) return;
    const lines = (this.lineBuffer + chunk).split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a message');
      message = parsed as JsonRpcMessage;
    } catch {
      this.stdoutNoise = `${this.stdoutNoise}${line}\n`.slice(-NOISE_LIMIT);
      return;
    }
    for (const entry of this.pending.values()) if (entry.idleReset) entry.timer?.refresh();
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) this.handleServerRequest(message.method, message.params ?? {}, message.id);
      else {
        try { this.options.onNotification?.(message.method, message.params ?? {}); } catch { /* a renderer bug must not kill the transport */ }
      }
      return;
    }
    if (!hasId) return;
    const entry = this.pending.get(Number(message.id));
    if (!entry) return;
    this.pending.delete(Number(message.id));
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) {
      const detail = message.error as JsonRpcMessage;
      entry.reject(new JsonRpcError(String(detail.message ?? `${entry.method} failed`), typeof detail.code === 'number' ? detail.code : undefined, detail.data));
    } else entry.resolve((message.result as JsonRpcMessage) ?? {});
  }

  private handleServerRequest(method: string, params: JsonRpcMessage, id: number | string): void {
    let handled: Promise<unknown> | undefined;
    try {
      handled = this.options.onRequest?.(method, params, id);
    } catch (error) {
      handled = Promise.reject(error);
    }
    if (!handled) {
      // Never leave the server blocked on a request this client cannot serve.
      this.send({ id, error: { code: -32601, message: `Unsupported client method: ${method}` } });
      return;
    }
    handled.then(
      (result) => { this.send({ id, result: result ?? {} }); },
      (error) => { this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); },
    );
  }

  private installSignalForwarding(): void {
    const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) {
      const forward = (): void => this.kill(signal);
      process.once(signal, forward);
      this.signalCleanup.push(() => process.off(signal, forward));
    }
    // A detached child is outside the terminal's process group, so nothing
    // else reaps it if ClikCode exits while a persistent session is parked.
    const onExit = (): void => this.kill('SIGKILL');
    process.once('exit', onExit);
    this.signalCleanup.push(() => process.off('exit', onExit));
  }
}
