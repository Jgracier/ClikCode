/** `clikcode ide-bridge`: an editor's ClikCode client.
 *
 * The interactive terminal (commands/ai/interactive.ts) is two things at
 * once: a screen, and the client that runs a conversation -- attaching to its
 * worker, loading what a turn needs before submitting it, sending queued
 * messages when a turn ends, handing a sign-in a terminal. This is the second
 * half, for a client whose screen is an editor: the same decisions, in the
 * same order, with the editor's widgets answering the pickers (see
 * prompter.ts) and the protocol in protocol.ts in place of painting.
 *
 * One conversation at a time, like a terminal: `open` switches, and a slash
 * command that moves the conversation (/new, /fork, /resume) switches too.
 */
import { stripVTControlCharacters } from 'node:util';
import { panelParts, renderPanelText } from '../harness/output.js';
import { lifecycle, setLifecycleSession } from '../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';
import type Conf from 'conf';
import { CLIKCODE_VERSION } from '../version.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { claimConversation, leaveConversation, openConversation, resolveSessionModel } from '../session/attach.js';
import { synchronizeNativeTranscript } from '../turn/handoff.js';
import { nativeUsageReading, recheckRecoveredAccounts } from '../harness/accounts/account-usage.js';
import { gatewayCreditLabel } from '../gateway/credit-label.js';
import { usageNextReset, usageResetLabel, usageWindowsDetail } from '../harness/accounts/usage-reading.js';
import { resumeWaitLabel } from '../turn/usage-exhausted.js';
import { signInCancelledLine } from '../commands/account.js';
import { setHarnessInstallReporter, type HarnessInstallReporter } from '../harness/transport/native/install.js';
import { reconcileLocalModelLeases } from '../commands/ai/local-model.js';
import { conversationCost } from '../tui/slash/usage-report.js';
import { autoSelectSessionHarness } from '../tui/pickers/engine.js';
import { currentWorkerBuild, readWorkerRecord, workerIsReachable } from '../worker/registry.js';
import { shownSettingsKey } from '../worker/protocol.js';
import { IdePrompter, type IdeChannel } from './prompter.js';
import { watchConversationList, type ListWatch } from '../session/list-watch.js';
import { encodeTerminalSpec, type IdeEvent, type IdeFeature, type IdeRequest, type IdeTerminalSpec } from './protocol.js';
import { IDE_PROTOCOL } from './protocol-version.js';
import { sessionEvent } from './session-event.js';
import { searchScreen } from './bridge-slash-host.js';
import type { MentionScreen } from '../tui/slash/search-browse.js';
import { BridgeTurns } from './bridge-turns.js';
import { choose } from './bridge-choose.js';
import { answerQuery } from './bridge-query.js';
import { messageOf, TurnFailed } from './bridge-support.js';
import { WorkerLink } from './bridge-worker.js';
import type { BridgeHost } from './bridge-host.js';
import type { InteractiveSlashOutcome } from '../tui/slash/interactive-keys.js';

const USAGE_REFRESH_MS = 15_000;

export class IdeBridge {
  readonly prompter: IdePrompter;
  private sessionId: string | undefined;
  /** shownSettingsKey of the chat as last sent to the editor. */
  private shownSettings: string | undefined;
  private preparedRoute: string | undefined;
  private drainScheduled = false;
  private work: Promise<void> = Promise.resolve();
  private readonly signIns = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  private readonly timers: NodeJS.Timeout[] = [];
  private closed = false;
  /** Open conversations lists in the editor, and the watch behind them. */
  private listWatchers = 0;
  private listWatch: ListWatch | undefined;
  /** A choice made in the editor's own widgets is on screen there already:
   * its confirmation ("Model set to …", "Renamed to …", an account removed)
   * is not said again in the chat. Errors still are. */
  quietOutput = 0;
  /** What the editor said it handles, with its last `open`. */
  private features: ReadonlySet<IdeFeature> = new Set();
  /** The editor shows this chat (its `visible`): only then is usage polled. */
  private shown = true;
  /** /search waiting on the editor's next key. */
  private searchKey: ((key: Extract<IdeRequest, { type: 'search-key' }>['key']) => void) | undefined;
  /** What the parts of the bridge (bridge-*.ts) see of it. */
  private readonly host: BridgeHost;
  private readonly link: WorkerLink;
  private readonly turns: BridgeTurns;

