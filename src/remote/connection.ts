/** The board's view of the other machines: one SSH connection to each added
 * machine, running that machine's own `clikcode ide-bridge --stdio`
 * (multiplexed), and asking it for its conversation list exactly as an
 * editor does -- `query conversations`, then `watch-conversations` and a
 * fresh query on every `conversations-changed`.
 *
 * Read-only: nothing is opened, sent or changed on the other machine. The
 * terminal keeps ONE connection per machine for the life of its window
 * (`holdWindowMachines`): made the first time a list shows the machines (the
 * board, /machine), reused by every list and move after it, and
 * ended when the window closes (`closeWindowMachines`). A machine that cannot
 * be reached is offline, shown with the chats it had last time (the cache in
 * machines.json), and tried again with a growing pause while a list shows it;
 * with none showing it, it waits for the next list, which tries at once. No
 * port is opened on either machine: the bridge speaks over ssh's own
 * stdin/stdout.
 *
 * One thing is changed there, by the machine's own policy: a ClikCode on
 * another commit than this build is updated to it in the background
 * (updates.ts), and the connection made again once it is. */
import { quiet } from '../runtime/lifecycle-log.js';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { listedChats, type IdeConversation, type IdeEvent, type IdeHostEvent, type IdeHostRequest, type IdeRequest } from '../ide/protocol.js';
import { IDE_PROTOCOL } from '../ide/protocol-version.js';
import { bridgeScript } from './install.js';
import { autoUpdates, localBuildCommit, type AutoUpdates } from './updates.js';
import { readMachines, updateMachine, type RemoteMachine } from './machines.js';
import { startBridge, type PeerMachine } from './peer.js';
import { failureText } from '../harness/protocol/stderr-line.js';

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
/** A request the other machine never answers is a hang, not a pending request:
 * kept because a dropped link that ssh has not noticed yet looks exactly like this. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How much of a bridge's stderr is held for the reason it ended; the end of it, where the cause is. */
const STDERR_KEEP = 16_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const CACHE_WRITE_MS = 5_000;

export interface LinkOptions {
  /** Starts the remote bridge; ssh by default. */
  spawn?: (target: string, script: string) => ChildProcess;
  localCommit?: string;
  backoffMs?: readonly number[];
  /** How long a request waits for its answer (tests shorten it). */
  requestTimeoutMs?: number;
  /** Update an outdated machine by its policy (default on). Off where the
   * connection only shows the machine's state while the user chooses what
   * to do with it (/machine's list). A function is asked each time: the
   * window's connections update only while the board holds them. */
  autoUpdate?: boolean | (() => boolean);
  /** Whether anything shows the machine now. When not, a lost connection is
   * not tried again until `wake()` (the next list); absent: always. */
  wanted?: () => boolean;
  /** The automatic updates to go through (tests give their own). */
  autoUpdates?: AutoUpdates;
  /** This machine, told to the one connected to (remote/peer.ts); tests give their own. */
  self?: () => Promise<PeerMachine | undefined>;
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
  /** Offline with nothing showing it: tried again on `wake()`, not on a timer. */
  private parked = false;
  /** An automatic update is being considered or run from this link. */
  private updatingNow = false;
  readonly view: MachineView;
  /** What the bridge there said in its host-ready (1 when it did not say). */
  private revision = 1;
  private readonly channels = new Map<string, OpenChannel>();

