/** One `clikcode ide-bridge` process for every chat of this window.
 *
 * Each chat -- the side bar, every chat tab -- used to start a bridge of its
 * own: a whole ClikCode, 120-330 MB, to show one conversation; six or seven
 * per window (measured 2026-10-20), each taking the state lock against the
 * others. The pool starts one per ClikCode build and gives each chat a
 * SharedChannel into it: the same protocol, inside a `{ chat }` envelope
 * (src/ide/bridge-mux.ts). What a chat sees is unchanged: its own `ready`,
 * its own results and events, an `exit` when the process goes.
 *
 * Lifetime is deterministic: a chat that leaves (its panel closed, parked,
 * restarted) closes its conversation in the process; when the last chat
 * leaves, the process is disconnected and exits. A process that died takes
 * every chat with it, and each reconnects (AutoReconnect) -- into one new
 * process, not one each. A new build gets a new process; the old one exits
 * when its last chat has moved.
 *
 * A ClikCode from before shared processes answers with a plain `ready`: its
 * process becomes the first chat's own, and every other chat gets one of its
 * own, as before.
 */
import { randomUUID } from 'node:crypto';
import { BridgeClient, BridgeEndpoint, MultiplexBridge } from './bridge-client';
import { SshBridgeClient } from './ssh-bridge-client';
import type { RemoteMachine } from '../../../src/remote/machines';
import type { IdeEvent, IdeHostEvent, IdeRequest } from './protocol';
import { entryBuild, type Runtime } from './runtime';

export const MULTIPLEX_ENV: Readonly<Record<string, string>> = { CLIKCODE_IDE_MULTIPLEX: '1' };

type Starter = (runtime: Runtime, cwd: string | undefined, extraEnv?: Readonly<Record<string, string>>) => MultiplexBridge;

export class BridgePool {
  private readonly hosts = new Map<string, SharedHost>();
  /** Runtimes whose ClikCode cannot share a process: a chat each. */
  private readonly single = new Set<string>();

  constructor(private readonly start: Starter = (runtime, cwd, extraEnv) => runtime.entry.startsWith('remote:')
    ? SshBridgeClient.start(runtime.entry.slice('remote:'.length), runtime)
    : BridgeClient.start(runtime, cwd, extraEnv)) {}

  /** One SSH bridge per remote machine, shared by its chats in this window. */
  connectRemote(machine: RemoteMachine): BridgeEndpoint {
    const runtime: Runtime = {
      node: 'ssh', entry: `remote:${machine.sshTarget}`, env: {}, nodeSource: 'path', entrySource: 'setting',
    };
    return this.connect(runtime, undefined);
  }

  /** A chat's connection: into this runtime's shared process (started if
   * there is none, or the one there is is on its way out), or -- `shared`
   * off, or a ClikCode that cannot share -- a process of its own. */
  connect(runtime: Runtime, cwd: string | undefined, shared = true): BridgeEndpoint {
    const key = poolKey(runtime);
    if (!shared || this.single.has(key)) return this.start(runtime, cwd);
    let host = this.hosts.get(key);
    if (!host?.accepting) {
      const created = new SharedHost(runtime, cwd, this.start, {
        gone: () => { if (this.hosts.get(key) === created) this.hosts.delete(key); },
        cannotShare: () => { this.single.add(key); },
      });
      host = created;
      this.hosts.set(key, host);
    }
    return host.join();
  }

  /** Shared processes accepting chats (tests, diagnostics). */
  get sharedProcesses(): number {
    return [...this.hosts.values()].filter((host) => host.accepting).length;
  }
}

/** One ClikCode per build, node, entry and environment. Not per folder: a
 * chat names its workspace when it opens a conversation. */
function poolKey(runtime: Runtime): string {
  return [runtime.node, runtime.entry, entryBuild(runtime.entry) ?? '', JSON.stringify(runtime.env)].join('\0');
}

class SharedHost {
  private state: 'starting' | 'shared' | 'single' | 'draining' | 'gone' = 'starting';
  private readonly proc: MultiplexBridge;
  /** Chats in this process, oldest first. */
  private readonly channels = new Map<string, SharedChannel>();

  constructor(
    private readonly runtime: Runtime,
    private readonly cwd: string | undefined,
    private readonly start: Starter,
    private readonly pool: { gone(): void; cannotShare(): void },
  ) {
    this.proc = start(runtime, cwd, MULTIPLEX_ENV);
    this.proc.on('event', (message) => this.onMessage(message as IdeEvent | IdeHostEvent));
    this.proc.on('log', (line) => {
      // While it starts, every chat waiting on it sees why it failed (an
      // older ClikCode without `ide-bridge` is recognised from this);
      // afterwards the log is said once, by the oldest chat.
      if (this.state === 'starting') for (const channel of this.channels.values()) channel.log(line);
      else this.channels.values().next().value?.log(line);
    });
    this.proc.on('exit', ({ code, signal }) => {
      if (this.state === 'single') return;
      this.state = 'gone';
      this.pool.gone();
      const left = [...this.channels.values()];
      this.channels.clear();
      for (const channel of left) channel.hostExited(code, signal);
    });
  }

