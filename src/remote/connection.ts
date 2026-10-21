/** The board's view of the other machines: one SSH connection to each added
 * machine, running that machine's own `clikcode ide-bridge --stdio`
 * (multiplexed), and asking it for its conversation list exactly as an
 * editor does -- `query conversations`, then `watch-conversations` and a
 * fresh query on every `conversations-changed`.
 *
 * Read-only: nothing is opened, sent or changed on the other machine. Open
 * only while something shows it (the board, /remote) -- `close()` ends every
 * connection, and nothing stays connected in the background. A machine
 * that cannot be reached is offline, shown with the chats it had last time
 * (the cache in machines.json), and tried again with a growing pause. No
 * port is opened on either machine: the bridge speaks over ssh's own
 * stdin/stdout. */
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { IdeConversation, IdeHostEvent, IdeHostRequest } from '../ide/protocol.js';
import { IDE_PROTOCOL } from '../ide/protocol-version.js';
import { CLIKCODE_COMMIT } from '../version.js';
import { bridgeScript } from './install.js';
import { readMachines, updateMachine, type RemoteMachine } from './machines.js';
import { spawnSsh } from './ssh.js';

export type MachineState = 'connecting' | 'connected' | 'offline';

export interface MachineView {
  machine: RemoteMachine;
  state: MachineState;
  /** Its ClikCode is another commit than this machine's build. */
  needsUpdate: boolean;
  /** What it has now, or had last time while offline. */
  chats: readonly IdeConversation[];
  /** Why it is offline, in ssh's words. */
  error?: string;
}

/** The ClikCode commit (and protocol) of a remote's `host-ready` differs
 * from this build's: it needs an update. Unknown on either side is not a
 * difference -- nothing to compare. */
export function needsUpdate(ready: { commit?: string; protocol?: number }, localCommit: string | undefined = CLIKCODE_COMMIT): boolean {
  if (ready.protocol !== undefined && ready.protocol !== IDE_PROTOCOL.version) return true;
  return Boolean(ready.commit && localCommit && ready.commit !== localCommit);
}

const CHAT = 'clikcode-remote-board';
const READY_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const CACHE_WRITE_MS = 5_000;

export interface LinkOptions {
  /** Starts the remote bridge; ssh by default. */
  spawn?: (target: string, script: string) => ChildProcess;
  localCommit?: string;
  backoffMs?: readonly number[];
}

/** One machine's connection, reconnecting until stopped. */
export class RemoteLink {
  private child: ChildProcess | undefined;
  private stopped = false;
  private attempt = 0;
  private retry: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private requestSeq = 0;
  private querying = false;
  private queryAgain = false;
  private cacheTimer: NodeJS.Timeout | undefined;
  private cacheDirty = false;
  readonly view: MachineView;

  constructor(machine: RemoteMachine, private readonly changed: () => void, private readonly options: LinkOptions = {}) {
    this.view = { machine, state: 'connecting', needsUpdate: Boolean(machine.needsUpdate), chats: machine.chats ?? [] };
  }

  start(): void {
    if (this.stopped || this.child) return;
    this.connect();
  }

  private set(patch: Partial<MachineView>): void {
    Object.assign(this.view, patch);
    this.changed();
  }