  constructor(private readonly config: Conf, private readonly channel: IdeChannel) {
    this.prompter = new IdePrompter(channel);
    const bridge = this;
    this.host = {
      config, channel, prompter: this.prompter,
      get sessionId() { return bridge.sessionId; },
      get closed() { return bridge.closed; },
      get shown() { return bridge.shown; },
      get features() { return bridge.features; },
      get link() { return bridge.link; },
      quietly: async (job) => {
        bridge.quietOutput += 1;
        try { return await job(); } finally { bridge.quietOutput -= 1; }
      },
      requireSession: () => bridge.requireSession(),
      current: (id) => bridge.current(id),
      emitSession: () => bridge.emitSession(),
      enqueue: (job) => bridge.enqueue(job),
      report: (error) => bridge.report(error),
      switchTo: (id) => bridge.switchTo(id),
      prepareRoute: () => bridge.prepareRoute(),
      refreshUsage: () => bridge.refreshUsage(),
      scheduleDrain: () => bridge.scheduleDrain(),
      closeConversation: () => { bridge.link.detach(); bridge.sessionId = undefined; },
      setSearchKey: (answer) => { bridge.searchKey = answer; },
      runInTerminal: (spec, request) => bridge.runInTerminal(spec, request),
      drainQueue: () => bridge.drainQueue(),
      execute: (line, options) => bridge.execute(line, options),
      runTurn: (targetId, prompt, turn) => bridge.runTurn(targetId, prompt, turn),
      dispatch: (line, fromQueuedCommand) => bridge.dispatch(line, fromQueuedCommand),
    };
    this.link = new WorkerLink(this.host);
    this.turns = new BridgeTurns(this.host);
  }

