/** One chat: a ClikCode connection (`clikcode ide-bridge`), the ChatModel it
 * feeds, and the webviews showing it. The side bar is one chat; every editor
 * tab is another, each with its own bridge, so each shows its own
 * conversation -- the bridge is one conversation at a time, like a terminal. */
import { PAINT_COALESCE_MS } from '../../../src/harness/protocol/timings';
import { errorText, userError } from '../../../src/harness/protocol/errors';
import * as vscode from 'vscode';
import { homedir, tmpdir } from 'node:os';
import { unwatchFile, watchFile } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BridgeClient } from './bridge-client';
import type { WebviewSurface } from './chat-view';
import { diffModel } from './model-patch';
import { answeredApproval, applyEvent, conversationAttention, emptyModel, takenBackText, withNote, typedDuringTurn, type ChatModel } from './model';
import type { FileDiff, IdeAccounts, IdeChatSettings, IdeConversation, IdeEvent, IdeProvider, IdeSlashCommand, IdeUiRequest, WorkerEvent } from './protocol';
import { bridgeCommandMissing, bridgeCompatibility, tooOldToStartMessage, type Remedy } from './compat';
import { entryBuild, resolveRuntime, RuntimeError } from './runtime';
import { applyHunks, fileHunks, turnChanges, unwindChanges } from './text';
import { readFile } from 'node:fs/promises';
import { DiffDocuments, fileNameIn, openSignInLink, runInTerminal } from './ui';
import type { FromWebview, ListedConversation, ToWebview, WebviewRequest } from './webview-protocol';
import { mentionFromUri, pastedReference, searchWorkspaceFiles } from './mentions';
import type { Mention } from './webview-protocol';

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
  /** Approvals whose change is open in a diff editor. */
  private readonly shownDiffs = new Set<string>();
  /** Queued messages being taken back to edit, by id: their text goes back in
   * the composer when the worker answers `removed`. */
  private readonly takingBack = new Map<string, string>();
  private readonly surfaces = new Set<WebviewSurface>();
  private starting: Promise<void> | undefined;
  private restartingForBuild = false;
  private watchedEntry: string | undefined;
  private buildSettle: NodeJS.Timeout | undefined;
  private disposed = false;
  private postTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshedFor = '';
  private lastAutoRestart = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Pasted images: path -> sent in a message yet. */
  private readonly images = new Map<string, boolean>();
  private imageDir: Promise<string> | undefined;

  constructor(
    private readonly host: ControllerHost,
    /** What opens first: the setting's choice, or a conversation asked for. */
    private readonly first: { mode: 'new' | 'continue' | 'resume'; sessionId?: string } | undefined,
    readonly label: string,
  ) {}

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
    return new vscode.Disposable(() => {
      this.surfaces.delete(surface);
      for (const [id, owner] of [...this.panelQuestions]) {
        if (owner !== surface) continue;
        this.panelQuestions.delete(id);
        this.bridge?.send({ type: 'ui-response', id, result: { cancelled: true } });
      }
    });
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
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.readStructured(onlyAccount);
    }, 120);
  }

  private async readStructured(onlyAccount: boolean): Promise<void> {
    const bridge = this.bridge;
    if (!bridge?.running) return;
    const sessionId = this.model.sessionId;
    const [settings, providers, accounts] = await Promise.all([
      onlyAccount ? Promise.resolve(this.model.chatSettings) : bridge.call<IdeChatSettings>({ type: 'query', query: 'chat-settings' }, 30_000).catch(() => undefined),
      onlyAccount ? Promise.resolve(undefined) : bridge.call<IdeProvider[]>({ type: 'query', query: 'providers' }, 30_000).catch(() => undefined),
      bridge.call<IdeAccounts>({ type: 'query', query: 'accounts' }, 30_000).catch(() => undefined),
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
    log.appendLine(`[${this.label}] Starting ${runtime.entry} with ${runtime.node} (${runtime.nodeSource})`);
    const bridge = BridgeClient.start(runtime, this.workspaceFolder());
    this.bridge = bridge;
    this.watchBuild(runtime.entry);
    const startLog: string[] = [];
    bridge.on('log', (line) => { log.appendLine(`[${this.label}] ${line}`); if (startLog.length < 200) startLog.push(line); });
    bridge.on('exit', ({ code, signal }) => {
      if (this.bridge !== bridge) return;
      log.appendLine(`[${this.label}] ClikCode exited (${signal ?? code})`);
      this.dropQuestions();
      if (this.disposed) return;
      // A bridge that dies after it was ready (killed, crashed, the machine
      // slept through it) comes back on its own, onto the same conversation;
      // the worker kept the turn going meanwhile. Once a minute at most, so a
      // bridge that cannot stay up ends at the banner instead of a loop.
      const wasReady = this.model.connection === 'ready';
      const now = Date.now();
      if (wasReady && now - this.lastAutoRestart > 60_000) {
        this.lastAutoRestart = now;
        log.appendLine(`[${this.label}] reconnecting`);
        this.bridge = undefined;
        // The turn keeps its place on screen: the worker is still running it,
        // and the new bridge's snapshot says where it got to (and re-asks any
        // approval it is waiting on).
        this.setModel({ ...this.model, connection: 'starting', approvals: [], connectionError: undefined });
        setTimeout(() => { if (!this.disposed && !this.bridge) void this.ensureStarted(); }, 500);
        return;
      }
      this.setModel({
        ...this.model, connection: 'stopped', running: false, live: undefined, approvals: [],
        connectionError: code === 0 ? 'ClikCode stopped.' : `ClikCode stopped unexpectedly (${signal ?? `exit ${code}`}). See the log for details.`,
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ClikCode did not start within 60 seconds. See the log for details.')), 60_000);
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
      const resume = sessionToResume ?? this.model.sessionId ?? (this.first?.mode === 'resume' ? this.first.sessionId : undefined);
      const mode = resume ? 'resume' : this.first?.mode ?? settings.get<'continue' | 'new'>('startWith') ?? 'continue';
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(resume ? { sessionId: resume } : {}) }).catch(async (error: unknown) => {
        // A new chat nothing was sent in was never stored: reconnecting (a
        // rebuild, clikcode.restart) has nothing to resume, and failing here
        // left the panel dead. It is still a new chat.
        if (!resume || !/no chat matches/.test(errorText(error))) throw error;
        await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode: 'new' });
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
  private watchBuild(entry: string): void {
    if (this.watchedEntry === entry) return;
    this.unwatchBuild();
    this.watchedEntry = entry;
    watchFile(entry, { interval: 2_000 }, this.onBuildChanged);
  }

  private unwatchBuild(): void {
    if (this.watchedEntry) unwatchFile(this.watchedEntry, this.onBuildChanged);
    this.watchedEntry = undefined;
    if (this.buildSettle) clearTimeout(this.buildSettle);
    this.buildSettle = undefined;
  }

  /** A build is several files written in turn: wait for it to settle. */
  private readonly onBuildChanged = (): void => {
    if (this.buildSettle) clearTimeout(this.buildSettle);
    this.buildSettle = setTimeout(() => { this.buildSettle = undefined; void this.moveToNewBuild(); }, 1_500);
  };

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
        this.post({ type: 'setDraft', text: event.text });
        return;
      case 'usage':
        this.refreshStructured(true);
        return;
      case 'conversations-changed':
        for (const surface of this.surfaces) surface.post({ type: 'conversations-changed' });
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

  private onWorkerEvent(event: WorkerEvent): void {
    if (event.type === 'approval-request') {
      // One file opens beside the chat without the keyboard (preserveFocus).
      // Several open VS Code's multi-file changes editor, which always takes
      // the keyboard -- neither `vscode.changes` nor the editor behind it
      // takes a preserveFocus (VS Code 1.123) -- so those wait for the
      // card's diff button.
      if (event.preview?.diff?.length === 1 && vscode.workspace.getConfiguration('clikcode').get<boolean>('openDiffOnApproval', true)) void this.viewDiff(event.id);
      // Only a chat out of sight asks in a toast: one on screen shows the
      // question already, and a toast for it was the same question twice
      // when the user came back to the window.
      if (!this.visible) {
        void vscode.window.showInformationMessage(`ClikCode asks: ${event.title}`, 'Allow', 'Show').then((choice) => {
          if (choice === 'Allow') this.approve(event.id, true);
          else if (choice) void this.host.reveal(this);
        });
      }
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
      for (const id of [...this.shownDiffs]) this.forgetDiff(id);
    }
  }

  hasApproval(id: string): boolean {
    return this.model.approvals.some((approval) => approval.id === id);
  }

  /** A pending approval's change in VS Code's diff editor, every file of it. */
  async viewDiff(id: string): Promise<void> {
    const approval = this.model.approvals.find((item) => item.id === id);
    if (!approval?.diff?.length) return;
    const files = await Promise.all(approval.diff.map((file) => this.fileVersions(file, 'proposed')));
    this.shownDiffs.add(id);
    await this.host.diffs.show(id, approval.title, files.map((file, index) => ({ ...file, name: file.name ?? fileNameIn(approval.title, approval.detail) ?? `change ${index + 1}` })));
  }

  private forgetDiff(id: string): void {
    this.shownDiffs.delete(id);
    this.host.diffs.forget(id);
  }

  /** A file's whole text before and after a change, where the file on disk
   * lets the hunks be placed: a proposed change applies to the file as it
   * is; a made one is undone from it. When a hunk does not place cleanly, or
   * the diff was cut short, the hunks themselves. */
  private async fileVersions(file: FileDiff, state: 'proposed' | 'made'): Promise<{ name?: string; path?: string; before: string; after: string; whole: boolean }> {
    const hunks = fileHunks(file);
    const path = file.path ? (isAbsolute(file.path) ? file.path : join(this.model.workspace ?? this.workspaceFolder(), file.path)) : undefined;
    const current = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    const name = file.path?.split(/[\\/]/).pop();
    if (state === 'made' && file.change === 'add' && current !== undefined) return { name, path, before: '', after: current, whole: true };
    if (current !== undefined && !file.omitted) {
      if (state === 'proposed') {
        const after = applyHunks(current, hunks);
        if (after !== undefined) return { name, path, before: current, after, whole: true };
      } else {
        const before = applyHunks(current, hunks.map((hunk) => ({ before: hunk.after, after: hunk.before })));
        if (before !== undefined) return { name, path, before, after: current, whole: true };
      }
    }
    return {
      name, path, whole: false,
      before: hunks.map((hunk) => hunk.before.join('\n')).join('\n⋮\n'),
      after: hunks.map((hunk) => hunk.after.join('\n')).join('\n⋮\n'),
    };
  }

  /** A tool row's change, by the turn it belongs to (none: the running one). */
  private changeOf(key: string, userIndex: number | undefined): FileDiff[] | undefined {
    const activities = userIndex === undefined ? this.model.live?.activities : this.model.traces.find((trace) => trace.userIndex === userIndex)?.activities;
    return activities?.find((activity) => activity.key === key)?.diff;
  }

  /** A change the agent made, in the diff editor. */
  private async viewChange(key: string, userIndex: number | undefined): Promise<void> {
    const diff = this.changeOf(key, userIndex);
    if (!diff?.length) return;
    const files = await Promise.all(diff.map((file) => this.fileVersions(file, 'made')));
    const id = `made-${userIndex ?? 'live'}-${key.replace(/[^\w-]+/g, '_')}`;
    await this.host.diffs.show(id, 'Change', files.map((file, index) => ({ ...file, name: file.name ?? `change ${index + 1}` })), true);
  }

  /** Undo a change the agent made, as one edit VS Code can itself undo --
   * only where every file of it still places cleanly. */
  private async revertChange(key: string, userIndex: number | undefined): Promise<void> {
    const diff = this.changeOf(key, userIndex);
    if (!diff?.length) return;
    const files = await Promise.all(diff.map(async (file) => ({ ...(await this.fileVersions(file, 'made')), created: file.change === 'add' })));
    await this.undoFiles(files, 'this change', (names) => `Undo ClikCode's change to ${names}?`, 'Undo Change');
  }

  /** Every file a finished turn changed, as it was before the turn and as
   * it is now (unwindChanges): whole where all its changes still place. */
  private async turnFiles(userIndex: number): Promise<Array<{ name: string; path: string; before: string; after: string; whole: boolean; created: boolean }>> {
    const trace = this.model.traces.find((item) => item.userIndex === userIndex);
    const workspace = this.model.workspace ?? this.workspaceFolder();
    return Promise.all([...turnChanges(trace?.activities ?? [])].map(async ([file, changes]) => {
      const path = isAbsolute(file) ? file : join(workspace, file);
      const current = await readFile(path, 'utf8').catch(() => undefined);
      const unwound = unwindChanges(current, changes);
      return { name: file.split(/[\\/]/).pop() || file, path, before: unwound.before, after: current ?? '', whole: unwound.whole, created: unwound.created };
    }));
  }

  /** All of a turn's changes in the diff editor at once -- the multi-file
   * changes editor where it touched several files. */
  private async viewTurnChanges(userIndex: number): Promise<void> {
    const files = await this.turnFiles(userIndex);
    if (!files.length) return;
    await this.host.diffs.show(`turn-${userIndex}`, 'Changes', files, true);
  }

  /** Every change a turn made undone as one edit, after a modal confirm;
   * refused when any of its files changed since. */
  private async revertTurnChanges(userIndex: number): Promise<void> {
    const files = await this.turnFiles(userIndex);
    if (!files.length) return;
    await this.undoFiles(files, "this turn's changes", (names) => `Undo all of ClikCode's changes in this turn (${files.length} file${files.length === 1 ? '' : 's'}: ${names})?`, 'Undo All');
  }

  /** Files put back as they were, as one WorkspaceEdit VS Code can itself
   * undo: a file the agent created is deleted. Nothing is touched unless
   * every file still places cleanly. */
  private async undoFiles(files: ReadonlyArray<{ name?: string; path?: string; before: string; whole: boolean; created: boolean }>, what: string, question: (names: string) => string, action: string): Promise<void> {
    const stale = files.filter((item) => !item.whole || !item.path);
    if (stale.length) {
      void vscode.window.showWarningMessage(userError(`undo ${what}`, `${stale.map((item) => item.name ?? 'a file').join(', ')} changed since`));
      return;
    }
    const names = files.map((item) => item.name).join(', ');
    const choice = await vscode.window.showWarningMessage(question(names), { modal: true, detail: 'You can redo it with Undo in the editor.' }, action);
    if (choice !== action) return;
    const edit = new vscode.WorkspaceEdit();
    for (const item of files) {
      const uri = vscode.Uri.file(item.path!);
      if (item.created) { edit.deleteFile(uri, { ignoreIfNotExists: true }); continue; }
      const document = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), item.before);
    }
    if (!(await vscode.workspace.applyEdit(edit))) { void vscode.window.showErrorMessage(userError(`undo the change to ${names}`)); return; }
    await Promise.all(files.filter((item) => !item.created).map(async (item) => (await vscode.workspace.openTextDocument(vscode.Uri.file(item.path!))).save()));
  }

  // ---- what the user does --------------------------------------------------------

  async send(text: string, id = `${Date.now()}`): Promise<void> {
    await this.ensureStarted();
    const bridge = this.bridge;
    if (!bridge?.running || !this.model.sessionId) {
      this.note('ClikCode is not connected.', 'error');
      return;
    }
    for (const path of this.images.keys()) if (text.includes(path)) this.images.set(path, true);
    if (this.model.running && !/^[/!]/.test(text.trim())) this.setModel(typedDuringTurn(this.model, id, text.trim()));
    bridge.send({ type: 'send', text, id });
  }

  cancel(restoreDraft = true): void {
    this.bridge?.send({ type: 'cancel', restoreDraft });
  }

  approve(id: string, approved: boolean | 'always'): void {
    this.bridge?.send({ type: 'approval-response', id, approved });
    this.setModel(answeredApproval(this.model, id));
    if (this.shownDiffs.has(id)) void this.host.diffs.close(id);
    this.forgetDiff(id);
  }

  async open(mode: 'new' | 'continue' | 'resume', sessionId?: string): Promise<void> {
    await this.ensureStarted();
    const bridge = this.bridge;
    if (!bridge?.running) return;
    try {
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(sessionId ? { sessionId } : {}) });
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
      const data = await bridge.call({ type: 'query', query: request.query, ...(request.provider ? { provider: request.provider } : {}), ...(request.network ? { network: true } : {}) }, 120_000);
      if (request.query !== 'conversations') return data;
      const others = this.host.chats().filter((chat) => chat !== this).map((chat) => ({ sessionId: chat.state.sessionId, approvals: chat.state.approvals.length, unread: chat.unread }));
      return (data as IdeConversation[]).map((row): ListedConversation => {
        const attention = conversationAttention(row.id, others);
        return attention ? { ...row, attention } : row;
      });
    }
    // A choice can take a sign-in or an install: no short deadline.
    const result = await bridge.call({ type: 'choose', choice: request.choice }, 30 * 60_000);
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
      case 'unqueue': {
        const text = message.edit ? this.model.queued.find((item) => item.id === message.id)?.text : undefined;
        if (text !== undefined) this.takingBack.set(message.id, text);
        this.bridge?.send({ type: 'unqueue', id: message.id });
        return;
      }
      case 'approve':
        this.approve(message.id, message.approved);
        return;
      case 'viewDiff':
        void this.viewDiff(message.id);
        return;
      case 'change':
        void (message.action === 'view' ? this.viewChange(message.key, message.userIndex) : this.revertChange(message.key, message.userIndex));
        return;
      case 'turnChanges':
        void (message.action === 'view' ? this.viewTurnChanges(message.userIndex) : this.revertTurnChanges(message.userIndex));
        return;
      case 'request':
        void this.answer(surface, message.id, message.request);
        return;
      case 'ui-response':
        this.panelQuestions.delete(message.id);
        this.bridge?.send({ type: 'ui-response', id: message.id, result: message.result });
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
      case 'log':
        this.host.log.appendLine(`[${this.label} page] ${message.text}`);
        return;
      case 'openFile':
        void openWorkspaceFile(message.path, message.line, this.model.workspace ?? this.workspaceFolder());
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unwatchBuild();
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
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
    await vscode.window.showTextDocument(document, { preview: true, ...(position ? { selection: new vscode.Range(position, position) } : {}) });
  } catch {
    void vscode.window.showWarningMessage(userError(`open ${path}`));
  }
}