  private send(message: IdeHostRequest): void {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) stdin.write(`${JSON.stringify(message)}\n`);
  }

  private connect(): void {
    const machine = this.view.machine;
    const spawnBridge = this.options.spawn ?? spawnSsh;
    let child: ChildProcess;
    try {
      child = spawnBridge(machine.sshTarget, bridgeScript());
    } catch (error) {
      this.lost(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000); });
    child.stdin?.on('error', () => undefined);
    child.once('error', (error) => { stderr += `\n${error.message}`; });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let event: IdeHostEvent;
      try { event = JSON.parse(line) as IdeHostEvent; } catch { return; }
      this.onEvent(event);
    });
    this.readyTimer = setTimeout(() => { stderr += '\nno answer from ClikCode there'; child.kill('SIGTERM'); }, READY_TIMEOUT_MS);
    this.readyTimer.unref();
    child.once('close', (code) => {
      clearTimeout(this.readyTimer);
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      const said = stderr.trim().split('\n').filter(Boolean).pop();
      this.lost(said ?? `the connection ended (exit ${code ?? '?'})`);
    });
  }

  private lost(error: string): void {
    this.set({ state: 'offline', error });
    if (this.stopped) return;
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    const wait = backoff[Math.min(this.attempt, backoff.length - 1)]!;
    this.attempt += 1;
    this.retry = setTimeout(() => { this.retry = undefined; if (!this.stopped) this.connect(); }, wait);
    this.retry.unref();
  }

  private onEvent(event: IdeHostEvent): void {
    if (event.type === 'host-ready') {
      clearTimeout(this.readyTimer);
      this.attempt = 0;
      const outdated = needsUpdate(event, this.options.localCommit ?? CLIKCODE_COMMIT);
      const machine = this.view.machine;
      if (event.installationId && !machine.installationId) machine.installationId = event.installationId;
      machine.needsUpdate = outdated;
      this.set({ state: 'connected', needsUpdate: outdated, error: undefined });
      this.send({ type: 'chat-attach', chat: CHAT });
      return;
    }
    if (event.type !== 'chat' || event.chat !== CHAT) return;
    const inner = event.event;
    if (inner.type === 'ready') {
      this.send({ type: 'chat', chat: CHAT, request: { type: 'watch-conversations', on: true } });
      this.query();
    } else if (inner.type === 'conversations-changed') {
      this.query();
    } else if (inner.type === 'result' && inner.requestId === `list-${this.requestSeq}`) {
      this.querying = false;
      if (inner.ok && Array.isArray(inner.data)) {
        this.set({ chats: inner.data as IdeConversation[] });
        this.saveCache();
      }
      if (this.queryAgain) { this.queryAgain = false; this.query(); }
    }
  }

  /** One query at a time; a change during one asks once more after it. */
  private query(): void {
    if (this.querying) { this.queryAgain = true; return; }
    this.querying = true;
    this.requestSeq += 1;
    this.send({ type: 'chat', chat: CHAT, request: { type: 'query', requestId: `list-${this.requestSeq}`, query: 'conversations' } });
  }

  /** The chats as last seen, for the offline view -- at most every few
   * seconds, and once more when the connection closes. */
  private saveCache(): void {
    this.cacheDirty = true;
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => { this.cacheTimer = undefined; void this.flushCache(); }, CACHE_WRITE_MS);
    this.cacheTimer.unref();
  }

  flushCache(): Promise<void> {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
    if (!this.cacheDirty) return Promise.resolve();
    this.cacheDirty = false;
    const { chats, needsUpdate: outdated, machine } = this.view;
    return updateMachine(machine.id, (record) => {
      record.chats = [...chats];
      record.lastSeen = new Date().toISOString();
      record.needsUpdate = outdated;
      if (machine.installationId) record.installationId = machine.installationId;
    }, { durable: false }).then(() => undefined, () => undefined);
  }

  /** Ends the connection: the remote bridge sees its stdin close and exits. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.readyTimer);
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.stdin?.end();
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const grace = setTimeout(() => child.kill('SIGTERM'), 1500);
      grace.unref();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())]);
      clearTimeout(grace);
    }
    await this.flushCache();
  }
}

/** Every added machine's connection, for as long as one screen shows them. */
export class RemoteMachines {
  private links: RemoteLink[] = [];
  private listeners = new Set<() => void>();
  private closed = false;
  /** Bumped on every change: the board rebuilds its rows only then. */
  revision = 0;

  constructor(private readonly options: LinkOptions = {}) {}

  /** Opens a connection to each ready machine (the list is read now). */
  async open(): Promise<this> {
    const machines = (await readMachines()).filter((machine) => machine.ready);
    if (this.closed) return this;
    this.links = machines.map((machine) => new RemoteLink(machine, () => this.notify(), this.options));
    for (const link of this.links) link.start();
    this.notify();
    return this;
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  views(): readonly MachineView[] {
    return this.links.map((link) => link.view);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await Promise.all(this.links.map((link) => link.stop()));
    this.links = [];
  }
}
