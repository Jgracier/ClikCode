/** `clikcode ide-bridge` serving every chat of an editor window from one
 * process (CLIKCODE_IDE_MULTIPLEX=1).
 *
 * Each editor chat -- the side bar, every chat tab -- used to run a bridge
 * process of its own: 120-330 MB each, six or seven in one window (measured
 * 2026-10-20), every one of them loading all of ClikCode to show one
 * conversation, and taking the state lock against the others. Here one
 * process holds one IdeBridge per chat, each speaking the unchanged protocol
 * inside a `{ chat }` envelope (protocol.ts IdeHostRequest / IdeHostEvent).
 *
 * What was per process is per chat again: a command's JSON on stdout, an
 * install's busy line and the lifecycle log's `session` go to the chat whose
 * code is running (an AsyncLocalStorage set around everything a chat is
 * handed); presence and local-model leases, held once per process, are left
 * alone while a sibling still shows that conversation (BridgeSiblings).
 *
 * The editor owns the lifetime: it disconnects when its last chat leaves,
 * and the process exits on that disconnect, as a one-chat bridge does. The
 * one exception is a newer ClikCode installed meanwhile: once every chat is
 * quiet the process says `host-retiring`, closes them all and exits, and the
 * editor connects again to the new build (bridge-retire.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type Conf from 'conf';
import { lifecycle, setLifecycleSessionSource } from '../runtime/lifecycle-log.js';
import { setHarnessInstallReporter } from '../harness/transport/native/install.js';
import { currentWorkerBuild } from '../worker/registry.js';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { readState } from '../session/state/read.js';
import { IdeBridge, captureStdout, ideInstallReporter, type BridgeSiblings } from './bridge.js';
import type { IdeChannel } from './prompter.js';
import type { IdeEvent, IdeHostEvent, IdeHostRequest, IdeRequest } from './protocol.js';
import { IDE_PROTOCOL } from './protocol-version.js';
import { watchForNewerBuild } from './bridge-retire.js';

/** What the host needs of a chat's bridge (IdeBridge; a test's stand-in). */
export interface MuxChat {
  start(): void;
  handle(request: IdeRequest): void;
  shutdown(): Promise<void>;
  readonly conversation: string | undefined;
  readonly quietOutput: number;
  /** What keeps a newer build from replacing the process now (IdeBridge.retireBlocker). */
  retireBlocker(): string | undefined;
  readonly lastActivityAt: number;
}

interface Chat { id: string; bridge: MuxChat; channel: IdeChannel; closing?: Promise<void> }

export class MultiplexHost {
  private readonly chats = new Map<string, Chat>();
  private readonly current = new AsyncLocalStorage<Chat>();
  private stopping: Promise<void> | undefined;
  /** A chat joining or leaving is activity too. */
  private changedAt = Date.now();

  constructor(
    private readonly send: (event: IdeHostEvent) => void,
    private readonly create: (channel: IdeChannel, siblings: BridgeSiblings) => MuxChat,
  ) {}

  /** What reaches "the editor" from code that does not know which chat it
   * runs for (stdout, an install's busy line): the chat it runs for, or
   * nobody -- false, so the caller can log it instead. */
  readonly routed: IdeChannel & { sendRouted(event: IdeEvent): boolean } = {
    send: (event) => { this.routed.sendRouted(event); },
    sendRouted: (event) => {
      const chat = this.current.getStore();
      if (!chat || !this.chats.has(chat.id)) return false;
      if (event.type === 'output' && chat.bridge.quietOutput && event.payload.panel !== 'error') return true;
      chat.channel.send(event);
      return true;
    },
  };

  /** The conversation of the chat whose code is running (the lifecycle log). */
  sessionOfCurrent(): string | undefined {
    return this.current.getStore()?.bridge.conversation;
  }

  get size(): number {
    return this.chats.size;
  }

  /** What keeps a newer build from replacing this process: the first chat's reason. */
  retireBlocker(): string | undefined {
    if (this.stopping) return 'stopping';
    for (const chat of this.chats.values()) {
      if (chat.closing) return 'a chat is closing';
      const blocker = chat.bridge.retireBlocker();
      if (blocker) return blocker;
    }
    return undefined;
  }

  /** When anything last happened in any chat. */
  get lastActivityAt(): number {
    return Math.max(this.changedAt, ...[...this.chats.values()].map((chat) => chat.bridge.lastActivityAt));
  }

  /** Leaves for a newer build: says so (`host-retiring`) before anything
   * else, so the editor reads what follows -- each chat closed, then the
   * process gone -- as a reconnect, not a failure. */
  retire(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.send({ type: 'host-retiring', reason: 'newer-build' });
    return this.shutdown();
  }

