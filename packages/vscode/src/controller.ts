/** One chat: a ClikCode connection (`clikcode ide-bridge`), the ChatModel it
 * feeds, and the webviews showing it. The side bar is one chat; every editor
 * tab is another, each with its own bridge, so each shows its own
 * conversation -- the bridge is one conversation at a time, like a terminal. */
import * as vscode from 'vscode';
import { homedir, tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeClient } from './bridge-client';
import type { WebviewSurface } from './chat-view';
import { answeredApproval, applyEvent, emptyModel, localNote, typedDuringTurn, type ChatModel } from './model';
import type { IdeAccounts, IdeChatSettings, IdeEvent, IdeProvider, IdeSlashCommand, IdeUiRequest, WorkerEvent } from './protocol';
import { bridgeCommandMissing, bridgeCompatibility, tooOldToStartMessage, type Remedy } from './compat';
import { entryBuild, resolveRuntime, RuntimeError } from './runtime';
import { applyHunks, diffInDetail, diffSides } from './text';
import { readFile } from 'node:fs/promises';
import { BridgeQuestion, DiffDocuments, fileNameIn, runInTerminal } from './ui';
import type { FromWebview, ToWebview, WebviewRequest } from './webview-protocol';
import { searchWorkspaceFiles } from './mentions';

type ApprovalPreview = Extract<WorkerEvent, { type: 'approval-request' }>;

const POST_INTERVAL_MS = 40;
const STRUCTURED_REVISION = 2;

export interface ControllerHost {
  log: vscode.OutputChannel;
  diffs: DiffDocuments;
  /** Opens a conversation (or a new one) in an editor tab of its own. */
  openInTab(sessionId?: string): Promise<void>;
  /** Where the surface was, for notifications ("Show"). */
  reveal(controller: ClikCodeController): Promise<void>;
}

export class ClikCodeController implements vscode.Disposable {
  private bridge: BridgeClient | undefined;
  private model: ChatModel = emptyModel();
  private readonly changed = new vscode.EventEmitter<ChatModel>();
  readonly onDidChange = this.changed.event;
  private readonly questions = new Map<string, BridgeQuestion>();
  /** Pickers drawn in a webview, and which one. */
  private readonly panelQuestions = new Map<string, WebviewSurface>();
  private readonly previews = new Map<string, ApprovalPreview>();
  private readonly surfaces = new Set<WebviewSurface>();
  private starting: Promise<void> | undefined;
  private restartingForBuild = false;
  private disposed = false;
  private postTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshedFor = '';
  private accountTimer: NodeJS.Timeout | undefined;
  private lastAutoRestart = 0;

