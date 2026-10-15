/** One chat: a ClikCode connection (`clikcode ide-bridge`), the ChatModel it
 * feeds, and the webviews showing it. The side bar is one chat; every editor
 * tab is another, each with its own bridge, so each shows its own
 * conversation -- the bridge is one conversation at a time, like a terminal. */
import { PAINT_COALESCE_MS } from '../../../src/harness/protocol/timings';
import { errorText, userError } from '../../../src/harness/protocol/errors';
import * as vscode from 'vscode';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeClient } from './bridge-client';
import type { WebviewSurface } from './chat-view';
import { diffModel } from './model-patch';
import { answeredApproval, applyEvent, connectionLost, conversationAttention, emptyModel, preparing, rejectedPrompt, submittingPrompt, takenBackText, withNote, typedDuringTurn, type ChatModel } from './model';
import type { IdeAccounts, IdeChatSettings, IdeConversation, IdeEvent, IdeFeature, IdeRequest, IdeProvider, IdeSlashCommand, IdeUiRequest, HarnessQuestionResult, WorkerEvent } from './protocol';
import { bridgeCommandMissing, bridgeCompatibility, tooOldToStartMessage, versionSkew, type Remedy } from './compat';
import { entryBuild, resolveRuntime, RuntimeError } from './runtime';
import { ChangeViews } from './controller/changes';
import { AutoReconnect, BuildWatcher } from './controller/reconnect';
import { deliver, TIMEOUT } from './controller/requests';
import { DiffDocuments, openSignInLink, runInTerminal } from './ui';
import type { FromWebview, ListedConversation, ToWebview, WebviewRequest } from './webview-protocol';
import { mentionFromUri, pastedReference, searchWorkspaceFiles } from './mentions';
import type { Mention } from './webview-protocol';

/** What this editor handles beyond the base protocol (protocol.ts IdeFeature). */
const IDE_FEATURES: readonly IdeFeature[] = ['copy', 'search-walk'];

export interface ControllerHost {
  log: vscode.OutputChannel;
  diffs: DiffDocuments;
  /** Opens a conversation (or a new one) in an editor tab of its own. */
  openInTab(sessionId?: string): Promise<void>;
  /** Brings the chat on screen; `keepFocus` leaves the keyboard where it is. */
  reveal(controller: ClikCodeController, keepFocus?: boolean): Promise<void>;
  /** Every open chat: the side bar's and each tab's. */
  chats(): readonly ClikCodeController[];
}

export class ClikCodeController implements vscode.Disposable {
  private bridge: BridgeClient | undefined;
  private model: ChatModel = emptyModel();
  private readonly changed = new vscode.EventEmitter<ChatModel>();
  readonly onDidChange = this.changed.event;
  /** Pickers drawn in a webview, and which one. */
  private readonly panelQuestions = new Map<string, WebviewSurface>();
  private readonly changes: ChangeViews;
  private readonly reconnect = new AutoReconnect();
  private readonly builds = new BuildWatcher(() => { void this.moveToNewBuild(); });
  /** Queued messages being taken back to edit, by id: their text goes back in
   * the composer when the worker answers `removed`. */
  private readonly takingBack = new Map<string, string>();
  private readonly surfaces = new Set<WebviewSurface>();
  private starting: Promise<void> | undefined;
  private restartingForBuild = false;
  private disposed = false;
  private postTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  /** A full read is pending in the coalesced refresh (refreshStructured). */
  private refreshFull = false;
  private refreshedFor = '';
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Pasted images: path -> sent in a message yet. */
  private readonly images = new Map<string, boolean>();
  private imageDir: Promise<string> | undefined;

  constructor(
    private readonly host: ControllerHost,
    /** What opens first: the setting's choice, or a conversation asked for. */
    private readonly first: { mode: 'new' | 'continue' | 'resume'; sessionId?: string } | undefined,
    readonly label: string,
  ) {
    this.changes = new ChangeViews(host.diffs, () => this.model, () => this.workspaceFolder(), (text) => { void this.fail(text); });
  }

  get state(): ChatModel {
    return this.model;
  }

  get visible(): boolean {
    return [...this.surfaces].some((surface) => surface.visible);
  }

  get lastFocusedAt(): number {
    return Math.max(0, ...[...this.surfaces].map((surface) => surface.lastFocusedAt));
  }