  start(): void {
    const usage = setInterval(() => { if (this.shown) void this.refreshUsage().catch(() => undefined); }, USAGE_REFRESH_MS);
    usage.unref();
    this.timers.push(usage);
    this.channel.send({ type: 'ready', version: CLIKCODE_VERSION, protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.revision, ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}), pid: process.pid });
  }

  handle(request: IdeRequest): void {
    // What the editor asked for, minus its frequent read-only queries.
    if (request.type !== 'query') lifecycle('bridge.request', { type: request.type, ...(request.type === 'choose' ? { kind: request.choice.kind } : {}) });
    switch (request.type) {
      case 'open':
        this.features = new Set(request.features ?? []);
        this.enqueue(async () => {
          try {
            await this.open(request.workspace, request.mode, request.sessionId);
            this.channel.send({ type: 'result', requestId: request.requestId, ok: true, data: { sessionId: this.sessionId } });
          } catch (error) {
            this.channel.send({ type: 'result', requestId: request.requestId, ok: false, error: messageOf(error) });
            return;
          }
          await this.drainQueue();
        });
        return;
      case 'send':
        void this.turns.send(request.text, request.id);
        return;
      case 'cancel':
        void this.link.cancelTurn(request.restoreDraft);
        return;
      case 'send-queued':
        this.link.worker?.client.send({ type: 'send-queued' });
        return;
      case 'unqueue':
        if (this.sessionId) void this.link.workerFor(this.sessionId).then((client) => client.send({ type: 'unqueue', id: request.id }), (error: unknown) => this.report(error));
        return;
      case 'approval-response':
        this.link.worker?.client.send({ type: 'approval-response', id: request.id, approved: request.approved });
        return;
      case 'question-response':
        this.link.worker?.client.send({ type: 'question-response', id: request.id, result: request.result });
        return;
      case 'ui-response':
        this.prompter.answer(request.id, request.result);
        return;
      case 'sign-in-cancel':
        this.prompter.cancelSignIn(request.id);
        return;
      case 'sign-in-answer':
        this.prompter.answerSignIn(request.id, request.text);
        return;
      case 'sign-in-result': {
        const pending = this.signIns.get(request.id);
        if (!pending) return;
        this.signIns.delete(request.id);
        if (request.error) pending.reject(new Error(request.error));
        else pending.resolve();
        return;
      }
      case 'query':
        void answerQuery(this.host, request.requestId, request.query ?? 'slash-commands', request);
        return;
      case 'choose':
        void choose(this.host, request.requestId, request.choice);
        return;
      case 'watch-conversations':
        this.watchConversations(request.on);
        return;
      case 'search-key': {
        const answer = this.searchKey;
        this.searchKey = undefined;
        answer?.(request.key);
        return;
      }
      case 'visible': {
        const appeared = request.visible && !this.shown;
        this.shown = request.visible;
        if (appeared) void this.refreshUsage().catch(() => undefined);
        return;
      }
      case 'close':
        void this.shutdown();
        return;
      default:
        // An editor newer than this ClikCode: a request it does not know.
        return;
    }
  }

  /** While the editor shows a conversations list, tell it when the state or
   * worker directories change, so it re-queries then instead of on a timer. */
  private watchConversations(on: boolean): void {
    this.listWatchers = Math.max(0, this.listWatchers + (on ? 1 : -1));
    if (this.listWatchers && !this.listWatch && !this.closed) {
      this.listWatch = watchConversationList(() => this.channel.send({ type: 'conversations-changed' }));
    } else if (!this.listWatchers && this.listWatch) {
      this.listWatch.stop();
      this.listWatch = undefined;
    }
  }

  private stopping: Promise<void> | undefined;

  /** One shutdown, however many ask: the editor sends `close` and then
   * disconnects at once, and the disconnect's exit used to land while the
   * close was still writing the state -- a lock file left empty, which every
   * other ClikCode then waited 30 s to judge stale (an open stood that long). */
  shutdown(): Promise<void> {
    this.stopping ??= this.stop();
    return this.stopping;
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.listWatch?.stop();
    this.listWatch = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.prompter.cancelAll();
    this.searchKey?.('done');
    for (const pending of this.signIns.values()) pending.reject(new Error('the editor closed'));
    this.signIns.clear();
    this.link.detach();
    await reconcileLocalModelLeases(undefined).catch(() => undefined);
    if (this.sessionId) await leaveConversation(this.sessionId);
  }

  /** One job at a time, in order -- until a job opens a vendor sign-in. That
   * waits on a browser for as long as the user likes, and every open, send
   * and choice behind it waited too; the job carries on by itself from there,
   * and the queue moves on. */
  private enqueue(job: () => Promise<void>): void {
    this.work = this.work.then(() => new Promise<void>((release) => {
      void this.prompter.holding(release, job).catch((error: unknown) => this.report(error)).finally(release);
    }));
  }

  private report(error: unknown): void {
    if (error instanceof TurnFailed) return;
    // The user's own Cancel is an outcome: one plain line, as the terminal says it.
    const cancelled = signInCancelledLine(error);
    if (cancelled) { this.channel.send({ type: 'notice', message: cancelled, level: 'info' }); return; }
    this.channel.send({ type: 'notice', message: messageOf(error), level: 'error' });
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('No conversation is open.');
    return this.sessionId;
  }

  private async current(id = this.requireSession()): Promise<{ session: HarnessSession; account?: string }> {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    return { session, ...(account ? { account } : {}) };
  }

  private async emitSession(): Promise<void> {
    if (!this.sessionId) return;
    const { session, account } = await this.current();
    this.channel.send(sessionEvent(session, account));
    // A command here changed what the chat runs on: every other window
    // attached to its worker (a terminal, another editor) re-renders.
    const key = shownSettingsKey(session);
    if (this.shownSettings?.startsWith(`${session.id}|`) && this.shownSettings !== key && this.link.worker?.sessionId === session.id) this.link.worker.client.send({ type: 'refresh' });
    this.shownSettings = key;
  }

  // ---- conversations -------------------------------------------------------

  private async open(workspace: string, mode: 'new' | 'continue' | 'resume', ref?: string): Promise<void> {
    const id = await openConversation(workspace, mode, ref, { sameWorkspace: true });
    const { session } = await this.current(id);
    // As a terminal does on open: a conversation with no provider gets the one
    // the user is signed in to, without asking; with none, the first message
    // or /provider asks.
    if (!session.nativeHarness && !isClikCodeAgent(session)) await autoSelectSessionHarness(id).catch(() => false);
    await resolveSessionModel(id);
    await this.switchTo(id);
    void this.synchronizeOpened(id);
  }

  /** Vendor transcripts are folded in after the editor is already showing the
   * chat. The open itself only reads that one conversation. */
  private async synchronizeOpened(id: string): Promise<void> {
    const synced = await readState({ transcripts: [id] });
    const syncing = synced.sessions.find((item) => item.id === id);
    if (!syncing || !await synchronizeNativeTranscript(synced, syncing)) return;
    await writeState(synced);
    if (this.sessionId === id) await this.emitSession();
  }

  private async switchTo(id: string): Promise<void> {
    const previous = this.sessionId;
    if (previous && previous !== id) {
      if (this.link.worker?.sessionId === previous) this.link.worker.client.send({ type: 'release' });
      this.link.detach();
      await leaveConversation(previous);
    }
    this.sessionId = id;
    setLifecycleSession(id);
    lifecycle('bridge.conversation');
    this.preparedRoute = undefined;
    await claimConversation(id);
    await this.emitSession();
    // Follow a turn another client has running here, and have a worker that
    // is already up paint what it has streamed; nothing is started for a
    // conversation that has none yet.
    const record = await readWorkerRecord(id).catch(() => undefined);
    if (record && await workerIsReachable(record.socketPath)) await this.link.workerFor(id).catch(() => undefined);
    await this.prepareRoute();
    void this.refreshUsage().catch(() => undefined);
  }

  async refreshUsage(): Promise<void> {
    if (!this.sessionId) return;
    const state = await readState({ transcripts: [] });
    const session = state.sessions.find((item) => item.id === this.sessionId);
    if (!session) return;
    // The other accounts too, as the terminal does: one whose quota may have
    // come back is re-read, so failover and the picker see it.
    void recheckRecoveredAccounts(state).catch(() => undefined);
    // A Gateway chat's allowance is its credit, worded as the terminal's composer rule words it.
    const reading = isGatewayService(session)
      ? await gatewayCreditLabel(this.config, { fresh: true }).then((label) => (label ? { label, windows: undefined } : undefined)).catch(() => undefined)
      : await nativeUsageReading(session, state);
    // A turn parked for the reset says so instead of when it comes back.
    const reset = session.resumeAt ? resumeWaitLabel(session.resumeAt) : usageResetLabel(reading?.windows);
    const chatCost = conversationCost(state, session.id);
    const next = usageNextReset(reading?.windows);
    const detail = usageWindowsDetail(reading?.windows);
    this.channel.send({
      type: 'usage', ...(reading?.label ? { label: reading.label } : {}), ...(reset ? { reset } : {}),
      ...(next ? { next } : {}), ...(detail ? { detail } : {}), ...(chatCost !== undefined ? { chatCost } : {}),
    });
  }

  /** The conversation's route is ready before the first message: MCP servers
   * and the Gateway connection for an agent route, and nothing left running
   * for one that moved off it. Mirrors the interactive loop's preparedRoute. */
  private async prepareRoute(): Promise<void> {
    const { session } = await this.current();
    await reconcileLocalModelLeases(session).catch(() => undefined);
    const key = `${session.id} ${session.route}`;
    if (key === this.preparedRoute) return;
    this.preparedRoute = key;
    if (!isClikCodeAgent(session) && this.link.worker?.sessionId !== session.id) return;
    const client = await this.link.workerFor(session.id).catch(() => undefined);
    client?.send({ type: 'prepare' });
  }

  /** Send the queue's head once no turn runs. Coalesced: however many
   * queue-changed arrive, one drain is pending at a time, and none while a
   * turn runs or this client is sending one (its caller drains after). */
  private scheduleDrain(): void {
    if (this.drainScheduled || this.closed || !this.sessionId) return;
    if (this.link.running) return;
    this.drainScheduled = true;
    this.enqueue(async () => {
      this.drainScheduled = false;
      if (this.link.running) return;
      await this.drainQueue();
    });
  }

  runInTerminal(spec: IdeTerminalSpec, request: { environment: Readonly<Record<string, string>>; name: string }): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the editor closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.signIns.set(id, { resolve, reject });
      this.channel.send({ type: 'sign-in', id, name: request.name, spec: encodeTerminalSpec(spec), environment: { ...request.environment } });
    });
  }

  // The turn and worker steps live in bridge-turns.ts and bridge-worker.ts; these
  // are the seams the parts call through (and the ones a test replaces).
  get worker(): WorkerLink['worker'] { return this.link.worker; }
  set worker(value: WorkerLink['worker']) { this.link.worker = value; }
  get workerTurnRunning(): boolean { return this.link.workerTurnRunning; }
  set workerTurnRunning(value: boolean) { this.link.workerTurnRunning = value; }
  get turnWaiter(): WorkerLink['turnWaiter'] { return this.link.turnWaiter; }
  set turnWaiter(value: WorkerLink['turnWaiter']) { this.link.turnWaiter = value; }
  onWorkerEvent(sessionId: string, client: Parameters<WorkerLink['onWorkerEvent']>[1], event: Parameters<WorkerLink['onWorkerEvent']>[2]): void { this.link.onWorkerEvent(sessionId, client, event); }
  private drainQueue(): Promise<void> { return this.turns.drainQueue(); }
  private execute(line: string, options: { queuedTurnId?: string; fromQueuedCommand?: boolean }): Promise<void> { return this.turns.execute(line, options); }
  private runTurn(targetId: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> { return this.turns.runTurn(targetId, prompt, turn); }
  /** /search's screen in the editor (bridge-slash-host.ts). */
  searchScreen(): MentionScreen { return searchScreen(this.host); }
  private dispatch(line: string, fromQueuedCommand: boolean): Promise<InteractiveSlashOutcome> { return this.turns.dispatch(line, fromQueuedCommand); }
}

