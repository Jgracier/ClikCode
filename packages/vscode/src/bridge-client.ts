/** The extension's end of `clikcode ide-bridge`: one child process, an IPC
 * channel for the protocol, stdout/stderr for the log. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IdeEvent, IdeRequest } from './protocol';
import { entryBuild, type Runtime } from './runtime';

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void };
type WithoutRequestId<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

export interface BridgeClientEvents {
  event: [IdeEvent];
  log: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
}

/** Anything that looks like a protocol message. Unknown `type`s pass through
 * and are ignored by whoever does not know them -- a newer ClikCode may say
 * more than this extension understands. */
export function isIdeEvent(message: unknown): message is IdeEvent {
  return typeof message === 'object' && message !== null && typeof (message as { type?: unknown }).type === 'string';
}

export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private readonly pending = new Map<string, Pending>();
  private exited = false;
  readonly build: string | undefined;

  private constructor(private readonly child: ChildProcess, readonly runtime: Runtime) {
    super();
    this.build = entryBuild(runtime.entry);
    child.on('message', (message) => {
      if (!isIdeEvent(message)) return;
      if (message.type === 'result') {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          if (message.ok) pending.resolve(message.data);
          else pending.reject(new Error(message.error ?? 'request failed'));
        }
      }
      this.emit('event', message);
    });
    const logLines = (prefix: string) => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) this.emit('log', `${prefix}${line}`);
      };
    };
    child.stdout?.on('data', logLines(''));
    child.stderr?.on('data', logLines(''));
    child.on('error', (error) => this.emit('log', `bridge process error: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.exited = true;
      for (const pending of this.pending.values()) pending.reject(new Error('ClikCode stopped'));
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
  }

  static start(runtime: Runtime, cwd: string | undefined): BridgeClient {
    const child = spawn(runtime.node, [runtime.entry, 'ide-bridge'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...runtime.env, CLIKCODE_OUTPUT_MODE: 'json', NO_COLOR: '1' },
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
    });
    return new BridgeClient(child, runtime);
  }

  get running(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  send(request: IdeRequest): void {
    if (this.exited || !this.child.connected) return;
    this.child.send(request);
  }

  /** A request answered by a `result` event carrying its requestId. */
  call<T = unknown>(request: WithoutRequestId<IdeRequest>, timeoutMs = 120_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('ClikCode is not running'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('ClikCode did not answer in time'));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (data) => { clearTimeout(timer); resolve(data as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ ...request, requestId } as IdeRequest);
    });
  }

  /** Asks the bridge to leave the conversation cleanly, then makes sure. */
  dispose(): void {
    if (this.exited) return;
    this.send({ type: 'close' });
    const child = this.child;
    setTimeout(() => { if (!this.exited) child.kill(); }, 3_000).unref();
    try { child.disconnect(); } catch { /* already */ }
  }
}