  get focused(): boolean {
    return [...this.surfaces].some((surface) => surface.focused);
  }

  // ---- surfaces --------------------------------------------------------------

  attach(surface: WebviewSurface): vscode.Disposable {
    this.surfaces.add(surface);
    this.visibilityChanged();
    return new vscode.Disposable(() => {
      this.surfaces.delete(surface);
      this.visibilityChanged();
      for (const [id, owner] of [...this.panelQuestions]) {
        if (owner !== surface) continue;
        this.panelQuestions.delete(id);
        this.bridge?.send({ type: 'ui-response', id, result: { cancelled: true } });
      }
    });
  }

  /** What the bridge was last told of `visible`: only a chat on screen
   * polls its usage (ide/protocol.ts `visible`). */
  private shownToBridge: boolean | undefined;

  /** A surface was shown, hidden, attached or closed. */
  visibilityChanged(): void {
    const visible = this.visible;
    if (!this.bridge || visible === this.shownToBridge) return;
    this.shownToBridge = visible;
    this.bridge.send({ type: 'visible', visible });
  }

  /** The surface one-off messages go to: the focused one, else the most
   * recently focused visible one, else any. */
  private front(): WebviewSurface | undefined {
    const all = [...this.surfaces];
    return all.find((surface) => surface.focused)
      ?? all.filter((surface) => surface.visible).sort((left, right) => right.lastFocusedAt - left.lastFocusedAt)[0]
      ?? all[0];
  }

  post(message: ToWebview): void {
    this.front()?.post(message);
  }

  /** Test hook: the front surface's DOM. */
  probe(action: 'query' | 'click' | 'type' | 'key' | 'paste', selector: string, text?: string): Promise<unknown> {
    const surface = this.front();
    if (!surface) return Promise.reject(new Error('no chat surface is open'));
    return surface.probe(action, selector, text);
  }

  private setModel(next: ChatModel): void {
    if (next === this.model) return;
    const previous = this.model;
    this.model = next;
    this.changed.fire(next);
    this.schedulePost();
    // Only a turn the worker says is over has ended: a bridge that died or is
    // reconnecting says nothing about the turn, which runs on in the worker.
    if (previous.running && !next.running && next.connection === 'ready') {
      this.turnEnded();
      this.dropSentImages(next);
    }
    if (next.connection === 'ready' && next.sessionId) {
      const key = [next.sessionId, next.providerId, next.model, next.account, next.effort, next.permissions].join('|');
      if (key !== this.refreshedFor) {
        this.refreshedFor = key;
        this.refreshStructured(false);
      }
    }
  }