/** Everything this process prints to stdout is either a command's JSON result
 * -- which the editor shows -- or noise from something that did not expect to
 * run without a terminal, which goes to the log. */
export function captureStdout(channel: IdeChannel, stream: NodeJS.WriteStream = process.stdout, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): void {
  let buffer = '';
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let payload: unknown;
      try { payload = JSON.parse(line); } catch { payload = undefined; }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        const text = renderPanelText(record);
        channel.send({ type: 'output', payload: record, ...(text === undefined ? {} : { formatted: panelParts(stripVTControlCharacters(text)) }) });
      }
      else if (line.trim()) log(line);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.();
    return true;
  }) as NodeJS.WriteStream['write'];
}

export function ideInstallReporter(channel: IdeChannel): HarnessInstallReporter {
  return {
    start: (label) => channel.send({ type: 'busy', label }),
    done: (message) => {
      channel.send({ type: 'busy' });
      channel.send({ type: 'notice', message, level: 'info' });
    },
    // The error itself reaches the editor as the failed request's notice.
    failed: () => channel.send({ type: 'busy' }),
  };
}

export async function runIdeBridge(config: Conf): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) throw new Error('ide-bridge is started by an editor extension, over an IPC channel');
  // Command results as records, which the editor renders -- never as text
  // drawn for a terminal that is not there.
  process.env.CLIKCODE_OUTPUT_MODE = 'json';
  let bridge: IdeBridge | undefined;
  const channel: IdeChannel = {
    send: (event: IdeEvent) => {
      if (event.type === 'output' && bridge?.quietOutput && event.payload.panel !== 'error') return;
      if (process.connected) send(event, undefined, {}, () => undefined);
    },
  };
  captureStdout(channel);
  // Choosing a harness that is not installed installs it (install.ts); here
  // that shows as the chat's busy line, then a notice.
  setHarnessInstallReporter(ideInstallReporter(channel));
  const running = new IdeBridge(config, channel);
  bridge = running;
  process.on('message', (message) => {
    if (message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') running.handle(message as IdeRequest);
  });
  // The editor closed or crashed: the channel is gone with it.
  process.on('disconnect', () => { lifecycle('bridge.stop', { reason: 'editor disconnected' }); void running.shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { lifecycle('bridge.stop', { reason: 'SIGTERM' }); void running.shutdown().finally(() => process.exit(0)); });
  running.start();
  await new Promise<void>(() => { /* lives as long as the channel */ });
}
