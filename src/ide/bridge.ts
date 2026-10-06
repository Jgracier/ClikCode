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
import { lifecycle, setLifecycleSession } from '../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type Conf from 'conf';
import { CLIKCODE_VERSION } from '../version.js';
import { backfillListFacts } from '../session/list-backfill.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { isClikCodeAgent } from '../session/route.js';
import { SESSION_CLAIM_TTL_MS } from '../session/claim.js';
import { afterTurnFailure, claimConversation, leaveConversation, openConversation, prepareTurn, resolveSessionModel } from '../session/attach.js';
import { expandHomePath } from '../session/attachments.js';
import { consumeSessionTurn } from '../turn/checkpoint.js';
import { synchronizeNativeTranscript } from '../turn/handoff.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { nativeUsageReading } from '../harness/accounts/account-usage.js';
import { usageResetLabel } from '../harness/accounts/usage-reading.js';
import { resumeWaitLabel } from '../turn/usage-exhausted.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { withSignIn } from '../commands/account.js';
import { newConversation } from '../commands/ai/conversations.js';
import { setHarnessInstallReporter, type HarnessInstallReporter } from '../harness/transport/native/install.js';
import { reconcileLocalModelLeases } from '../commands/ai/local-model.js';
import { isShellCommandLine } from '../commands/ai/shell-run.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { selectGatewayAgent } from '../commands/ai/sessions.js';
import { dispatchLine, type SlashHost } from '../tui/slash/dispatch.js';
import { slashPalette } from '../tui/slash/registry.js';
import { sessionHarness, slashExtrasFor, slashRouteContextFor } from '../tui/slash/context.js';
import { commandDuringTurn, slashLineIsCommand } from '../tui/slash/queue.js';
import { withArgValues } from '../tui/slash/arg-values.js';
import type { PaletteEntry } from '../tui/command-palette.js';
import type { InteractiveSlashOutcome } from '../tui/slash/interactive-keys.js';
import { autoSelectSessionHarness, providerConversationKey } from '../tui/pickers/engine.js';
import { addAccountForHarness, manageAccountAction, useAddedAccount } from '../tui/pickers/account.js';
import { interactiveSessionPicker } from '../tui/pickers/session.js';
import { type ExhaustionRetryGuard } from '../tui/pickers/resume-in.js';
import { INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt.js';
import { WorkerClient } from '../worker/client.js';
import { currentWorkerBuild, readWorkerRecord, workerIsReachable } from '../worker/registry.js';
import { shownSettingsKey, type WorkerEvent } from '../worker/protocol.js';
import { IdePrompter, type IdeChannel } from './prompter.js';
import { watchConversationList, type ListWatch } from '../session/list-watch.js';
import { encodeTerminalSpec, type IdeChoice, type IdeEvent, type IdeQueryName, type IdeRequest, type IdeSlashCommand, type IdeTerminalSpec } from './protocol.js';
import { IDE_PROTOCOL } from './protocol-version.js';
import { sessionEvent } from './session-event.js';
import { selectProviderConversation } from '../tui/pickers/conversation.js';
import {
  accountList, chatSettings, conversationList, gatewayCheckoutUrl, gatewayStatus, modelList, providerList,
  sessionHarnessDefinition,
} from './queries.js';

/** A turn's own failure. The worker has already reported it (its turn-error
 * reaches the editor as a worker event), so the bridge does not say it twice. */
class TurnFailed extends Error {}

const USAGE_REFRESH_MS = 30_000;

export class IdeBridge {
  readonly prompter: IdePrompter;
  private sessionId: string | undefined;
  private worker: { sessionId: string; client: WorkerClient } | undefined;
  /** shownSettingsKey of the chat as last sent to the editor. */
  private shownSettings: string | undefined;
  /** Seen waiting-start without its waiting-stop: a turn is running on this
   * conversation's worker, whichever client started it. */
  private workerTurnRunning = false;
  private turnWaiter: { resolve: () => void; reject: (error: Error) => void; error?: Error } | undefined;
  private preparedRoute: string | undefined;
  /** The same-provider retry after running out: once per interrupted turn. */
  private readonly exhaustionGuard: ExhaustionRetryGuard = {};
  /** What the last turn actually sent, when a slash command expanded the
   * line (/review): what an interrupted turn recorded is compared to. */
  private sentPrompt: string | undefined;
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

  private readonly slashHost: SlashHost;

  constructor(private readonly config: Conf, private readonly channel: IdeChannel) {
    this.prompter = new IdePrompter(channel);
    this.slashHost = this.createSlashHost();
  }

  start(): void {
    const claim = setInterval(() => { if (this.sessionId) void claimConversation(this.sessionId).catch(() => undefined); }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
    const usage = setInterval(() => { void this.refreshUsage().catch(() => undefined); }, USAGE_REFRESH_MS);
    claim.unref();
    usage.unref();
    this.timers.push(claim, usage);
    this.channel.send({ type: 'ready', version: CLIKCODE_VERSION, protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.revision, ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}), pid: process.pid });
  }

  handle(request: IdeRequest): void {
    // What the editor asked for, minus its frequent read-only queries.
    if (request.type !== 'query') lifecycle('bridge.request', { type: request.type, ...(request.type === 'choose' ? { kind: request.choice.kind } : {}) });
    switch (request.type) {
      case 'open':
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
        void this.send(request.text, request.id);
        return;
      case 'cancel':
        this.worker?.client.send({ type: 'cancel', restoreDraft: request.restoreDraft });
        return;
      case 'unqueue':
        if (this.sessionId) void this.workerFor(this.sessionId).then((client) => client.send({ type: 'unqueue', id: request.id }), (error: unknown) => this.report(error));
        return;
      case 'approval-response':
        this.worker?.client.send({ type: 'approval-response', id: request.id, approved: request.approved });
        return;
      case 'ui-response':
        this.prompter.answer(request.id, request.result);
        return;
      case 'sign-in-cancel':
        this.prompter.cancelSignIn(request.id);
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
        void this.query(request.requestId, request.query ?? 'slash-commands', request);
        return;
      case 'choose':
        void this.choose(request.requestId, request.choice);
        return;
      case 'watch-conversations':
        this.watchConversations(request.on);
        return;
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
    for (const pending of this.signIns.values()) pending.reject(new Error('the editor closed'));
    this.signIns.clear();
    this.detachWorker();
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
    if (this.shownSettings?.startsWith(`${session.id}|`) && this.shownSettings !== key && this.worker?.sessionId === session.id) this.worker.client.send({ type: 'refresh' });
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
      if (this.worker?.sessionId === previous) this.worker.client.send({ type: 'release' });
      this.detachWorker();
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
    if (record && await workerIsReachable(record.socketPath)) await this.workerFor(id).catch(() => undefined);
    await this.prepareRoute();
    void this.refreshUsage().catch(() => undefined);
  }

  private async refreshUsage(): Promise<void> {
    if (!this.sessionId) return;
    const state = await readState({ transcripts: [] });
    const session = state.sessions.find((item) => item.id === this.sessionId);
    if (!session) return;
    const reading = await nativeUsageReading(session, state);
    // A turn parked for the reset says so instead of when it comes back.
    const reset = session.resumeAt ? resumeWaitLabel(session.resumeAt) : usageResetLabel(reading?.windows);
    this.channel.send({ type: 'usage', ...(reading?.label ? { label: reading.label } : {}), ...(reset ? { reset } : {}) });
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
    if (!isClikCodeAgent(session) && this.worker?.sessionId !== session.id) return;
    const client = await this.workerFor(session.id).catch(() => undefined);
    client?.send({ type: 'prepare' });
  }

  // ---- the worker ----------------------------------------------------------

  private async workerFor(sessionId: string): Promise<WorkerClient> {
    if (this.worker?.sessionId === sessionId) return this.worker.client;
    this.detachWorker();
    const client = await WorkerClient.attach(sessionId);
    const initial = await client.initialSnapshot;
    this.worker = { sessionId, client };
    this.workerTurnRunning = initial.type === 'snapshot' && Boolean(initial.live);
    this.channel.send({ type: 'worker', sessionId, event: initial });
    client.on('event', (event: WorkerEvent) => this.onWorkerEvent(sessionId, client, event));
    client.on('close', () => {
      if (this.worker?.client !== client) return;
      const midTurn = this.workerTurnRunning || Boolean(this.turnWaiter);
      this.worker = undefined;
      this.workerTurnRunning = false;
      if (midTurn) { this.failTurn(new Error('session worker connection closed unexpectedly')); return; }
      // An idle worker left -- retired for a newer build, or timed out. Not
      // the user's concern: attach to (or start) its replacement so this
      // window keeps following the conversation.
      if (this.closed || this.sessionId !== sessionId) return;
      this.enqueue(async () => {
        if (this.closed || this.sessionId !== sessionId || this.worker) return;
        await this.workerFor(sessionId).catch(() => undefined);
      });
    });
    return client;
  }

  private detachWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.workerTurnRunning = false;
    try { worker.client.send({ type: 'detach' }); worker.client.close(); } catch { /* already gone */ }
  }

  private onWorkerEvent(sessionId: string, client: WorkerClient, event: WorkerEvent): void {
    this.channel.send({ type: 'worker', sessionId, event });
    switch (event.type) {
      case 'waiting-start':
        this.workerTurnRunning = true;
        return;
      case 'sign-in-request':
        // The worker has no terminal; the editor has one. The worker retries
        // the turn once this answers.
        // The sign-in runs here and shows in the panel, like every other. It
        // is the turn's, which holds the queue anyway: not the job that
        // happened to attach this worker.
        void this.prompter.holding(undefined, () => withSignIn(this.prompter, event.name, async () => {
          const harness = localHarnessForCommand(event.command);
          if (!harness) throw new Error(`unknown harness ${event.command}`);
          await loginNativeHarness({ ...harness, loginArgv: event.argv }, event.environment);
        }))
          .then(() => client.send({ type: 'sign-in-response', id: event.id }),
            (error: unknown) => client.send({ type: 'sign-in-response', id: event.id, error: messageOf(error) }));
        return;
      case 'turn-error':
        if (this.turnWaiter) this.turnWaiter.error = new TurnFailed(event.message);
        return;
      case 'waiting-stop': {
        this.workerTurnRunning = false;
        const waiter = this.turnWaiter;
        this.turnWaiter = undefined;
        if (waiter) (waiter.error ? waiter.reject(waiter.error) : waiter.resolve());
        // A turn this editor only followed (a terminal's, or one the worker
        // started) ended: what was queued behind it is this client's to send.
        // Its own turn's caller drains once the turn returns.
        else this.scheduleDrain();
        return;
      }
      case 'queue-changed':
        // Something was queued or consumed: nothing runs it but a client, and
        // the one that queued it may be this editor following another's turn.
        this.scheduleDrain();
        return;
      case 'submit-queued': {
        // The worker had a turn running and queued this submit behind it.
        // The waiter resolves at that turn's waiting-stop and the drain sends
        // the message then; if that stop came first, nothing is left to wait
        // for, and resending now cannot land in a running turn.
        if (this.workerTurnRunning) return;
        const waiter = this.turnWaiter;
        this.turnWaiter = undefined;
        waiter?.resolve();
        return;
      }
      case 'shutdown':
        // A worker only retires idle; the close that follows reattaches.
        if (this.workerTurnRunning || this.turnWaiter) this.failTurn(new Error(`session worker exited mid-turn: ${event.reason}`));
        return;
      default:
        return;
    }
  }

  /** Send the queue's head once no turn runs. Coalesced: however many
   * queue-changed arrive, one drain is pending at a time, and none while a
   * turn runs or this client is sending one (its caller drains after). */
  private scheduleDrain(): void {
    if (this.drainScheduled || this.closed || !this.sessionId) return;
    if (this.workerTurnRunning || this.turnWaiter) return;
    this.drainScheduled = true;
    this.enqueue(async () => {
      this.drainScheduled = false;
      if (this.workerTurnRunning || this.turnWaiter) return;
      await this.drainQueue();
    });
  }

  private failTurn(error: Error): void {
    const waiter = this.turnWaiter;
    this.turnWaiter = undefined;
    waiter?.reject(error);
  }

  private runInTerminal(spec: IdeTerminalSpec, request: { environment: Readonly<Record<string, string>>; name: string }): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the editor closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.signIns.set(id, { resolve, reject });
      this.channel.send({ type: 'sign-in', id, name: request.name, spec: encodeTerminalSpec(spec), environment: { ...request.environment } });
    });
  }

  // ---- lines -----------------------------------------------------------------

  private async send(text: string, id?: string): Promise<void> {
    const line = text.trim();
    if (!line) return;
    try {
      if (this.workerTurnRunning && this.worker) {
        const sessionId = this.worker.sessionId;
        const { session } = await this.current(sessionId);
        const context = slashRouteContextFor(session, sessionHarness(session), (path) => existsSync(expandHomePath(path)));
        if (isShellCommandLine(line) || slashLineIsCommand(line, context)) {
          // ClikCode's own command: applied now if it is a pure setting,
          // otherwise run when the turn ends -- never sent to the model.
          const result = await commandDuringTurn(sessionId, line);
          if (id) this.channel.send({ type: 'worker', sessionId, event: { type: 'submission', id, disposition: result.disposition === 'queued' ? 'queued' : 'steered' } });
          await this.emitSession();
          return;
        }
        this.worker.client.send({ type: 'steer', text: line, ...(id ? { id } : {}) });
        return;
      }
    } catch (error) {
      this.report(error);
      return;
    }
    this.enqueue(async () => {
      await this.execute(line, {});
      await this.drainQueue();
    });
  }

  /** Messages typed during a turn that the harness could not take mid-turn,
   * and commands that waited for the turn to end: sent in order, as the
   * interactive loop does at the top of every pass. */
  private async drainQueue(): Promise<void> {
    let previous: string | undefined;
    while (!this.closed && this.sessionId) {
      const state = await readState({ transcripts: [this.sessionId!] });
      const session = state.sessions.find((item) => item.id === this.sessionId);
      const queued = session?.queuedTurns?.[0];
      if (!session || !queued) return;
      // Still at the head after its run: it failed and could not be taken
      // out (the worker refuses it from then on). Sending it again would
      // only fail the same way; it waits for the user to remove it.
      if (queued.id === previous) return;
      previous = queued.id;
      if (queued.kind === 'command') {
        if (consumeSessionTurn(session, queued.id)) await writeState(state);
        await this.execute(queued.text, { fromQueuedCommand: true });
      } else {
        await this.execute(queued.text, { queuedTurnId: queued.id });
      }
    }
  }

  private async execute(line: string, options: { queuedTurnId?: string; fromQueuedCommand?: boolean }): Promise<void> {
    const id = this.requireSession();
    this.sentPrompt = undefined;
    try {
      if (options.queuedTurnId) {
        await this.runTurn(id, line, { echo: true, queuedTurnId: options.queuedTurnId });
        return;
      }
      const outcome = await this.dispatch(line, Boolean(options.fromQueuedCommand));
      if (outcome.notice) this.channel.send({ type: 'notice', message: outcome.notice, level: 'info' });
      if (outcome.exit) {
        this.channel.send({ type: 'closed', sessionId: id });
        this.detachWorker();
        this.sessionId = undefined;
        return;
      }
      if (outcome.id && outcome.id !== this.sessionId) await this.switchTo(outcome.id);
      else await this.emitSession();
      if (outcome.prompt) {
        this.sentPrompt = outcome.prompt;
        await this.runTurn(this.requireSession(), outcome.prompt, { echo: outcome.echo !== false });
      }
    } catch (error) {
      const next = await afterTurnFailure(this.prompter, id, error, {
        line, sent: this.sentPrompt ?? line, guard: this.exhaustionGuard, ...(options.queuedTurnId ? { queuedTurnId: options.queuedTurnId } : {}),
      });
      if ('retry' in next) {
        await this.execute(next.retry, {});
        return;
      }
      if ('moved' in next) {
        await this.switchTo(next.moved.id);
        // No prompt: another window already carried this turn on there.
        if (next.moved.prompt !== undefined) await this.execute(next.moved.prompt, {});
        return;
      }
      if (next.waiting) {
        // The worker sends it at the reset; it hears of the parked turn now.
        this.worker?.client.send({ type: 'refresh' });
        this.channel.send({ type: 'notice', message: `${resumeWaitLabel(next.waiting)} · a new message cancels`, level: 'info' });
        void this.refreshUsage().catch(() => undefined);
        return;
      }
      if (next.back.length) this.channel.send({ type: 'restore-draft', text: next.back.join('\n\n') });
      this.report(error);
    } finally {
      await this.emitSession().catch(() => undefined);
    }
  }

  /** One turn through the conversation's worker, after what the terminal
   * does before one (prepareTurn). */
  private async runTurn(targetId: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> {
    // Carrying on an interrupted turn is not something the user typed.
    if (prompt === INTERRUPTED_TURN_REQUEST) turn = { ...turn, echo: false };
    await prepareTurn(targetId, (label) => this.channel.send({ type: 'busy', ...(label ? { label } : {}) }));
    await this.prepareRoute();
    const client = await this.workerFor(targetId);
    this.channel.send({ type: 'turn-start', sessionId: targetId, ...(turn.echo ? { prompt } : {}), ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
    try {
      await new Promise<void>((resolve, reject) => {
        this.turnWaiter = { resolve, reject };
        client.send({ type: 'submit', text: prompt, echo: turn.echo, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
      });
    } catch (error) {
      throw error instanceof TurnFailed ? error : new TurnFailed(messageOf(error));
    }
  }

  /** A line typed between turns: the terminal's routing (dispatchLine), with
   * the editor's widgets where the terminal draws its own. */
  private async dispatch(line: string, fromQueuedCommand: boolean): Promise<InteractiveSlashOutcome> {
    const id = this.requireSession();
    // `!<command>`: run here, its output a transcript message for next turn.
    if (isShellCommandLine(line)) {
      return this.withBusy(line, async () => {
        // Quiet: its result payload repeats the transcript message the chat
        // already shows, and would be drawn a second time as an output card.
        this.quietOutput += 1;
        try {
          const resulting = await aiSessionCommand(id, line);
          return resulting !== id ? { id: resulting } : {};
        } finally { this.quietOutput -= 1; }
      });
    }
    return dispatchLine(this.slashHost, id, line, { fromQueuedCommand });
  }

  private async withBusy<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.channel.send({ type: 'busy', label });
    try { return await work(); } finally { this.channel.send({ type: 'busy' }); }
  }

  /** The editor as the screen a slash command runs for. */
  private createSlashHost(): SlashHost {
    return {
      config: this.config,
      prompter: this.prompter,
      canPick: true,
      pickProviderBeforeSending: true,
      panel: (_kind, title, body) => this.prompter.panel(title, body),
      withBusy: (label, work) => this.withBusy(label, work),
      ask: (label) => this.prompter.question(label),
      redraw: () => this.emitSession(),
      runTurn: (targetId, prompt) => this.runTurn(targetId, prompt, { echo: false }),
      openConversationPicker: async (id) => {
        const picked = await interactiveSessionPicker(this.prompter, id);
        if (picked && 'new' in picked) return { id: await newConversation(id) };
        return { id: picked?.id ?? id };
      },
      editFile: async (path) => {
        if (!existsSync(path)) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, '', { flag: 'a' });
        }
        this.channel.send({ type: 'open-file', path });
      },
      runManager: (harness, label, argv, environment) =>
        this.runInTerminal({ command: harness.command, mode: 'run', argv }, { environment, name: `${harness.displayName} ${label}` }),
      exported: (path) => this.channel.send({ type: 'open-file', path }),
    };
  }

  /** The editor's screens as data (queries.ts). Answered straight away, not
   * behind the work queue: a list must open while a turn is running. */
  private async query(requestId: string, query: IdeQueryName, options: { provider?: string; network?: boolean }): Promise<void> {
    const answer = (data: unknown): void => this.channel.send({ type: 'result', requestId, ok: true, data });
    try {
      // Every screen lists from the index; only the open chat's history is read.
      const state = await readState({ transcripts: query === 'conversations' || !this.sessionId ? [] : [this.sessionId] });
      const session = this.sessionId ? state.sessions.find((item) => item.id === this.sessionId) : undefined;
      switch (query) {
        case 'slash-commands': {
          const { session: current } = await this.current();
          const harness = sessionHarness(current);
          // The terminal palette's own values (withArgValues): the vendor
          // lists fill in as they load, so a later query has more.
          const rows: PaletteEntry[] = withArgValues(slashPalette(current, harness, slashExtrasFor(current, harness)), current, harness, state);
          answer(rows.map((row) => {
            const values = row.argValues?.();
            return {
              command: row.value, description: row.detail ?? '', ...(row.argHint ? { argHint: row.argHint } : {}), group: row.group,
              ...(row.aliases?.length ? { aliases: row.aliases } : {}), ...(values?.length ? { argValues: values } : {}),
            } satisfies IdeSlashCommand;
          }));
          return;
        }
        case 'providers': answer(await providerList(this.config, state, session)); return;
        case 'models':
          if (!options.provider) throw new Error('models needs a provider');
          answer(await modelList(this.config, state, session, options.provider));
          return;
        case 'conversations':
          if (state.sessions.some((item) => !item.listChecked)) void backfillListFacts();
          answer(await conversationList(state, this.sessionId));
          return;
        case 'accounts': answer(await accountList(state, session, Boolean(options.network))); return;
        case 'chat-settings': answer(session ? await chatSettings(state, session) : {}); return;
        case 'gateway': answer(await gatewayStatus(this.config)); return;
        default: throw new Error(`unknown query "${String(query)}"`);
      }
    } catch (error) {
      this.channel.send({ type: 'result', requestId, ok: false, error: messageOf(error) });
    }
  }

  /** A choice made in the editor's own widgets, applied with the command the
   * terminal's picker ends in. A setting that can change mid-turn does so
   * (commandDuringTurn); anything that moves the conversation waits for no
   * turn, and says so. */
  private async choose(requestId: string, choice: IdeChoice): Promise<void> {
    const done = (data?: unknown): void => this.channel.send({ type: 'result', requestId, ok: true, ...(data === undefined ? {} : { data }) });
    const failed = (error: unknown): void => this.channel.send({ type: 'result', requestId, ok: false, error: messageOf(error) });
    const quietly = async <T>(job: () => Promise<T>): Promise<T> => {
      this.quietOutput += 1;
      try { return await job(); } finally { this.quietOutput -= 1; }
    };
    const setting = async (line: string): Promise<void> => {
      const id = this.requireSession();
      await quietly(async () => { if (this.workerTurnRunning) await commandDuringTurn(id, line); else await aiSessionCommand(id, line); });
      await this.emitSession();
    };
    const queued = (job: () => Promise<unknown>): void => {
      this.enqueue(async () => {
        try { done(await quietly(job)); } catch (error) { failed(error); }
      });
    };
    try {
      switch (choice.kind) {
        case 'model': {
          const { session } = await this.current();
          const line = session.route === 'clikcode-local' ? `/model --download ${choice.model}` : `/model ${choice.model}`;
          await setting(line);
          done();
          return;
        }
        case 'agent': {
          // The terminal picker's own step: the chat stays on the Gateway and its next turn runs as
          // the agent; a different agent starts a fresh agent thread.
          await selectGatewayAgent(this.requireSession(), choice.agent ?? undefined);
          await this.emitSession();
          done();
          return;
        }
        case 'effort': await setting(`/effort ${choice.value}`); done(); return;
        case 'permissions': await setting(`/permissions ${choice.value}`); done(); return;
        case 'failover': await setting(`/accounts failover ${choice.value}`); done(); return;
        case 'account': await setting(`/settings account ${choice.accountId}`); done(); return;
        case 'fast': await setting(`/fast ${choice.on ? 'on' : 'off'}`); done(); return;
        case 'swarm': {
          const on = typeof choice.enabled === 'boolean' ? choice.enabled : (choice.names?.length ?? 0) > 0;
          await setting(on ? '/swarm on' : '/swarm off');
          done();
          return;
        }
        case 'plan': {
          const { session } = await this.current();
          const harness = sessionHarnessDefinition(session);
          if (!harness?.planMode) throw new Error('This provider has no plan mode.');
          const on = harness.planMode.value === true ? 'on' : String(harness.planMode.value);
          await setting(`/settings option ${harness.planMode.option} ${choice.on ? on : 'default'}`);
          done();
          return;
        }
        case 'provider': {
          if (this.workerTurnRunning) throw new Error('A turn is running: stop it or wait for it to finish before switching provider.');
          queued(async () => {
            const id = this.requireSession();
            const moved = await selectProviderConversation(this.config, this.prompter, id, providerConversationKey(choice.provider));
            if (choice.model) {
              const { session } = await this.current(moved);
              await aiSessionCommand(moved, session.route === 'clikcode-local' ? `/model --download ${choice.model}` : `/model ${choice.model}`);
            } else await resolveSessionModel(moved);
            // A sign-in let the queue go: the user may have opened another
            // chat meanwhile, and keeps it.
            if (this.sessionId !== id) return { sessionId: moved };
            if (moved !== id) await this.switchTo(moved);
            await this.prepareRoute().catch(() => undefined);
            await this.emitSession();
            void this.refreshUsage().catch(() => undefined);
            return { sessionId: this.sessionId };
          });
          return;
        }
        case 'add-account':
          queued(async () => {
            const harness = localHarnessForCommand(choice.provider);
            if (!harness) throw new Error(`unknown provider "${choice.provider}"`);
            const added = await addAccountForHarness(this.prompter, harness);
            if (added && this.sessionId) {
              const { session } = await this.current();
              if (session.provider === harness.provider || session.nativeHarness === harness.command) await useAddedAccount(session.id, harness, added);
              await this.emitSession();
            }
            return { added: added ?? null };
          });
          return;
        case 'account-action':
          queued(async () => {
            await manageAccountAction(this.prompter, choice.accountId, choice.action);
            await this.emitSession().catch(() => undefined);
          });
          return;
        case 'conversation': {
          const current = choice.sessionId === this.sessionId;
          if (current && this.workerTurnRunning && choice.action === 'delete') {
            throw new Error('A turn is running in this conversation: stop it first.');
          }
          queued(async () => {
            // Putting away the open chat lands on a fresh one with its setup,
            // as the terminal's list does; made before, while there is a setup.
            const replacement = current && choice.action === 'delete' ? await newConversation(choice.sessionId) : undefined;
            if (choice.action === 'rename') {
              const name = choice.name?.trim();
              if (!name) throw new Error('A name is needed.');
              await aiSessionCommand(choice.sessionId, `/rename ${name}`);
            } else await aiSessionCommand(choice.sessionId, '/delete confirm');
            if (replacement) await this.switchTo(replacement);
            else if (this.sessionId) await this.emitSession();
            return { sessionId: this.sessionId };
          });
          return;
        }
        case 'gateway-credit': done({ url: await gatewayCheckoutUrl(this.config) }); return;
        default: throw new Error(`unknown choice "${String((choice as { kind?: unknown }).kind)}"`);
      }
    } catch (error) {
      failed(error);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) channel.send({ type: 'output', payload: payload as Record<string, unknown> });
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