  constructor(machine: RemoteMachine, private readonly changed: () => void, private readonly options: LinkOptions = {}) {
    this.view = {
      machine, state: 'connecting', needsUpdate: Boolean(machine.needsUpdate), chats: listedChats(machine.chats ?? []),
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
    let child: ChildProcess;
    try {
      child = this.options.spawn ? this.options.spawn(machine.sshTarget, bridgeScript()) : startBridge(machine.sshTarget, this.options.self);
    } catch (error) {
      this.lost(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-STDERR_KEEP); });
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
      const said = failureText(stderr);
      this.lost(said ? `${said} (exit ${code ?? '?'})` : `the connection ended (exit ${code ?? '?'})`);
    });
  }

  private wanted(): boolean {
    return this.options.wanted?.() ?? true;
  }

  private lost(error: string): void {
    this.set({ state: 'offline', error });
    if (this.stopped) return;
    if (!this.wanted()) { this.parked = true; return; }
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    const wait = backoff[Math.min(this.attempt, backoff.length - 1)]!;
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.stopped) return;
      if (!this.wanted()) { this.parked = true; return; }
      this.connect();
    }, wait);
    this.retry.unref();
  }

  /** A list shows the machine again: one offline is tried at once, not after
   * its pause (as a fresh connection would be); one connected is left as is. */
  wake(): void {
    if (this.stopped || this.child) return;
    if (!this.parked && !this.retry) return;
    this.parked = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.set({ state: 'connecting', error: undefined });
    this.connect();
  }

  private updatesAllowed(): boolean {
    const allowed = this.options.autoUpdate;
    return typeof allowed === 'function' ? allowed() : allowed !== false;
  }

  /** The board shows a machine already connected and outdated: brought to
   * this build by its policy, as on connecting (each commit tried once). */
  considerUpdate(): void {
    if (this.stopped || this.view.state !== 'connected' || !this.view.needsUpdate || this.view.updating || !this.updatesAllowed()) return;
    this.autoUpdate(this.options.localCommit ?? localBuildCommit());
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
      if (outdated && this.updatesAllowed()) this.autoUpdate(localCommit);
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
        this.set({ chats: listedChats(inner.data as IdeConversation[]) });
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
        const answered = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            open.pending.delete(requestId);
            reject(new Error(`${this.view.machine.name} did not answer "${request.type}" within ${(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 1000}s`));
          }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
          timer.unref();
          open.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        });
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
    if (this.updatingNow) return;
    this.updatingNow = true;
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
    })().catch(() => this.set({ updating: false })).finally(() => { this.updatingNow = false; });
  }

  /** Ends this connection and makes it again at once (a new build there). */
  reconnect(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.parked = false;
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

/** What a list holds of the window's connections (`holdWindowMachines`):
 * their views, a channel on one, and its own change listeners -- removed
 * with `release()`, which leaves the connections open for the next list. */
export interface MachinesHold {
  views(): readonly MachineView[];
  onChange(listener: () => void): () => void;
  channel(machineId: string): Promise<LinkChannel | undefined>;
  reconnect(machineId: string): void;
  release(): void;
}

/** Every added machine's connection: for as long as one screen shows them
 * (`open`/`close`), or for the window's life (`hold`, holdWindowMachines). */
export class RemoteMachines {
  private links: RemoteLink[] = [];
  private listeners = new Set<() => void>();
  private closed = false;
  /** Lists holding the connections now, and of them those that let an
   * outdated machine be updated by its policy (the board). */
  private holders = 0;
  private updaters = 0;
  private syncing: Promise<void> = Promise.resolve();
  /** Bumped on every change: the board rebuilds its rows only then. */
  revision = 0;

  constructor(private readonly options: LinkOptions = {}, private readonly held = false) {}

  private linkFor(machine: RemoteMachine): RemoteLink {
    const options: LinkOptions = this.held
      ? { ...this.options, wanted: () => this.holders > 0, autoUpdate: () => this.updaters > 0 }
      : this.options;
    return new RemoteLink(machine, () => this.notify(), options);
  }

  /** The links match machines.json as it is now: a machine added since gets
   * one, one forgotten (or no longer ready) loses its, and one now reached
   * at another address or name is connected to anew. The rest stay as they are. */
  private sync(): Promise<void> {
    const run = this.syncing.then(async () => {
      const machines = (await readMachines()).filter((machine) => machine.ready);
      if (this.closed) return;
      const next: RemoteLink[] = [];
      const ended: RemoteLink[] = [];
      for (const link of this.links) {
        const record = machines.find((machine) => machine.id === link.view.machine.id);
        if (record && record.sshTarget === link.view.machine.sshTarget && record.name === link.view.machine.name) {
          // Its policy may have changed in /machine; the connection has not.
          link.view.machine.updates = record.updates;
          next.push(link);
        } else ended.push(link);
      }
      for (const machine of machines) {
        if (next.some((link) => link.view.machine.id === machine.id)) continue;
        const link = this.linkFor(machine);
        next.push(link);
        link.start();
      }
      // In machines.json's order, as `open` lists them.
      next.sort((a, b) => machines.findIndex((m) => m.id === a.view.machine.id) - machines.findIndex((m) => m.id === b.view.machine.id));
      this.links = next;
      for (const link of ended) void link.stop();
      this.notify();
    });
    this.syncing = run.catch(quiet('remote/connection'));
    return run;
  }

  /** Holds the connections for a list: made now for any machine without one,
   * an offline one tried again at once, and kept after `release()`. With
   * `autoUpdate` (the board), an outdated machine is updated by its policy. */
  async hold(use: { autoUpdate?: boolean } = {}): Promise<MachinesHold> {
    this.holders += 1;
    if (use.autoUpdate) this.updaters += 1;
    const stops = new Set<() => void>();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (use.autoUpdate) this.updaters -= 1;
      for (const stop of stops) stop();
      stops.clear();
    };
    // fail-open-ok: machines.json unreadable now -- the list shows the connections it already has.
    await this.sync().catch(quiet('remote/connection'));
    for (const link of this.links) link.wake();
    if (use.autoUpdate) for (const link of this.links) link.considerUpdate();
    return {
      views: () => this.views(),
      onChange: (listener) => {
        if (released) return () => undefined;
        const stop = this.onChange(listener);
        const remove = (): void => { stop(); stops.delete(remove); };
        stops.add(remove);
        return remove;
      },
      channel: (machineId) => this.channel(machineId),
      reconnect: (machineId) => this.reconnect(machineId),
      release,
    };
  }

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

  /** A chat channel on the connection to a machine, once it is connected: one
   * still connecting (a list opened a moment ago) is waited for, not passed by. */
  async channel(machineId: string): Promise<LinkChannel | undefined> {
    const link = this.links.find((item) => item.view.machine.id === machineId);
    if (!link) return undefined;
    if (link.view.state === 'connecting') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, READY_TIMEOUT_MS);
        timer.unref();
        const stop = this.onChange(() => { if (link.view.state !== 'connecting') { clearTimeout(timer); stop(); resolve(); } });
      });
    }
    return link.channel();
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

/** The window's own: one connection per added machine, shared by every list
 * and move in this terminal, from the first list until the window closes. */
let windowMachines: RemoteMachines | undefined;

/** Holds the window's connections for a list (the board with `autoUpdate`,
 * /machine without): connects only to machines it has none to. */
export function holdWindowMachines(use: { autoUpdate?: boolean } = {}, options: LinkOptions = {}): Promise<MachinesHold> {
  windowMachines ??= new RemoteMachines(options, true);
  return windowMachines.hold(use);
}

/** Connects again to a machine whose ClikCode was just installed or updated
 * from here: its new build answers. Nothing when the window has no connection. */
export function reconnectWindowMachine(machineId: string): void {
  windowMachines?.reconnect(machineId);
}

/** The window is closing: every connection it kept ends (the bridges there exit). */
export async function closeWindowMachines(): Promise<void> {
  const machines = windowMachines;
  windowMachines = undefined;
  await machines?.close();
}