  constructor(
    private readonly host: ControllerHost,
    /** What opens first: the setting's choice, or a conversation asked for. */
    private readonly first: { mode: 'new' | 'continue' | 'resume'; sessionId?: string } | undefined,
    readonly label: string,
  ) {
    this.accountTimer = setInterval(() => { if (this.visible) this.refreshStructured(true); }, 60_000);
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
  probe(action: 'query' | 'click' | 'type' | 'key', selector: string, text?: string): Promise<unknown> {
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
    if (previous.running !== next.running) void vscode.commands.executeCommand('setContext', 'clikcode.turnRunning', next.running);
    if (previous.running && !next.running) this.turnEnded(previous);
    if (next.connection === 'ready' && (next.revision ?? 1) >= STRUCTURED_REVISION && next.sessionId) {
      const key = [next.sessionId, next.providerId, next.model, next.account, next.effort, next.permissions].join('|');
      if (key !== this.refreshedFor) {
        this.refreshedFor = key;
        this.refreshStructured(false);
      }
    }
  }

  /** Coalesced: a stream of deltas repaints at most every 40 ms. */
  private schedulePost(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      for (const surface of this.surfaces) this.postModel(surface);
    }, POST_INTERVAL_MS);
  }

  /** The model to one page. A streaming turn repaints every 40 ms, and a long
   * conversation's transcript is most of the model: it is sent only when it
   * changed, and the page keeps the copy it has. */
  private postModel(surface: WebviewSurface): void {
    const messages = this.model.messages;
    if (surface.ready && surface.sentMessages === messages) {
      surface.post({ type: 'model', model: { ...this.model, messages: [] }, sameMessages: true });
      return;
    }
    surface.post({ type: 'model', model: this.model });
    if (surface.ready) surface.sentMessages = messages;
  }

  /** A turn finished where nobody is looking: say so, as Claude Code does. */
  private turnEnded(previous: ChatModel): void {
    if (this.visible && vscode.window.state.focused) return;
    const title = previous.title ?? 'your chat';
    void vscode.window.showInformationMessage(`ClikCode finished: ${title}`, 'Show').then((choice) => {
      if (choice) void this.host.reveal(this);
    });
  }

  /** The composer footer's facts: this chat's setting choices, its provider,
   * its account and usage. Read after every change of conversation or
   * setting; `withAccounts` alone (the minute timer) re-reads usage. */
  private refreshStructured(onlyAccount: boolean): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.readStructured(onlyAccount);
    }, 120);
  }

  private async readStructured(onlyAccount: boolean): Promise<void> {
    const bridge = this.bridge;
    if (!bridge?.running || (this.model.revision ?? 1) < STRUCTURED_REVISION) return;
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
    this.setModel(localNote(this.model, { kind: 'notice', level, text }));
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
    if (this.bridge?.running) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
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
      const message = error instanceof Error ? error.message : String(error);
      log.appendLine(message);
      this.setModel({ ...this.model, connection: 'error', connectionError: message, remedy: error instanceof RuntimeError && error.kind === 'clikcode-missing' ? 'install' : undefined });
      return;
    }
    log.appendLine(`[${this.label}] Starting ${runtime.entry} with ${runtime.node} (${runtime.nodeSource})`);
    const bridge = BridgeClient.start(runtime, this.workspaceFolder());
    this.bridge = bridge;
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
        this.setModel({ ...this.model, connection: 'starting', running: false, live: undefined, approvals: [], connectionError: undefined });
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
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(resume ? { sessionId: resume } : {}) });
    } catch (error) {
      if (this.bridge !== bridge) return; // replaced, or refused as incompatible (already reported)
      const message = error instanceof Error ? error.message : String(error);
      log.appendLine(message);
      this.setModel({ ...this.model, connection: bridge.running ? 'ready' : 'error', connectionError: message });
      if (bridge.running) this.note(message, 'error');
    }
  }

  /** The bridge cannot drive this extension: stop it, say why, and offer the
   * update that fixes it. */
  private incompatible(bridge: BridgeClient, message: string, remedy: Exclude<Remedy, 'install'>): void {
    if (this.bridge !== bridge) return;
    this.bridge = undefined;
    bridge.dispose();
    this.host.log.appendLine(message);
    this.setModel({ ...this.model, connection: 'error', running: false, connectionError: message, remedy });
    const action = remedy === 'update-clikcode' ? 'Update ClikCode' : 'Update Extension';
    void vscode.window.showErrorMessage(message, action).then((choice) => {
      if (choice) void vscode.commands.executeCommand(remedy === 'update-clikcode' ? 'clikcode.update' : 'clikcode.updateExtension');
    });
  }

  async restart(): Promise<void> {
    const session = this.model.sessionId;
    const previous = this.bridge;
    this.bridge = undefined;
    previous?.dispose();
    this.starting = this.start(session).finally(() => { this.starting = undefined; });
    await this.starting;
  }

  /** ClikCode was reinstalled since the bridge started: move onto the new
   * build between turns, so the worker is retired onto it too. */
  private async freshBridge(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || this.model.running || this.restartingForBuild) return;
    const now = entryBuild(bridge.runtime.entry);
    if (!now || !bridge.build || now === bridge.build) return;
    this.restartingForBuild = true;
    try {
      this.host.log.appendLine('ClikCode was updated; reconnecting on the new build.');
      await this.restart();
    } finally { this.restartingForBuild = false; }
  }

  private dropQuestions(): void {
    for (const question of this.questions.values()) question.dispose();
    this.questions.clear();
    for (const [id, surface] of this.panelQuestions) surface.post({ type: 'ui-cancel', id });
    this.panelQuestions.clear();
  }

  private onBridgeEvent(event: IdeEvent): void {
    this.setModel(applyEvent(this.model, event));
    switch (event.type) {
      case 'ui-request':
        this.ask(event.id, event.request);
        return;
      case 'ui-update':
        this.questions.get(event.id)?.update(event.items);
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
          (error: unknown) => bridge.send({ type: 'sign-in-result', id: event.id, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      case 'open-file':
        void vscode.window.showTextDocument(vscode.Uri.file(event.path), { preview: false });
        return;
      case 'restore-draft':
        this.post({ type: 'setDraft', text: event.text });
        return;
      case 'usage':
        this.refreshStructured(true);
        return;
      case 'worker':
        this.onWorkerEvent(event.event);
        return;
      default:
        return;
    }
  }

  /** A terminal picker: drawn in the chat when the chat is on screen, as a
   * quick pick otherwise. */
  private ask(id: string, request: IdeUiRequest): void {
    const surface = this.front();
    if (surface?.visible && surface.ready) {
      this.panelQuestions.set(id, surface);
      surface.post({ type: 'ui-request', id, request });
      return;
    }
    const question = new BridgeQuestion(request, (result) => {
      this.questions.delete(id);
      this.bridge?.send({ type: 'ui-response', id, result });
    });
    this.questions.set(id, question);
    question.show();
  }

  private onWorkerEvent(event: WorkerEvent): void {
    if (event.type === 'approval-request') {
      if (event.preview?.diff || diffInDetail(event.detail)) {
        this.previews.set(event.id, event);
        if (vscode.workspace.getConfiguration('clikcode').get<boolean>('openDiffOnApproval', true)) void this.viewDiff(event.id);
      }
      if (!this.visible || !vscode.window.state.focused) {
        void vscode.window.showInformationMessage(`ClikCode asks: ${event.title}`, 'Allow', 'Show').then((choice) => {
          if (choice === 'Allow') this.approve(event.id, true);
          else if (choice) void this.host.reveal(this);
        });
      }
      return;
    }
    if (event.type === 'restore-draft') this.post({ type: 'setDraft', text: event.text });
    if (event.type === 'waiting-stop') {
      for (const id of this.previews.keys()) this.host.diffs.forget(id);
      this.previews.clear();
    }
  }

  hasApproval(id: string): boolean {
    return this.model.approvals.some((approval) => approval.id === id);
  }

  async viewDiff(id: string): Promise<void> {
    const request = this.previews.get(id);
    if (!request) return;
    const diff = request.preview?.diff;
    if (diff) {
      const { before, after } = diffSides(diff);
      await this.host.diffs.show(id, request.title, before, after, fileNameIn(request.title, request.detail));
      return;
    }
    // ClikCode's own agent says what it will change in the approval's text:
    // applied to the file as it is on disk, that is the whole file before and
    // after; when a hunk does not apply cleanly, the hunks themselves.
    const described = diffInDetail(request.detail);
    if (!described) return;
    const current = described.path ? await readFile(described.path, 'utf8').catch(() => undefined) : undefined;
    const whole = current !== undefined && !described.truncated ? applyHunks(current, described.hunks) : undefined;
    const before = whole !== undefined ? current! : described.hunks.map((hunk) => hunk.before.join('\n')).join('\n⋮\n');
    const after = whole ?? described.hunks.map((hunk) => hunk.after.join('\n')).join('\n⋮\n');
    await this.host.diffs.show(id, request.title, before, after, described.path?.split(/[\\/]/).pop() ?? fileNameIn(request.title, request.detail));
  }

  // ---- what the user does --------------------------------------------------------

  async send(text: string, id = `${Date.now()}`): Promise<void> {
    await this.ensureStarted();
    await this.freshBridge();
    const bridge = this.bridge;
    if (!bridge?.running || !this.model.sessionId) {
      this.note('ClikCode is not connected.', 'error');
      return;
    }
    if (this.model.running && !/^[/!]/.test(text.trim())) this.setModel(typedDuringTurn(this.model, id, text.trim()));
    bridge.send({ type: 'send', text, id });
  }

  cancel(restoreDraft = true): void {
    this.bridge?.send({ type: 'cancel', restoreDraft });
  }

  approve(id: string, approved: boolean | 'always'): void {
    this.bridge?.send({ type: 'approval-response', id, approved });
    this.setModel(answeredApproval(this.model, id));
    this.host.diffs.forget(id);
    this.previews.delete(id);
  }

  async open(mode: 'new' | 'continue' | 'resume', sessionId?: string): Promise<void> {
    await this.ensureStarted();
    await this.freshBridge();
    const bridge = this.bridge;
    if (!bridge?.running) return;
    try {
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(sessionId ? { sessionId } : {}) });
    } catch (error) {
      this.note(error instanceof Error ? error.message : String(error), 'error');
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
      reply(false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private async handle(request: WebviewRequest): Promise<unknown> {
    switch (request.method) {
      case 'files':
        return searchWorkspaceFiles(request.text);
      case 'openInTab':
        await this.host.openInTab(request.sessionId);
        return undefined;
      case 'openInTerminal': {
        const bridge = this.bridge;
        if (!bridge) throw new Error('ClikCode is not connected.');
        const terminal = vscode.window.createTerminal({
          name: 'ClikCode', shellPath: bridge.runtime.node,
          shellArgs: [bridge.runtime.entry, 'sessions', 'resume', request.sessionId],
          env: bridge.runtime.env, cwd: this.model.workspace ?? this.workspaceFolder(),
          iconPath: new vscode.ThemeIcon('comment-discussion'),
        });
        terminal.show();
        return undefined;
      }
      case 'saveImage': {
        const dir = join(tmpdir(), 'clikcode-vscode-images');
        await mkdir(dir, { recursive: true });
        const safe = request.name.replace(/[^\w.-]+/g, '_').slice(-60) || 'image.png';
        const path = join(dir, `${Date.now().toString(36)}-${safe}`);
        await writeFile(path, Buffer.from(request.dataBase64, 'base64'));
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
    if ((this.model.revision ?? 1) < STRUCTURED_REVISION) throw new Error('Update ClikCode to use this (npm install -g clikcode@latest).');
    if (request.method === 'query') {
      return bridge.call({ type: 'query', query: request.query, ...(request.provider ? { provider: request.provider } : {}), ...(request.network ? { network: true } : {}) }, 120_000);
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
        surface.sentMessages = undefined;
        this.postModel(surface);
        void this.ensureStarted();
        return;
      case 'send':
        void this.send(message.text, message.id);
        return;
      case 'cancel':
        this.cancel(message.restoreDraft);
        return;
      case 'approve':
        this.approve(message.id, message.approved);
        return;
      case 'viewDiff':
        void this.viewDiff(message.id);
        return;
      case 'request':
        void this.answer(surface, message.id, message.request);
        return;
      case 'ui-response':
        this.panelQuestions.delete(message.id);
        this.bridge?.send({ type: 'ui-response', id: message.id, result: message.result });
        return;
      case 'command':
        if (message.command === 'clikcode.configure') void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:clikcode.clikcode');
        else if (message.command.startsWith('clikcode.') || message.command === 'workbench.action.openWalkthrough') {
          void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        return;
      case 'openLink':
        if (/^(https?:|mailto:)/i.test(message.href)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
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
    if (this.accountTimer) clearInterval(this.accountTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.postTimer) clearTimeout(this.postTimer);
    this.dropQuestions();
    this.bridge?.dispose();
    this.bridge = undefined;
    this.changed.dispose();
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
    void vscode.window.showWarningMessage(`ClikCode: cannot open ${path}`);
  }
}