  get accepting(): boolean {
    return this.state === 'starting' || this.state === 'shared';
  }

  join(): SharedChannel {
    const channel = new SharedChannel(this.runtime, this.proc.build, randomUUID(), this);
    this.channels.set(channel.chat, channel);
    if (this.state === 'shared') this.attach(channel);
    return channel;
  }

  private attach(channel: SharedChannel): void {
    this.proc.post({ type: 'chat-attach', chat: channel.chat });
    channel.attached();
  }

  /** A chat's request, inside the envelope. */
  forward(chat: string, request: IdeRequest): boolean {
    if (this.state !== 'shared') return false;
    return this.proc.post({ type: 'chat', chat, request });
  }

  logDrained(timeoutMs: number): Promise<void> {
    return this.proc.logDrained(timeoutMs);
  }

  /** A chat left: its conversation is closed in the process, and the
   * process itself goes with the last chat. */
  release(channel: SharedChannel): void {
    if (!this.channels.delete(channel.chat)) return;
    if (this.state === 'shared') this.proc.post({ type: 'chat', chat: channel.chat, request: { type: 'close' } });
    if (this.channels.size || !this.accepting) return;
    this.state = 'draining';
    this.pool.gone();
    this.proc.dispose();
  }

  private onMessage(message: IdeEvent | IdeHostEvent): void {
    if (this.state === 'starting' && message.type === 'host-ready') {
      this.state = 'shared';
      for (const channel of this.channels.values()) this.attach(channel);
      return;
    }
    if (this.state === 'starting' && message.type === 'ready') {
      this.fallBack(message);
      return;
    }
    if (message.type === 'chat') this.channels.get(message.chat)?.deliver(message.event);
  }

  /** An older ClikCode: one conversation per process. This one becomes the
   * first chat's own; every other chat starts its own. */
  private fallBack(ready: IdeEvent): void {
    this.state = 'single';
    this.pool.cannotShare();
    this.pool.gone();
    const waiting = [...this.channels.values()];
    this.channels.clear();
    this.proc.removeAllListeners();
    const [first, ...rest] = waiting;
    if (!first) { this.proc.dispose(); return; }
    first.adopt(this.proc, ready);
    for (const channel of rest) channel.adopt(this.start(this.runtime, this.cwd));
  }
}

/** A chat's share of the window's process: the BridgeEndpoint a controller
 * holds, exactly as it would hold a process of its own. */
export class SharedChannel extends BridgeEndpoint {
  /** Requests sent before the process said it serves chats. */
  private queued: IdeRequest[] = [];
  private live = false;
  private own: BridgeEndpoint | undefined;

  constructor(runtime: Runtime, build: string | undefined, readonly chat: string, private readonly host: SharedHost) {
    super(runtime, build);
  }

  send(request: IdeRequest): boolean {
    if (this.exited) return false;
    if (this.own) return this.own.send(request);
    if (!this.live) { this.queued.push(request); return true; }
    return this.host.forward(this.chat, request);
  }

  /** The chat leaves: its conversation is closed; the process stays for the
   * others. Says `exit` at once -- nothing more arrives for it. */
  dispose(): void {
    if (this.exited) return;
    if (this.own) { this.own.dispose(); return; }
    this.host.release(this);
    this.queued = [];
    this.markExited(0, null);
  }

  logDrained(timeoutMs: number): Promise<void> {
    return this.own ? this.own.logDrained(timeoutMs) : this.host.logDrained(timeoutMs);
  }

  /** @internal SharedHost */
  attached(): void {
    this.live = true;
    const queued = this.queued;
    this.queued = [];
    for (const request of queued) this.host.forward(this.chat, request);
  }

  /** @internal SharedHost */
  deliver(event: IdeEvent): void {
    if (!this.exited) this.receive(event);
  }

  /** @internal SharedHost */
  log(line: string): void {
    if (!this.exited) this.emit('log', line);
  }

  /** @internal SharedHost */
  hostExited(code: number | null, signal: NodeJS.Signals | null): void {
    this.markExited(code, signal);
  }

  /** @internal SharedHost: an older ClikCode; this chat gets `client` to itself. */
  adopt(client: BridgeEndpoint, ready?: IdeEvent): void {
    this.own = client;
    client.on('event', (event) => this.receive(event));
    client.on('log', (line) => this.emit('log', line));
    client.on('exit', ({ code, signal }) => this.markExited(code, signal));
    if (ready) this.receive(ready);
    const queued = this.queued;
    this.queued = [];
    for (const request of queued) client.send(request);
  }
}

/** This window's pool: one per extension host. */
export const bridgePool = new BridgePool();