  /** Coalesced: a stream of deltas repaints at most every PAINT_COALESCE_MS,
   * as the terminal paints. */
  private schedulePost(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      for (const surface of this.surfaces) this.postModel(surface);
    }, PAINT_COALESCE_MS);
  }

  /** The model to one page: whole the first time, then only what changed
   * since (see model-patch.ts). */
  private postModel(surface: WebviewSurface): void {
    const sent = surface.sentModel;
    if (!surface.ready || !sent) {
      surface.post({ type: 'model', model: this.model });
      if (surface.ready) surface.sentModel = this.model;
      return;
    }
    const patch = diffModel(sent, this.model);
    if (patch) surface.post({ type: 'patch', patch });
    surface.sentModel = this.model;
  }

  /** An image the agent has had its turn with is deleted, unless a queued
   * message still names it. */
  private dropSentImages(model: ChatModel): void {
    for (const [path, sent] of this.images) {
      if (!sent || model.queued.some((item) => item.text.includes(path))) continue;
      this.images.delete(path);
      void rm(path, { force: true });
    }
  }

  /** A turn finished while this chat was out of sight: marked unread (its
   * tab and the conversation list say so) until it is looked at. */
  private finishedUnseen = false;

  get unread(): boolean {
    if (this.finishedUnseen && this.visible) this.finishedUnseen = false;
    return this.finishedUnseen;
  }

  /** A turn finished out of sight: its tab and the conversation list mark it
   * unread. Nothing pops up -- the editor the user is in already shows it,
   * and a toast for every finished turn was noise. */
  private turnEnded(): void {
    if (!this.visible) this.finishedUnseen = true;
    void this.moveToNewBuild();
  }

  /** The composer footer's facts: this chat's setting choices, its provider,
   * its account and usage. Read after every change of conversation or
   * setting; `onlyAccount` (the bridge's `usage`, every 30 s) re-reads usage. */
  private refreshStructured(onlyAccount: boolean): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Coalesced, but a full read asked for stays full: a usage update right
    // after a chat opened turned it into an account-only read, so the chat's
    // settings (effort, permissions) were never read at all.
    if (!onlyAccount) this.refreshFull = true;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const full = this.refreshFull;
      this.refreshFull = false;
      void this.readStructured(!full);
    }, 120);
  }

  private async readStructured(onlyAccount: boolean): Promise<void> {
    const bridge = this.bridge;
    if (!bridge?.running) return;
    const sessionId = this.model.sessionId;
    const [settings, providers, accounts] = await Promise.all([
      onlyAccount ? Promise.resolve(this.model.chatSettings) : bridge.call<IdeChatSettings>({ type: 'query', query: 'chat-settings' }, TIMEOUT.structured).catch(() => undefined),
      onlyAccount ? Promise.resolve(undefined) : bridge.call<IdeProvider[]>({ type: 'query', query: 'providers' }, TIMEOUT.structured).catch(() => undefined),
      bridge.call<IdeAccounts>({ type: 'query', query: 'accounts' }, TIMEOUT.structured).catch(() => undefined),
    ]);
    if (this.model.sessionId !== sessionId) return;
    const provider = providers?.find((item) => item.current) ?? (onlyAccount ? this.model.provider : undefined);
    const currentAccount = accounts?.accounts.find((account) => account.current);
    this.setModel({
      ...this.model,
      ...(settings ? { chatSettings: settings } : {}),
      ...(provider ? { provider } : {}),
      currentAccount,
    });
  }

  /** The one native toast ClikCode shows: something waits on the user and the
   * chat is out of sight. One on screen shows the question already. */
  private askAttention(title: string, allow?: () => void): void {
    if (this.visible) return;
    void vscode.window.showInformationMessage(`ClikCode asks: ${title}`, ...(allow ? ['Allow', 'Show'] : ['Show'])).then((choice) => {
      if (choice === 'Allow') allow?.();
      else if (choice) void this.host.reveal(this);
    });
  }

  /** A failure of something the user just did: one error line in the chat
   * (opened if it was not showing), and in the log. */
  async fail(text: string): Promise<void> {
    this.host.log.appendLine(text);
    this.note(text, 'error');
    if (!this.visible) await this.host.reveal(this);
  }

  private note(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.setModel(withNote(this.model, { kind: 'notice', level, text }));
  }

  private workspaceFolder(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath ?? homedir();
  }

  // ---- the connection ----------------------------------------------------------

  /** Started on first use and restarted on demand; concurrent callers share
   * one start. */
  ensureStarted(): Promise<void> {
    // A start under way -- a reconnect, a move to a new build -- is waited
    // out: its bridge runs before it has opened the chat, and a message sent
    // to it then was lost.
    if (this.starting) return this.starting;
    if (this.bridge?.running) return Promise.resolve();
    const starting = this.start().finally(() => { if (this.starting === starting) this.starting = undefined; });
    this.starting = starting;
    return starting;
  }

  private async start(sessionToResume?: string): Promise<void> {
    if (this.disposed) return;
    const log = this.host.log;
    this.setModel({ ...this.model, connection: 'starting', connectionError: undefined, remedy: undefined });
    const settings = vscode.workspace.getConfiguration('clikcode');
    let runtime;
    try {
      runtime = await resolveRuntime({ path: settings.get<string>('path'), nodePath: settings.get<string>('nodePath') });
    } catch (error) {
      const message = errorText(error);
      log.appendLine(message);
      this.setModel({ ...this.model, connection: 'error', connectionError: message, remedy: error instanceof RuntimeError && error.kind === 'clikcode-missing' ? 'install' : undefined });
      return;
    }
    log.appendLine(`[${this.label}] Starting ${runtime.entry} (${runtime.entrySource}) with ${runtime.node} (${runtime.nodeSource})`);
    const bridge = BridgeClient.start(runtime, this.workspaceFolder());
    this.bridge = bridge;
    this.builds.watch(runtime.entry);
    const startLog: string[] = [];
    bridge.on('log', (line) => { log.appendLine(`[${this.label}] ${line}`); if (startLog.length < 200) startLog.push(line); });
    bridge.on('exit', ({ code, signal }) => {
      if (this.bridge !== bridge) return;
      log.appendLine(`[${this.label}] ClikCode exited (${signal ?? code})`);
      this.dropQuestions();
      if (this.disposed) return;
      // Back on its own when it had been ready (see AutoReconnect).
      if (this.reconnect.take(this.model.connection === 'ready')) {
        log.appendLine(`[${this.label}] reconnecting`);
        this.bridge = undefined;
        // The turn keeps its place on screen: the worker is still running it,
        // and the new bridge's snapshot says where it got to (and re-asks any
        // approval it is waiting on).
        this.setModel({ ...this.model, connection: 'starting', approvals: [], busy: undefined, signIn: undefined, connectionError: undefined });
        setTimeout(() => { if (!this.disposed && !this.bridge) void this.ensureStarted(); }, 500);
        return;
      }
      this.setModel(connectionLost(this.model, {
        connection: 'stopped',
        connectionError: code === 0 ? 'ClikCode stopped.' : `ClikCode stopped unexpectedly (${signal ?? `exit ${code}`}). See the log for details.`,
      }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ClikCode did not start within 60 seconds. See the log for details.')), TIMEOUT.start);
      bridge.on('event', (event) => {
        if (event.type === 'ready') {
          clearTimeout(timer);
          const compatibility = bridgeCompatibility(event);
          if (!compatibility.ok) {
            this.incompatible(bridge, compatibility.message, compatibility.remedy);
            reject(new Error(compatibility.message));
            return;
          }
          resolve();
        }
        this.onBridgeEvent(event);
        if (event.type === 'ready') {
          const skew = versionSkew(event);
          if (skew) log.appendLine(`[${this.label}] ${skew}`);
        }
      });
      bridge.once('exit', ({ code }) => {
        clearTimeout(timer);
        // stderr can still be arriving when the process has exited.
        void bridge.logDrained(1_000).then(() => {
          if (this.bridge === bridge && bridgeCommandMissing(startLog)) {
            const message = tooOldToStartMessage();
            this.incompatible(bridge, message, 'update-clikcode');
            reject(new Error(message));
            return;
          }
          reject(new Error(`ClikCode exited before it was ready (exit ${code}). See the log for details.`));
        });
      });
    });
    try {
      await ready;
      if (this.bridge !== bridge) return;
      this.shownToBridge = undefined;
      this.visibilityChanged();
      const resume = sessionToResume ?? this.model.sessionId ?? (this.first?.mode === 'resume' ? this.first.sessionId : undefined);
      const mode = resume ? 'resume' : this.first?.mode ?? settings.get<'continue' | 'new'>('startWith') ?? 'continue';
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(resume ? { sessionId: resume } : {}), features: IDE_FEATURES }).catch(async (error: unknown) => {
        // A new chat nothing was sent in was never stored: reconnecting (a
        // rebuild, clikcode.restart) has nothing to resume, and failing here
        // left the panel dead. It is still a new chat.
        if (!resume || !/no chat matches/.test(errorText(error))) throw error;
        await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode: 'new', features: IDE_FEATURES });
      });
    } catch (error) {
      if (this.bridge !== bridge) return; // replaced, or refused as incompatible (already reported)
      const message = errorText(error);
      log.appendLine(message);
      this.setModel({ ...this.model, connection: bridge.running ? 'ready' : 'error', connectionError: message });
      if (bridge.running) this.note(message, 'error');
    }
  }

  /** The bridge cannot drive this extension: stop it, and say why in the
   * chat's banner, which offers the update that fixes it. Not a toast as
   * well: it said the banner's words again, once for every open chat. */
  private incompatible(bridge: BridgeClient, message: string, remedy: Exclude<Remedy, 'install'>): void {
    if (this.bridge !== bridge) return;
    this.bridge = undefined;
    bridge.dispose();
    this.host.log.appendLine(message);
    this.setModel({ ...this.model, connection: 'error', running: false, connectionError: message, remedy });
  }

  async restart(): Promise<void> {
    const session = this.model.sessionId;
    const previous = this.bridge;
    this.bridge = undefined;
    previous?.dispose();
    const starting = this.start(session).finally(() => { if (this.starting === starting) this.starting = undefined; });
    this.starting = starting;
    await starting;
  }

  /** ClikCode was reinstalled since the bridge started: move onto the new
   * build while nothing is happening, so the worker is retired onto it too.
   * Watched for, never done in the way of a message: a send used to restart
   * the bridge first, and one stood 30 s before it went out. A running turn
   * moves when it ends (turnEnded). */
  private async moveToNewBuild(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || this.disposed || this.model.running || this.model.connection !== 'ready' || this.restartingForBuild) return;
    const now = entryBuild(bridge.runtime.entry);
    if (!now || !bridge.build || now === bridge.build) return;
    this.restartingForBuild = true;
    try {
      this.host.log.appendLine('ClikCode was updated; reconnecting on the new build.');
      await this.restart();
    } finally { this.restartingForBuild = false; }
  }

  /** Link sign-ins whose link this chat already opened. */
  private readonly openedSignIns = new Set<string>();

  private dropQuestions(): void {
    for (const [id, surface] of this.panelQuestions) surface.post({ type: 'ui-cancel', id });
    this.panelQuestions.clear();
  }

  private onBridgeEvent(event: IdeEvent): void {
    this.setModel(applyEvent(this.model, event));
    // `/send` changed how mid-turn messages go: the composer says so.
    if (event.type === 'output' && typeof event.payload.sendMode === 'string') this.refreshStructured(false);
    switch (event.type) {
      case 'ui-request':
        void this.ask(event.id, event.request);
        return;
      case 'ui-update':
        this.panelQuestions.get(event.id)?.post({ type: 'ui-update', id: event.id, items: event.items });
        return;
      case 'sign-in': {
        const bridge = this.bridge;
        if (!bridge) return;
        void runInTerminal({
          name: `sign in to ${event.name}`,
          node: bridge.runtime.node,
          args: [bridge.runtime.entry, 'ide-terminal', event.spec],
          env: { ...event.environment, ...bridge.runtime.env },
          cwd: this.model.workspace ?? this.workspaceFolder(),
        }).then(() => bridge.send({ type: 'sign-in-result', id: event.id }),
          (error: unknown) => bridge.send({ type: 'sign-in-result', id: event.id, error: errorText(error) }));
        return;
      }
      case 'sign-in-link':
        // Opened once, in this computer's browser: VS Code is always on a
        // computer, and over Remote-SSH openExternal still opens it here.
        if (event.url && !event.done && !this.openedSignIns.has(event.id)) {
          this.openedSignIns.add(event.id);
          openSignInLink(event.url);
        }
        if (event.done) this.openedSignIns.delete(event.id);
        return;
      case 'open-file':
        void vscode.window.showTextDocument(vscode.Uri.file(event.path), { preview: false });
        return;
      case 'restore-draft':
        this.setModel(rejectedPrompt(this.model));
        this.post({ type: 'setDraft', text: event.text });
        return;
      case 'usage':
        this.refreshStructured(true);
        return;
      case 'conversations-changed':
        for (const surface of this.surfaces) surface.post({ type: 'conversations-changed' });
        return;
      case 'copy':
        // This computer's clipboard, which Remote-SSH's bridge cannot reach.
        void vscode.env.clipboard.writeText(event.text);
        return;
      case 'search':
        this.post({ type: 'search', ...(event.focus ? { focus: event.focus } : {}) });
        return;
      case 'worker':
        this.onWorkerEvent(event.event);
        return;
      default:
        return;
    }
  }

  /** A terminal picker, drawn in the chat as a sheet: the chat is brought
   * on screen first when it is out of sight -- without the keyboard, which
   * stays in the editor the user is typing in (a question arriving mid-word
   * took the next keys, Enter included, as its answer). */
  private async ask(id: string, request: IdeUiRequest): Promise<void> {
    if (!this.front()?.visible) await this.host.reveal(this, true);
    const surface = this.front();
    if (!surface) {
      this.bridge?.send({ type: 'ui-response', id, result: { cancelled: true } });
      return;
    }
    this.panelQuestions.set(id, surface);
    surface.post({ type: 'ui-request', id, request });
  }

  /** The editor's stop-agents action. The worker names what it would stop; only a yes here stops them. */
  stopAgents(): void {
    this.deliver({ type: 'stop-agents', all: true }, 'Stop agents');
  }

  private async confirmStopAgents(text: string): Promise<void> {
    const yes = 'Stop agents';
    const answer = await vscode.window.showWarningMessage(text, { modal: true }, yes);
    if (answer === yes) this.deliver({ type: 'stop-agents', all: true, confirm: true }, 'Stop agents');
  }

  private onWorkerEvent(event: WorkerEvent): void {
    if (event.type === 'agents') {
      if (event.outcome === 'needs-confirm') void this.confirmStopAgents(event.text);
      else this.note(event.text, 'info');
      return;
    }
    if (event.type === 'request-closed') {
      this.changes.close(event.id);
      return;
    }
    if (event.type === 'question-request') {
      this.askAttention(event.request.title);
      return;
    }
    if (event.type === 'approval-request') {
      // One file opens beside the chat without the keyboard (preserveFocus).
      // Several open VS Code's multi-file changes editor, which always takes
      // the keyboard -- neither `vscode.changes` nor the editor behind it
      // takes a preserveFocus (VS Code 1.123) -- so those wait for the
      // card's diff button.
      if (event.preview?.diff?.length === 1 && vscode.workspace.getConfiguration('clikcode').get<boolean>('openDiffOnApproval', true)) void this.changes.viewApproval(event.id);
      this.askAttention(event.title, () => this.approve(event.id, true));
      return;
    }
    if (event.type === 'unqueued') {
      const text = takenBackText(this.takingBack, event);
      if (text !== undefined) this.post({ type: 'insert', text });
      return;
    }
    if (event.type === 'restore-draft') this.post({ type: 'setDraft', text: event.text });
    // A message typed during the turn that could not be sent comes back to
    // the composer, as the terminal restores it for editing.
    if (event.type === 'submission' && event.disposition === 'error') {
      const lost = this.model.submissions.find((item) => item.id === event.id);
      if (lost) this.post({ type: 'insert', text: lost.text });
    }
    if (event.type === 'waiting-stop') {
      this.changes.forgetAll();
    }
  }

  hasApproval(id: string): boolean {
    return this.model.approvals.some((approval) => approval.id === id);
  }

  viewDiff(id: string): Promise<void> {
    return this.changes.viewApproval(id);
  }

  // ---- what the user does --------------------------------------------------------

  async send(text: string, id = `${Date.now()}`): Promise<void> {
    // The worker may need to prepare a chat and spawn a vendor. Show the
    // user's message before any of that I/O, just as the terminal does.
    const prompt = text.trim();
    const ordinary = Boolean(prompt && !/^[!/]/.test(prompt));
    // Sent again while the first is still being prepared, it is a message to
    // that turn (steered or queued once it runs), never a second bubble.
    const during = this.model.running || preparing(this.model);
    if (ordinary && !during) this.setModel(submittingPrompt(this.model, prompt));
    const epoch = this.prepareEpoch;
    try { await this.ensureStarted(); }
    catch (error) {
      this.setModel(rejectedPrompt(this.model));
      if (ordinary) this.post({ type: 'setDraft', text });
      this.note(errorText(error), 'error');
      return;
    }
    const bridge = this.bridge;
    if (!bridge?.running || !this.model.sessionId) {
      this.setModel(rejectedPrompt(this.model));
      if (ordinary) this.post({ type: 'setDraft', text });
      this.note('ClikCode is not connected.', 'error');
      return;
    }
    // Stop was pressed while this was being prepared: it is not sent.
    if (epoch !== this.prepareEpoch) return;
    for (const path of this.images.keys()) if (text.includes(path)) this.images.set(path, true);
    if ((during || this.model.running) && !/^[/!]/.test(text.trim())) this.setModel(typedDuringTurn(this.model, id, text.trim()));
    if (!bridge.send({ type: 'send', text, id })) {
      this.setModel(rejectedPrompt(this.model));
      if (ordinary) this.post({ type: 'setDraft', text });
      this.note('ClikCode is not connected; your message was not sent.', 'error');
    }
  }

  private deliver(request: IdeRequest, what: string): boolean {
    return deliver(this.bridge, request, what, (text) => this.note(text, 'warning'));
  }

  /** Bumped by a Stop pressed before a turn exists: a send still being
   * prepared sees it and does not go out. */
  private prepareEpoch = 0;

  cancel(restoreDraft = true): void {
    if (preparing(this.model)) {
      // No turn yet: the prompt goes back to the composer and the send in
      // flight is dropped, so Stop works from the moment of sending.
      const text = this.model.pendingPrompt!;
      this.prepareEpoch += 1;
      this.setModel({ ...rejectedPrompt(this.model), submissions: [] });
      if (restoreDraft) this.post({ type: 'setDraft', text });
    }
    // "Stopping" is shown when the worker says it accepted the Stop.
    this.deliver({ type: 'cancel', restoreDraft, trigger: 'editor-stop' }, 'Stop');
  }

  /** A question answered, or dismissed (cancelled). */
  answerQuestion(id: string, result: HarnessQuestionResult): void {
    this.deliver({ type: 'question-response', id, result }, 'Your answer');
    this.setModel(answeredApproval(this.model, id, { outcome: result.kind === 'answered' ? 'answered' : 'declined' }));
  }

  /** `told`: denied with a note -- the words sent in its place, which the
   * settled row says (`↳ told: …`). */
  approve(id: string, approved: boolean | 'always', told?: string): void {
    // Esc and the keyboard commands name the first waiting item; for a
    // question that is a dismissal, never an answer.
    if (this.model.approvals.find((item) => item.id === id)?.question) {
      if (approved === false) this.answerQuestion(id, { kind: 'cancelled' });
      return;
    }
    this.deliver({ type: 'approval-response', id, approved }, 'Your answer');
    this.setModel(answeredApproval(this.model, id, {
      outcome: approved === false ? 'denied' : 'approved', ...(approved === 'always' ? { always: true } : {}), ...(told ? { told } : {}),
    }));
    this.changes.close(id);
  }

  async open(mode: 'new' | 'continue' | 'resume', sessionId?: string): Promise<void> {
    await this.ensureStarted();
    const bridge = this.bridge;
    if (!bridge?.running) return;
    try {
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(sessionId ? { sessionId } : {}), features: IDE_FEATURES });
    } catch (error) {
      this.note(errorText(error), 'error');
    }
  }

  async slashCommands(): Promise<IdeSlashCommand[]> {
    await this.ensureStarted();
    return (await this.bridge?.call<IdeSlashCommand[]>({ type: 'query', query: 'slash-commands' })) ?? [];
  }

  /** A webview's request, answered with a `response`. */
  private async answer(surface: WebviewSurface, id: string, request: WebviewRequest): Promise<void> {
    const reply = (ok: boolean, data?: unknown, error?: string): void => surface.post({ type: 'response', id, ok, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
    try {
      reply(true, await this.handle(request));
    } catch (error) {
      reply(false, undefined, errorText(error));
    }
  }

  private async handle(request: WebviewRequest): Promise<unknown> {
    switch (request.method) {
      case 'watchConversations':
        // No bridge yet: the list's slow poll covers it until one answers.
        this.bridge?.send({ type: 'watch-conversations', on: request.on });
        return undefined;
      case 'files':
        return searchWorkspaceFiles(request.text);
      case 'paste':
        return pastedReference(request.text);
      case 'mentions':
        return request.uris.flatMap((text) => {
          try {
            const uri = vscode.Uri.parse(text.trim(), true);
            return uri.scheme === 'file' ? [mentionFromUri(uri)] : [];
          } catch { return []; }
        });
      case 'openInTab':
        await this.host.openInTab(request.sessionId);
        return undefined;
      case 'open': {
        // A conversation another chat shows is brought up there, not opened twice.
        const other = request.mode === 'resume' ? this.host.chats().find((chat) => chat !== this && chat.state.sessionId === request.sessionId) : undefined;
        if (!other) break;
        await this.host.reveal(other);
        return undefined;
      }
      case 'saveImage': {
        // A directory of this chat's own (mkdtemp: 0700, a fresh name, so no
        // other user can read it or plant a link in it), emptied as each
        // image's turn ends and removed with the chat.
        this.imageDir ??= mkdtemp(join(tmpdir(), 'clikcode-vscode-images-'));
        const safe = request.name.replace(/[^\w.-]+/g, '_').slice(-60) || 'image.png';
        const path = join(await this.imageDir, `${Date.now().toString(36)}-${safe}`);
        await writeFile(path, Buffer.from(request.dataBase64, 'base64'), { mode: 0o600 });
        this.images.set(path, false);
        return path;
      }
      default:
        break;
    }
    await this.ensureStarted();
    const bridge = this.bridge;
    if (!bridge?.running) throw new Error('ClikCode is not connected.');
    if (request.method === 'open') {
      await this.open(request.mode, request.sessionId);
      return undefined;
    }
    if (request.method === 'query') {
      const data = await bridge.call({ type: 'query', query: request.query, ...(request.provider ? { provider: request.provider } : {}), ...(request.network ? { network: true } : {}) }, TIMEOUT.query);
      if (request.query !== 'conversations') return data;
      const others = this.host.chats().filter((chat) => chat !== this).map((chat) => ({ sessionId: chat.state.sessionId, approvals: chat.state.approvals.length, unread: chat.unread }));
      return (data as IdeConversation[]).map((row): ListedConversation => {
        const attention = conversationAttention(row.id, others);
        return attention ? { ...row, attention } : row;
      });
    }
    // A choice can take a sign-in or an install: no short deadline.
    const result = await bridge.call({ type: 'choose', choice: request.choice }, TIMEOUT.choose);
    this.refreshedFor = '';
    this.refreshStructured(false);
    return result;
  }

  onWebviewMessage(surface: WebviewSurface, message: FromWebview): void {
    switch (message.type) {
      case 'ready':
        // A page (re)loaded: it has no transcript yet.
        surface.sentModel = undefined;
        this.postModel(surface);
        void this.ensureStarted();
        return;
      case 'send':
        void this.send(message.text, message.id);
        return;
      case 'cancel':
        this.cancel(message.restoreDraft);
        return;
      case 'send-queued':
        this.bridge?.send({ type: 'send-queued' });
        return;
      case 'unqueue': {
        const text = message.edit ? this.model.queued.find((item) => item.id === message.id)?.text : undefined;
        if (text !== undefined) this.takingBack.set(message.id, text);
        this.bridge?.send({ type: 'unqueue', id: message.id });
        return;
      }
      case 'approve':
        this.approve(message.id, message.approved, message.told);
        return;
      case 'answerQuestion':
        this.answerQuestion(message.id, message.result);
        return;
      case 'viewDiff':
        void this.viewDiff(message.id);
        return;
      case 'change':
        void (message.action === 'view' ? this.changes.viewChange(message.key, message.userIndex) : this.changes.revertChange(message.key, message.userIndex));
        return;
      case 'turnChanges':
        void (message.action === 'view' ? this.changes.viewTurn(message.userIndex) : this.changes.revertTurn(message.userIndex));
        return;
      case 'request':
        void this.answer(surface, message.id, message.request);
        return;
      case 'ui-response':
        this.panelQuestions.delete(message.id);
        this.bridge?.send({ type: 'ui-response', id: message.id, result: message.result });
        return;
      case 'search-key':
        this.bridge?.send({ type: 'search-key', key: message.key });
        return;
      case 'command':
        if (message.command.startsWith('clikcode.')) {
          void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        return;
      case 'openLink':
        if (/^(https?:|mailto:)/i.test(message.href)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
        return;
      case 'signInOpen':
        openSignInLink(message.url);
        return;
      case 'signInCancel':
        this.bridge?.send({ type: 'sign-in-cancel', id: message.id });
        return;
      case 'signInAnswer':
        this.bridge?.send({ type: 'sign-in-answer', id: message.id, text: message.text });
        return;
      case 'log':
        this.host.log.appendLine(`[${this.label} page] ${message.text}`);
        return;
      case 'openFile':
        void openWorkspaceFile(message.path, message.line, this.model.workspace ?? this.workspaceFolder()).catch(() => this.fail(userError(`open ${message.path}`)));
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.builds.stop();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.postTimer) clearTimeout(this.postTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.dropQuestions();
    this.bridge?.dispose();
    this.bridge = undefined;
    this.changed.dispose();
    void this.imageDir?.then((dir) => rm(dir, { recursive: true, force: true }), () => undefined);
  }
}

/** A path a tool row or a message named: relative to the conversation's
 * workspace unless absolute. */
async function openWorkspaceFile(path: string, line: number | undefined, workspace: string): Promise<void> {
  const clean = path.replace(/^file:\/\//, '').replace(/^~(?=\/)/, homedir());
  const uri = /^([a-zA-Z]:[\\/]|\/)/.test(clean) ? vscode.Uri.file(clean) : vscode.Uri.joinPath(vscode.Uri.file(workspace), clean);
  const document = await vscode.workspace.openTextDocument(uri);
  const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
  await vscode.window.showTextDocument(document, { preview: true, ...(position ? { selection: new vscode.Range(position, position) } : {}) });
}
