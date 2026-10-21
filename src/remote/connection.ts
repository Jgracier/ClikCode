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
 * stdin/stdout.
 *
 * One thing is changed there, by the machine's own policy: a ClikCode on
 * another commit than this build is updated to it in the background
 * (updates.ts), and the connection made again once it is. */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { IdeConversation, IdeEvent, IdeHostEvent, IdeHostRequest, IdeRequest } from '../ide/protocol.js';
import { IDE_PROTOCOL } from '../ide/protocol-version.js';
import { bridgeScript } from './install.js';
import { autoUpdates, localBuildCommit, type AutoUpdates } from './updates.js';
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
  /** Its ClikCode is being updated to this build's (updates.ts). */
  updating?: boolean;
  /** Why its last update failed. */
  updateError?: string;
}

/** The ClikCode commit (and protocol) of a remote's `host-ready` differs
 * from this build's: it needs an update. Unknown on either side is not a
 * difference -- nothing to compare. */
export function needsUpdate(ready: { commit?: string; protocol?: number }, localCommit: string | undefined = localBuildCommit()): boolean {
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
  /** Update an outdated machine by its policy (default on). Off where the
   * connection only shows the machine's state while the user chooses what
   * to do with it (/remote's list). */
  autoUpdate?: boolean;
  /** The automatic updates to go through (tests give their own). */
  autoUpdates?: AutoUpdates;
}

/** A request answered by a `result`, without its id (the channel gives it one). */
type Answered<T = IdeRequest> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

/** A chat channel of its own on a machine's connection (the board's), for a
 * few requests -- a move's -- without opening another SSH connection. */
export interface LinkChannel {
  /** Which additive requests the ClikCode there answers (protocol-version.ts). */
  readonly revision: number;
  request<T = unknown>(request: Answered): Promise<T>;
  close(): void;
}

interface OpenChannel {
  ready: () => void;
  failed: (error: Error) => void;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
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
  /** The connection is being made again (after an update): no offline in between. */
  private reconnecting = false;
  /** The bridge there said it is leaving for a newer build (ide/bridge-retire.ts):
   * its close is followed at once by a new connection, and the machine still
   * reads as connected meanwhile -- nothing about it changed for the user. */
  private retiring = false;
  readonly view: MachineView;
  /** What the bridge there said in its host-ready (1 when it did not say). */
  private revision = 1;
  private readonly channels = new Map<string, OpenChannel>();

  constructor(machine: RemoteMachine, private readonly changed: () => void, private readonly options: LinkOptions = {}) {
    this.view = {
      machine, state: 'connecting', needsUpdate: Boolean(machine.needsUpdate), chats: machine.chats ?? [],
      ...(machine.updateError ? { updateError: machine.updateError } : {}),
    };
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
      this.dropChannels(new Error(`The connection to ${machine.name} ended`));
      const retired = this.retiring;
      this.retiring = false;
      if (this.stopped) return;
      if (this.reconnecting || retired) {
        this.reconnecting = false;
        if (!retired) this.set({ state: 'connecting', error: undefined });
        this.connect();
        return;
      }
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
      const localCommit = this.options.localCommit ?? localBuildCommit();
      const outdated = needsUpdate(event, localCommit);
      const machine = this.view.machine;
      if (event.installationId && !machine.installationId) machine.installationId = event.installationId;
      machine.needsUpdate = outdated;
      // Current now: an old failure no longer says anything.
      if (!outdated) delete machine.updateError;
      this.revision = event.revision ?? 1;
      this.set({ state: 'connected', needsUpdate: outdated, error: undefined, ...(outdated ? {} : { updateError: undefined }) });
      this.send({ type: 'chat-attach', chat: CHAT });
      if (outdated && this.options.autoUpdate !== false) this.autoUpdate(localCommit);
      return;
    }
    if (event.type === 'host-retiring') { this.retiring = true; return; }
    if (event.type === 'chat' && this.channels.has(event.chat)) { this.onChannelEvent(this.channels.get(event.chat)!, event.event); return; }
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