  handle(message: IdeHostRequest | IdeRequest): void {
    if (this.stopping) return;
    if (message.type === 'chat-attach' || (message.type === 'chat' && message.request.type === 'close')) this.changedAt = Date.now();
    if (message.type === 'chat-attach') { this.attach(message.chat); return; }
    // The machine driving this one: it can be driven from here too.
    if (message.type === 'host-peer') { void import('../remote/peer.js').then(({ recordPeer }) => recordPeer(message.machine)).catch(() => undefined); return; }
    if (message.type === 'chat') {
      const chat = this.chats.get(message.chat);
      if (!chat) return;
      if (message.request.type === 'close') { void this.close(chat); return; }
      this.current.run(chat, () => chat.bridge.handle(message.request));
      return;
    }
    // A plain `close` (the editor's dispose of the whole process): every chat.
    if (message.type === 'close') void this.shutdown();
  }

  private attach(id: string): void {
    if (this.chats.has(id)) return;
    const channel: IdeChannel = { send: (event) => this.send({ type: 'chat', chat: id, event }) };
    const siblings: BridgeSiblings = {
      showingElsewhere: (self) => new Set([...this.chats.values()].filter((other) => other.bridge !== self).flatMap((other) => other.bridge.conversation ? [other.bridge.conversation] : [])),
    };
    const chat: Chat = { id, channel, bridge: undefined as unknown as MuxChat };
    chat.bridge = this.create(channel, siblings);
    this.chats.set(id, chat);
    lifecycle('bridge.chat.attach', { chats: this.chats.size });
    this.current.run(chat, () => chat.bridge.start());
  }

  /** One chat leaves: its bridge shuts down (leaving its conversation), and
   * the editor is told. The others carry on. */
  private close(chat: Chat): Promise<void> {
    chat.closing ??= this.current.run(chat, () => chat.bridge.shutdown()).catch(() => undefined).finally(() => {
      this.chats.delete(chat.id);
      lifecycle('bridge.chat.close', { chats: this.chats.size });
      this.send({ type: 'chat-closed', chat: chat.id });
    });
    return chat.closing;
  }

  /** Every chat, once however many ask (a `close`, then the disconnect). */
  shutdown(): Promise<void> {
    this.stopping ??= Promise.all([...this.chats.values()].map((chat) => this.close(chat))).then(() => undefined);
    return this.stopping;
  }
}

export async function runMultiplexedBridge(config: Conf, send: NonNullable<typeof process.send>): Promise<void> {
  // Not passed on to the workers and vendors this process starts.
  delete process.env.CLIKCODE_IDE_MULTIPLEX;
  // The last event before a retirement exit is what tells the editor to
  // reconnect: the exit waits until it has left (IPC writes asynchronously).
  let sent: Promise<void> = Promise.resolve();
  const host = new MultiplexHost(
    (event) => { if (process.connected) sent = new Promise((resolve) => send(event, undefined, {}, () => resolve())); },
    (channel, siblings) => new IdeBridge(config, channel, siblings),
  );
  const log = (line: string): void => { process.stderr.write(`${line}\n`); };
  captureStdout({ send: (event) => { if (!host.routed.sendRouted(event)) log(`output outside any chat: ${JSON.stringify(event).slice(0, 300)}`); } });
  setHarnessInstallReporter(ideInstallReporter(host.routed));
  setLifecycleSessionSource(() => host.sessionOfCurrent());
  process.on('message', (message) => {
    if (message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') host.handle(message as IdeHostRequest | IdeRequest);
  });
  process.on('disconnect', () => { lifecycle('bridge.stop', { reason: 'editor disconnected', chats: host.size }); void host.shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { lifecycle('bridge.stop', { reason: 'SIGTERM', chats: host.size }); void host.shutdown().finally(() => process.exit(0)); });
  // A newer ClikCode installed while the editor stays connected: leave once quiet.
  watchForNewerBuild({
    blocker: () => host.retireBlocker(),
    lastActivityAt: () => host.lastActivityAt,
    retire: () => { void host.retire().then(() => sent).finally(() => process.exit(0)); },
  });
  // Which installation this is (ClikCode Remote tells machines apart by it): the index only.
  // Never long: an editor waits on host-ready, and a state lock held elsewhere must not hold it.
  const installationId = await Promise.race([
    readState({ transcripts: [] }).then((state) => state.installationId, () => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000).unref()),
  ]);
  const build = currentWorkerBuild();
  send({
    type: 'host-ready', version: CLIKCODE_VERSION, protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.revision,
    ...(build ? { build } : {}), pid: process.pid,
    ...(CLIKCODE_COMMIT ? { commit: CLIKCODE_COMMIT } : {}), ...(installationId ? { installationId } : {}),
  } satisfies IdeHostEvent, undefined, {}, () => undefined);
  await new Promise<void>(() => { /* lives as long as the channel */ });
}

