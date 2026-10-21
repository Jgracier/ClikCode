/** The extension's end of `clikcode ide-bridge`: one child process, an IPC
 * channel for the protocol, stdout/stderr for the log. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IdeEvent, IdeHostRequest, IdeRequest } from './protocol';
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
function isIdeEvent(message: unknown): message is IdeEvent {
  return typeof message === 'object' && message !== null && typeof (message as { type?: unknown }).type === 'string';
}

/** A chat's connection to a bridge: a process of its own (BridgeClient) or
 * its share of the window's one process (bridge-pool.ts SharedChannel). */
export abstract class BridgeEndpoint extends EventEmitter<BridgeClientEvents> {
  private readonly pending = new Map<string, Pending>();
  protected exited = false;

  constructor(readonly runtime: Runtime, readonly build: string | undefined) {
    super();
  }

  /** False when the request could not be handed to the bridge (it is gone):
   * the caller owns telling the user, and clearing what waited on it. */
  abstract send(request: IdeRequest): boolean;
  /** Leaves the bridge: asks it to close the conversation cleanly. */
  abstract dispose(): void;
  /** Resolves once everything the process wrote to stderr has been logged,
   * or after `timeoutMs` (a detached grandchild can hold stderr open). */
  abstract logDrained(timeoutMs: number): Promise<void>;

  get running(): boolean {
    return !this.exited;
  }

  protected receive(message: IdeEvent): void {
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error ?? 'request failed'));
      }
    }
    this.emit('event', message);
  }

  protected markExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(new Error('ClikCode stopped'));
    this.pending.clear();
    this.emit('exit', { code, signal });
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
}

/** A process that can carry several chat channels, whether IPC or SSH. */
export abstract class MultiplexBridge extends BridgeEndpoint {
  abstract post(message: IdeRequest | IdeHostRequest): boolean;
}

export class BridgeClient extends MultiplexBridge {
  private readonly stderrClosed: Promise<void>;

  private constructor(private readonly child: ChildProcess, runtime: Runtime) {
    super(runtime, entryBuild(runtime.entry));
    child.on('message', (message) => {
      if (isIdeEvent(message)) this.receive(message);
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
    this.stderrClosed = child.stderr ? new Promise((resolve) => child.stderr!.once('close', () => resolve())) : Promise.resolve();
    child.on('error', (error) => this.emit('log', `bridge process error: ${error.message}`));
    child.on('exit', (code, signal) => this.markExited(code, signal));
  }

  /** `extraEnv`: what the pool adds to ask for a shared process. */
  static start(runtime: Runtime, cwd: string | undefined, extraEnv: Readonly<Record<string, string>> = {}): BridgeClient {
    const child = spawn(runtime.node, [runtime.entry, 'ide-bridge'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...bridgeEnvironment(process.env, runtime.env), ...extraEnv },
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
    });
    return new BridgeClient(child, runtime);
  }

  logDrained(timeoutMs: number): Promise<void> {
    return Promise.race([this.stderrClosed, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  send(request: IdeRequest): boolean {
    return this.post(request);
  }

  /** Any message to the process: a chat's request, or a shared process's
   * envelope (bridge-pool.ts). */
  post(message: IdeRequest | IdeHostRequest): boolean {
    if (this.exited || !this.child.connected) return false;
    try { this.child.send(message); } catch { return false; }
    return true;
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

/** The bridge's environment. ELECTRON_RUN_AS_NODE comes only from the
 * runtime (set when the bridge runs on VS Code's own Electron), never from
 * the extension host's environment: ClikCode drops it again as it starts, so
 * its workers, vendor CLIs and shells never see it (src/runtime/electron-env.ts). */
export function bridgeEnvironment(inherited: NodeJS.ProcessEnv, runtimeEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _inherited, ...rest } = inherited;
  return { ...rest, ...runtimeEnv, CLIKCODE_OUTPUT_MODE: 'json', NO_COLOR: '1' };
}