  private onChannelEvent(channel: OpenChannel, event: IdeEvent): void {
    if (event.type === 'ready') { channel.ready(); return; }
    if (event.type !== 'result') return;
    const waiter = channel.pending.get(event.requestId);
    if (!waiter) return;
    channel.pending.delete(event.requestId);
    if (event.ok) waiter.resolve(event.data);
    else waiter.reject(new Error(event.error ?? 'Remote request failed'));
  }

  private dropChannels(error: Error): void {
    const open = [...this.channels.values()];
    this.channels.clear();
    for (const channel of open) {
      channel.failed(error);
      for (const waiter of channel.pending.values()) waiter.reject(error);
    }
  }

  /** A chat channel on this connection, once the ClikCode there has it open;
   * undefined while the machine is not connected. */
  async channel(): Promise<LinkChannel | undefined> {
    if (this.view.state !== 'connected' || !this.child) return undefined;
    const chat = `clikcode-move-${randomUUID()}`;
    const open: OpenChannel = { ready: () => undefined, failed: () => undefined, pending: new Map() };
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${this.view.machine.name}`)), READY_TIMEOUT_MS);
      timer.unref();
      open.ready = () => { clearTimeout(timer); resolve(); };
      open.failed = (error) => { clearTimeout(timer); reject(error); };
    });
    this.channels.set(chat, open);
    this.send({ type: 'chat-attach', chat });
    try { await ready; } catch (error) { this.channels.delete(chat); throw error; }
    const revision = this.revision;
    return {
      revision,
      request: <T>(request: Answered): Promise<T> => {
        if (!this.channels.has(chat)) return Promise.reject(new Error(`The connection to ${this.view.machine.name} ended`));
        const requestId = randomUUID();
        const answered = new Promise<unknown>((resolve, reject) => open.pending.set(requestId, { resolve, reject }));
        this.send({ type: 'chat', chat, request: { ...request, requestId } as IdeRequest });
        return answered as Promise<T>;
      },
      close: () => {
        if (!this.channels.delete(chat)) return;
        this.send({ type: 'chat', chat, request: { type: 'close' } });
      },
    };
  }

  /** Brings the machine to this build when its policy says so; once it is,
   * connects again, to the new build's bridge. */
  private autoUpdate(localCommit: string | undefined): void {
    const machine = this.view.machine;
    void (async () => {
      const started = await (this.options.autoUpdates ?? autoUpdates).consider(machine, localCommit);
      if (!started) return;
      this.set({ updating: true });
      const outcome = await started.done;
      if (outcome.ok) {
        delete machine.updateError;
        this.set({ updating: false, updateError: undefined });
        this.reconnect();
      } else {
        machine.updateError = `${outcome.step}: ${outcome.message}`;
        this.set({ updating: false, updateError: machine.updateError });
      }
    })().catch(() => this.set({ updating: false }));
  }

  /** Ends this connection and makes it again at once (a new build there). */
  reconnect(): void {
    if (this.stopped) return;
    this.attempt = 0;
    const child = this.child;
    if (!child) {
      clearTimeout(this.retry);
      this.retry = undefined;
      this.set({ state: 'connecting', error: undefined });
      this.connect();
      return;
    }
    this.reconnecting = true;
    child.stdin?.end();
    child.kill('SIGTERM');
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
      if (!outdated) delete record.updateError;
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

  /** Pick up a newly installed machine without disturbing existing links. */
  async refresh(): Promise<void> {
    const machines = (await readMachines()).filter((machine) => machine.ready);
    if (this.closed) return;
    for (const machine of machines) {
      if (this.links.some((link) => link.view.machine.id === machine.id)) continue;
      const link = new RemoteLink(machine, () => this.notify(), this.options);
      this.links.push(link);
      link.start();
    }
    this.notify();
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

  /** A chat channel on the connection to a machine, while it is connected. */
  async channel(machineId: string): Promise<LinkChannel | undefined> {
    return this.links.find((link) => link.view.machine.id === machineId)?.channel();
  }

  /** Connects to a machine again: its ClikCode was just updated. */
  reconnect(machineId: string): void {
    this.links.find((link) => link.view.machine.id === machineId)?.reconnect();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await Promise.all(this.links.map((link) => link.stop()));
    this.links = [];
  }
}
