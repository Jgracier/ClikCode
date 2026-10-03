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
 * command that moves the conversation (/new, a handoff, /resume) switches too.
 */
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
import { latestChat, chatNamed } from '../session/options.js';
import { SESSION_CLAIM_TTL_MS } from '../session/claim.js';
import { claimConversation, leaveConversation } from '../session/attach.js';
import { ensureSessionOnDisk } from '../session/blank.js';
import { embeddedImagePaths, expandHomePath, queueAttachment, resolveStandaloneAttachment } from '../session/attachments.js';
import { compactPath } from '../harness/protocol/labels.js';
import { consumeSessionTurn } from '../turn/checkpoint.js';
import { synchronizeNativeTranscript } from '../turn/handoff.js';
import { turnEnvironment } from '../turn/turn-environment.js';
import { isUsageExhaustedMessage } from '../turn/usage-exhausted.js';
import { localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { nativeUsageReading } from '../harness/accounts/account-usage.js';
import { usageResetLabel } from '../harness/accounts/usage-reading.js';
import { setVendorSignInRunner, type VendorSignInRequest } from '../harness/transport/native/login.js';
import { launchSession, aiSessionLeave } from '../commands/ai/sessions.js';
import { newConversation, newProviderConversation, releaseQueuedTurn } from '../commands/ai/conversations.js';
import { aiHarnessSelect } from '../commands/ai/harness.js';
import { setHarnessInstallReporter, type HarnessInstallReporter } from '../harness/transport/native/install.js';
import { ensureTurboFitForTurn } from '../commands/ai/turbofit.js';
import { ensureLocalModelForTurn, reconcileLocalModelLeases } from '../commands/ai/local-model.js';
import { isShellCommandLine } from '../commands/ai/shell-run.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { routeSlashInput, slashPalette, unknownSlashMessage, type SlashHandlerKey } from '../tui/slash/registry.js';
import { customCommandsFor, sessionHarness, slashExtrasFor, slashRouteContextFor } from '../tui/slash/context.js';
import { commandDuringTurn, enqueueCommandLine, slashLineIsCommand } from '../tui/slash/queue.js';
import { withArgValues } from '../tui/slash/arg-values.js';
import type { PaletteEntry } from '../tui/command-palette.js';
import { impliedHarnessCommand } from '../tui/slash/infer-provider.js';
import type { InteractiveSlashHandlerKey, InteractiveSlashOutcome } from '../tui/slash/interactive-keys.js';
import { customCommandPrompt } from '../session/custom-commands.js';
import { capabilitiesText } from '../tui/slash/capabilities-text.js';
import { compactConversation } from '../tui/slash/compact.js';
import { exportTranscript } from '../tui/slash/export-transcript.js';
import { initPrompt, readMemoryFile, reviewPrompt } from '../tui/slash/memory.js';
import { nativeManagerListing } from '../tui/slash/native-manager.js';
import { doctorSummary } from '../tui/doctor-summary.js';
import { chooseOption } from '../tui/pickers/choose.js';
import { autoSelectSessionHarness, interactiveEnginePicker } from '../tui/pickers/engine.js';
import { addAccountForHarness, interactiveAccountPicker, manageAccountAction, useAddedAccount } from '../tui/pickers/account.js';
import { interactiveModelPicker } from '../tui/pickers/model.js';
import { interactiveEffortPicker } from '../tui/pickers/effort.js';
import { interactivePermissionPicker } from '../tui/pickers/permissions.js';
import { interactiveHarnessOptionPicker } from '../tui/pickers/options.js';
import { interactiveToolsPicker } from '../tui/pickers/tools.js';
import { interactiveSettingsPicker } from '../tui/pickers/settings.js';
import { interactiveSwarmPicker } from '../tui/pickers/swarm.js';
import { interactiveSessionPicker } from '../tui/pickers/session.js';
import { carryOnAfterExhaustion, type ExhaustionRetryGuard } from '../tui/pickers/resume-in.js';
import { INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt.js';
import { WorkerClient } from '../worker/client.js';
import { currentWorkerBuild, readWorkerRecord, workerIsReachable } from '../worker/registry.js';
import type { WorkerEvent } from '../worker/protocol.js';
import { IdePrompter, type IdeChannel } from './prompter.js';
import { watchConversationList, type ListWatch } from '../session/list-watch.js';
import { encodeTerminalSpec, IDE_PROTOCOL, type IdeChoice, type IdeEvent, type IdeQueryName, type IdeRequest, type IdeSlashCommand, type IdeTerminalSpec } from './protocol.js';
import { sessionEvent } from './session-event.js';
import { selectProviderConversation } from '../tui/pickers/conversation.js';
import {
  accountList, chatSettings, conversationList, gatewayCheckoutUrl, gatewayStatus, GATEWAY_ID, LOCAL_ID, modelList, providerList,
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
  /** A setting chosen in the editor's own widget is on screen there already:
   * its "Model set to …" confirmation is not said again in the chat. */
  quietOutput = 0;

  constructor(private readonly config: Conf, private readonly channel: IdeChannel) {
    this.prompter = new IdePrompter(channel);
  }

  start(): void {
    setVendorSignInRunner((request) => this.runInTerminal({ command: request.command, mode: 'login', argv: request.argv }, request));
    const claim = setInterval(() => { if (this.sessionId) void claimConversation(this.sessionId).catch(() => undefined); }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
    const usage = setInterval(() => { void this.refreshUsage().catch(() => undefined); }, USAGE_REFRESH_MS);
    claim.unref();
    usage.unref();
    this.timers.push(claim, usage);
    this.channel.send({ type: 'ready', version: CLIKCODE_VERSION, protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.revision, ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}), pid: process.pid });
  }

  handle(request: IdeRequest): void {
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

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listWatch?.stop();
    this.listWatch = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.prompter.cancelAll();
    for (const pending of this.signIns.values()) pending.reject(new Error('the editor closed'));
    this.signIns.clear();
    setVendorSignInRunner(undefined);
    this.detachWorker();
    await reconcileLocalModelLeases(undefined).catch(() => undefined);
    if (this.sessionId) await leaveConversation(this.sessionId);
  }

  private enqueue(job: () => Promise<void>): void {
    this.work = this.work.then(job).catch((error: unknown) => this.report(error));
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
  }

  // ---- conversations -------------------------------------------------------

  private async open(workspace: string, mode: 'new' | 'continue' | 'resume', ref?: string): Promise<void> {
    const state = await readState({ transcripts: ref ? [ref] : [] });
    let session: HarnessSession | undefined;
    if (mode === 'resume') {
      if (!ref) throw new Error('resume needs a conversation id');
      const id = state.sessions.some((item) => item.id === ref) ? ref : chatNamed(state.sessions, ref, '');
      session = id ? state.sessions.find((item) => item.id === id) : undefined;
      if (!session) throw new Error(`no chat matches "${ref}"`);
    } else if (mode === 'continue') {
      session = latestChat(state.sessions.filter((item) => item.status !== 'archived'), workspace);
      if (session && session.workspace !== workspace) session = undefined;
    }
    if (!session) {
      session = launchSession(state, workspace);
      state.sessions.push(session);
    }
    if (session.status !== 'active') {
      session.status = 'active';
      session.closedAt = undefined;
      session.updatedAt = new Date().toISOString();
    }
    await writeState(state);
    const id = session.id;
    // As a terminal does on open: a conversation with no provider gets the one
    // the user is signed in to, without asking; with none, the first message
    // or /provider asks.
    if (!session.nativeHarness && !isClikCodeAgent(session)) await autoSelectSessionHarness(id).catch(() => false);
    await this.resolveModel(id);
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

  private async resolveModel(id: string): Promise<void> {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (!session || session.model) return;
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    if (!harness) return;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    const resolved = await resolveNativeModel(harness, account).catch(() => undefined);
    if (!resolved) return;
    session.model = resolved;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }

  private async switchTo(id: string): Promise<void> {
    const previous = this.sessionId;
    if (previous && previous !== id) {
      if (this.worker?.sessionId === previous) this.worker.client.send({ type: 'release' });
      this.detachWorker();
      await leaveConversation(previous);
    }
    this.sessionId = id;
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
    this.channel.send({ type: 'usage', ...(reading?.label ? { label: reading.label } : {}), ...(usageResetLabel(reading?.windows) ? { reset: usageResetLabel(reading?.windows) } : {}) });
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
        void this.runInTerminal({ command: event.command, mode: 'login', argv: event.argv }, { environment: event.environment, name: event.name })
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

  private runInTerminal(spec: IdeTerminalSpec, request: Pick<VendorSignInRequest, 'environment' | 'name'>): Promise<void> {
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
    for (let guard = 0; guard < 100 && !this.closed && this.sessionId; guard += 1) {
      const state = await readState({ transcripts: [this.sessionId!] });
      const session = state.sessions.find((item) => item.id === this.sessionId);
      const queued = session?.queuedTurns?.[0];
      if (!session || !queued) return;
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
      const message = messageOf(error);
      const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
      // A queued turn that cannot start would otherwise stay at the head of
      // the queue and fail identically forever.
      if (options.queuedTurnId && !cancelled) await releaseQueuedTurn(id, options.queuedTurnId).catch(() => undefined);
      /** What goes back to the composer: a queued message that was not
       * carried on, and any queued behind it that could not run either. */
      let back = options.queuedTurnId && !cancelled ? [line] : [];
      if (!cancelled && isUsageExhaustedMessage(message)) {
        // Out of usage on every account here, a queued message as much as a
        // typed one: once more on this provider if an account came back,
        // otherwise the harnesses that still have some.
        const next = await carryOnAfterExhaustion(this.prompter, id, line, this.exhaustionGuard, this.sentPrompt ?? line);
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
        back = [...back, ...next.stayed];
      }
      if (back.length) this.channel.send({ type: 'restore-draft', text: back.join('\n\n') });
      this.report(error);
    } finally {
      await this.emitSession().catch(() => undefined);
    }
  }

  /** One turn through the conversation's worker, with what the terminal does
   * around it: a TurboFit or ClikCode Local model is up first, held by this
   * client rather than the worker. */
  private async runTurn(targetId: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> {
    // Carrying on an interrupted turn is not something the user typed.
    if (prompt === INTERRUPTED_TURN_REQUEST) turn = { ...turn, echo: false };
    const state = await readState({ transcripts: [targetId] });
    const active = state.sessions.find((item) => item.id === targetId);
    const harness = active?.nativeHarness ? localHarnessForCommand(active.nativeHarness) : undefined;
    if (active && harness) {
      this.channel.send({ type: 'busy', label: 'preparing…' });
      try {
        await ensureTurboFitForTurn(harness, state.accounts.find((item) => item.id === active.accountId), targetId, active.model);
      } finally { this.channel.send({ type: 'busy' }); }
    }
    if (active?.route === 'clikcode-local') {
      this.channel.send({ type: 'busy', label: 'loading the local model…' });
      try { await ensureLocalModelForTurn(active); } finally { this.channel.send({ type: 'busy' }); }
    }
    // Blank chats live only in this process. The worker is a separate process
    // and must be able to read the chat before it can accept the first turn.
    await ensureSessionOnDisk(targetId);
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

  /** A line typed between turns: the interactive loop's routing, with the
   * editor's pickers where the terminal draws its own. */
  private async dispatch(line: string, fromQueuedCommand: boolean): Promise<InteractiveSlashOutcome> {
    const id = this.requireSession();
    const rl = this.prompter;
    const viaHeadless = async (text: string): Promise<InteractiveSlashOutcome> => {
      const resulting = await aiSessionCommand(id, text);
      return resulting !== id ? { id: resulting } : {};
    };
    const { session } = await this.current(id);
    const workspace = session.workspace ?? process.cwd();
    // `!<command>`: run here, its output a transcript message for next turn.
    if (isShellCommandLine(line)) {
      this.channel.send({ type: 'busy', label: line });
      try { return await viaHeadless(line); } finally { this.channel.send({ type: 'busy' }); }
    }
    const attachment = await resolveStandaloneAttachment(line, workspace);
    if (attachment) {
      const state = await readState({ transcripts: [id] });
      const target = state.sessions.find((item) => item.id === id);
      if (!target) throw new Error(`AI session "${id}" was not found`);
      await queueAttachment(target, attachment);
      target.updatedAt = new Date().toISOString();
      await writeState(state);
      return { notice: `Attached ${compactPath(attachment)} for the next request` };
    }
    const commandState = await readState();
    const commandSession = commandState.sessions.find((item) => item.id === id);
    if (!commandSession) throw new Error(`AI session "${id}" was not found`);
    const harness = sessionHarness(commandSession);
    const route = routeSlashInput(line, slashRouteContextFor(commandSession, harness, (path) => existsSync(expandHomePath(path))));
    if (route.kind === 'prompt') {
      const images = await embeddedImagePaths(route.prompt, workspace);
      if (images.length) {
        for (const image of images) await queueAttachment(commandSession, image).catch(() => undefined);
        await writeState(commandState);
      }
      if (!commandSession.nativeHarness && !isClikCodeAgent(commandSession)) {
        // Nothing chosen yet: choosing is the first step of sending.
        const chosen = await interactiveEnginePicker(this.config, rl, id) ?? id;
        return { id: chosen, ...(await this.hasHarness(chosen) ? { prompt: route.prompt, echo: true } : { notice: 'Choose a provider to send this.' }) };
      }
      return { prompt: route.prompt, echo: true };
    }
    if (route.kind === 'native') {
      if (isClikCodeAgent(commandSession)) throw new Error('Native harness commands apply only to local harnesses.');
      return { prompt: route.prompt, echo: true };
    }
    if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
    if (route.kind === 'custom') {
      const custom = customCommandsFor(commandSession, harness).find((item) => item.name === route.name);
      if (!custom) throw new Error(`custom command /${route.name} is no longer available`);
      return { prompt: customCommandPrompt(custom, route.args, harness), echo: false };
    }
    if (route.kind === 'harness') {
      const selected = await newProviderConversation(id, route.command);
      return { id: selected, ...(route.args ? { prompt: route.args, echo: true } : {}) };
    }
    if (route.kind === 'manager') {
      const manager = harness ? (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] } | undefined> | undefined)?.[route.name] : undefined;
      if (!harness || !manager) throw new Error('Choose a provider first.');
      if (manager.listArgv) {
        this.channel.send({ type: 'busy', label: `loading ${manager.label}…` });
        try {
          const listing = await nativeManagerListing(commandState, commandSession, route.name);
          rl.panel(listing.label, listing.text);
        } finally { this.channel.send({ type: 'busy' }); }
      } else if (manager.manageArgv) {
        const account = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
        await this.runInTerminal({ command: harness.command, mode: 'run', argv: manager.manageArgv }, { environment: turnEnvironment(harness, account), name: `${harness.displayName} ${manager.label}` });
      }
      return {};
    }
    const availability = route.entry.availability(commandSession, harness);
    if (!availability.available && availability.needs === 'provider' && !fromQueuedCommand) {
      const commandLine = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
      const implied = impliedHarnessCommand(route, commandState.accounts, localHarnessForProvider);
      if (implied) {
        await aiHarnessSelect(implied, id);
        await enqueueCommandLine(id, commandLine);
        return {};
      }
      const chosen = await interactiveEnginePicker(this.config, rl, id) ?? id;
      if (await this.hasHarness(chosen)) await enqueueCommandLine(chosen, commandLine);
      return { id: chosen };
    }
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const text = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
    const { args } = route;
    const openConversationPicker = async (): Promise<InteractiveSlashOutcome> => {
      const picked = await interactiveSessionPicker(rl, id);
      if (picked && 'new' in picked) return { id: await newConversation(id) };
      return { id: picked?.id ?? id };
    };
    const interactive: Record<InteractiveSlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>> = {
      exit: async () => { await aiSessionLeave(id); return { exit: true }; },
      new: async () => ({ id: await newConversation(id), ...(args ? { prompt: args, echo: true } : {}) }),
      redraw: async () => { await this.emitSession(); },
      provider: async () => ({ id: await interactiveEnginePicker(this.config, rl, id) ?? id }),
      accounts: async () => {
        const [action, name] = args.split(/\s+/);
        const target = (action === 'login' || action === 'add') && name ? localHarnessForCommand(name.toLowerCase()) : undefined;
        if (target?.surface === 'terminal') {
          const added = await addAccountForHarness(rl, target);
          if (added && target.provider === commandSession.provider) await useAddedAccount(id, target, added);
          return {};
        }
        return args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id };
      },
      model: async () => args ? viaHeadless(text) : interactiveModelPicker(rl, id),
      effort: async () => args ? viaHeadless(text) : interactiveEffortPicker(rl, id),
      permissions: async () => args ? viaHeadless(text) : interactivePermissionPicker(rl, id),
      swarm: async () => (args ? viaHeadless(text) : interactiveSwarmPicker(rl, id)),
      options: async () => interactiveHarnessOptionPicker(rl, id),
      capabilities: async () => {
        const [title = 'Capabilities', ...rest] = capabilitiesText(commandSession).split('\n');
        rl.panel(title, rest.join('\n'));
      },
      settings: async () => {
        // `/settings tools`: straight to Tools & integrations (MCP servers, skills, agents).
        if (args.trim().toLowerCase() === 'tools') {
          if (!harness) throw new Error('Choose a provider first: tools and MCP servers belong to a harness.');
          await interactiveToolsPicker(rl, id, harness);
          return {};
        }
        return args ? viaHeadless(text) : { id: await interactiveSettingsPicker(this.config, rl, id) ?? id };
      },
      sessions: async () => (args ? viaHeadless(text) : openConversationPicker()),
      resume: async () => {
        const named = args ? chatNamed(commandState.sessions, args, id) : undefined;
        return named ? { id: named } : openConversationPicker();
      },
      rename: async () => {
        const name = args || (await rl.question('Conversation name')).trim();
        if (name) await aiSessionCommand(id, `/rename ${name}`);
      },
      archive: async () => { await aiSessionCommand(id, '/archive'); return { exit: true }; },
      delete: async () => {
        const confirmed = await chooseOption(rl, 'Delete this conversation?', [
          { label: 'Cancel', value: false }, { label: 'Delete this conversation', value: true },
        ]);
        if (!confirmed) return {};
        await aiSessionCommand(id, '/delete confirm');
        return { exit: true };
      },
      mention: async () => {
        const path = args || (await rl.question('File to attach')).trim();
        return path ? viaHeadless(`/mention ${path}`) : {};
      },
      review: async () => ({ prompt: reviewPrompt(args), echo: false }),
      init: async () => ({ prompt: initPrompt(commandSession), echo: false }),
      native: async () => {
        if (!args) throw new Error('usage: /native <text>  (or //text)');
        return { prompt: args, echo: true };
      },
      compact: async () => {
        const compacted = await compactConversation(id, commandSession, args, (targetId, promptText) => this.runTurn(targetId, promptText, { echo: false }));
        return typeof compacted === 'string' ? { id: compacted } : {};
      },
      export: async () => {
        const path = await exportTranscript(commandSession, args, async (existing) =>
          ['y', 'yes'].includes((await rl.question(`${compactPath(existing)} exists. Overwrite? [y/N]`)).trim().toLowerCase()));
        this.channel.send({ type: 'open-file', path });
        return { notice: `Transcript written to ${compactPath(path)}` };
      },
      memory: async () => {
        if (route.words[0]?.toLowerCase() !== 'edit') return viaHeadless(text);
        const memory = await readMemoryFile(commandSession);
        if (!existsSync(memory.path)) {
          await mkdir(dirname(memory.path), { recursive: true });
          await writeFile(memory.path, '', { flag: 'a' });
        }
        this.channel.send({ type: 'open-file', path: memory.path });
        return {};
      },
      doctor: async () => {
        this.channel.send({ type: 'busy', label: 'checking harnesses…' });
        try { rl.panel('ClikCode doctor', await doctorSummary(commandState)); } finally { this.channel.send({ type: 'busy' }); }
      },
      login: async () => {
        if (!harness) throw new Error('Choose a provider before signing in.');
        const account = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
        if (account?.authKind === 'vendor-cli' && (account.status !== 'ready' || account.verification)) {
          await manageAccountAction(rl, account.id, 'reauthenticate');
          return {};
        }
        const added = await addAccountForHarness(rl, harness);
        if (added) await useAddedAccount(id, harness, added);
        return {};
      },
      logout: async () => {
        if (!commandSession.accountId) throw new Error('This conversation has no account to sign out.');
        await manageAccountAction(rl, commandSession.accountId, 'disconnect');
        return {};
      },
    };
    const handler = (interactive as Partial<Record<SlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>>>)[route.entry.handlerKey];
    return (handler ? await handler() : await viaHeadless(text)) ?? {};
  }

  private async hasHarness(id: string): Promise<boolean> {
    const state = await readState({ transcripts: [] });
    const session = state.sessions.find((item) => item.id === id);
    return Boolean(session && (session.nativeHarness || isClikCodeAgent(session)));
  }

  /** The editor's screens as data (queries.ts). Answered straight away, not
   * behind the work queue: a list must open while a turn is running. */
  private async query(requestId: string, query: IdeQueryName, options: { provider?: string; network?: boolean }): Promise<void> {
    const answer = (data: unknown): void => this.channel.send({ type: 'result', requestId, ok: true, data });
    try {
      const state = await readState(query === 'conversations' ? { transcripts: [] } : undefined);
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
    const setting = async (line: string): Promise<void> => {
      const id = this.requireSession();
      this.quietOutput += 1;
      try {
        if (this.workerTurnRunning) await commandDuringTurn(id, line);
        else await aiSessionCommand(id, line);
      } finally { this.quietOutput -= 1; }
      await this.emitSession();
    };
    const queued = (job: () => Promise<unknown>): void => {
      this.enqueue(async () => {
        try { done(await job()); } catch (error) { failed(error); }
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
            const selected = choice.provider === GATEWAY_ID ? '__gateway__' : choice.provider === LOCAL_ID ? '__clikcode_local__' : choice.provider;
            this.quietOutput += 1;
            try {
              const moved = await selectProviderConversation(this.config, this.prompter, id, selected);
              if (moved !== this.sessionId) await this.switchTo(moved);
              if (choice.model) {
                const { session } = await this.current();
                await aiSessionCommand(session.id, session.route === 'clikcode-local' ? `/model --download ${choice.model}` : `/model ${choice.model}`);
              } else await this.resolveModel(this.requireSession());
            } finally { this.quietOutput -= 1; }
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
  process.on('disconnect', () => { void running.shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { void running.shutdown().finally(() => process.exit(0)); });
  running.start();
  await new Promise<void>(() => { /* lives as long as the channel */ });
}
