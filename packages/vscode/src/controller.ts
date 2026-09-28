/** The extension's one ClikCode connection: starts the bridge, keeps the
 * ChatModel, and carries out what the bridge asks of the editor. */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { BridgeClient } from './bridge-client';
import { ChatViewProvider } from './chat-view';
import { answeredApproval, applyEvent, emptyModel, localNote, typedDuringTurn, type ChatModel } from './model';
import type { IdeEvent, IdeSlashCommand, WorkerEvent } from './protocol';
import { bridgeCommandMissing, bridgeCompatibility, tooOldToStartMessage, type Remedy } from './compat';
import { entryBuild, resolveRuntime, RuntimeError } from './runtime';
import { diffSides } from './text';
import { BridgeQuestion, DiffDocuments, fileNameIn, runInTerminal } from './ui';
import type { FromWebview } from './webview-protocol';

type ApprovalPreview = Extract<WorkerEvent, { type: 'approval-request' }>;

export class ClikCodeController implements vscode.Disposable {
  private bridge: BridgeClient | undefined;
  private model: ChatModel = emptyModel();
  private readonly changed = new vscode.EventEmitter<ChatModel>();
  readonly onDidChange = this.changed.event;
  private readonly questions = new Map<string, BridgeQuestion>();
  private readonly previews = new Map<string, ApprovalPreview>();
  private starting: Promise<void> | undefined;
  private restartingForBuild = false;
  private disposed = false;

  constructor(
    private readonly view: ChatViewProvider,
    private readonly diffs: DiffDocuments,
    private readonly log: vscode.OutputChannel,
  ) {}

  get state(): ChatModel {
    return this.model;
  }

  private setModel(next: ChatModel): void {
    if (next === this.model) return;
    const wasRunning = this.model.running;
    this.model = next;
    this.view.update(next);
    this.changed.fire(next);
    if (wasRunning !== next.running) void vscode.commands.executeCommand('setContext', 'clikcode.turnRunning', next.running);
  }

  private note(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.setModel(localNote(this.model, { kind: 'notice', level, text }));
  }

  private workspaceFolder(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath ?? homedir();
  }

  /** Started on first use and restarted on demand; concurrent callers share
   * one start. */
  ensureStarted(): Promise<void> {
    if (this.bridge?.running) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(sessionToResume?: string): Promise<void> {
    if (this.disposed) return;
    this.setModel({ ...this.model, connection: 'starting', connectionError: undefined, remedy: undefined });
    const settings = vscode.workspace.getConfiguration('clikcode');
    let runtime;
    try {
      runtime = await resolveRuntime({ path: settings.get<string>('path'), nodePath: settings.get<string>('nodePath') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.appendLine(message);
      this.setModel({ ...this.model, connection: 'error', connectionError: message, remedy: error instanceof RuntimeError && error.kind === 'clikcode-missing' ? 'install' : undefined });
      return;
    }
    this.log.appendLine(`Starting ${runtime.entry} with ${runtime.node} (${runtime.nodeSource})`);
    const bridge = BridgeClient.start(runtime, this.workspaceFolder());
    this.bridge = bridge;
    const startLog: string[] = [];
    bridge.on('log', (line) => { this.log.appendLine(line); if (startLog.length < 200) startLog.push(line); });
    bridge.on('exit', ({ code, signal }) => {
      if (this.bridge !== bridge) return;
      this.log.appendLine(`ClikCode exited (${signal ?? code})`);
      for (const question of this.questions.values()) question.dispose();
      this.questions.clear();
      if (this.disposed) return;
      this.setModel({
        ...this.model, connection: 'stopped', running: false, live: undefined, approvals: [],
        connectionError: code === 0 ? 'ClikCode stopped.' : `ClikCode stopped unexpectedly (${signal ?? `exit ${code}`}). See the log for details.`,
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ClikCode did not start within 30 seconds. See the log for details.')), 30_000);
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
      const resume = sessionToResume ?? this.model.sessionId;
      const mode = resume ? 'resume' : settings.get<'continue' | 'new'>('startWith') ?? 'continue';
      await bridge.call({ type: 'open', workspace: this.workspaceFolder(), mode, ...(resume ? { sessionId: resume } : {}) });
    } catch (error) {
      if (this.bridge !== bridge) return; // replaced, or refused as incompatible (already reported)
      const message = error instanceof Error ? error.message : String(error);
      this.log.appendLine(message);
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
    this.log.appendLine(message);
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
      this.log.appendLine('ClikCode was updated; reconnecting on the new build.');
      await this.restart();
    } finally { this.restartingForBuild = false; }
  }

  private onBridgeEvent(event: IdeEvent): void {
    this.setModel(applyEvent(this.model, event));
    switch (event.type) {
      case 'ui-request': {
        const question = new BridgeQuestion(event.request, (result) => {
          this.questions.delete(event.id);
          this.bridge?.send({ type: 'ui-response', id: event.id, result });
        });
        this.questions.set(event.id, question);
        question.show();
        return;
      }
      case 'ui-update':
        this.questions.get(event.id)?.update(event.items);
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
        this.view.post({ type: 'setDraft', text: event.text });
        return;
      case 'worker':
        this.onWorkerEvent(event.event);
        return;
      default:
        return;
    }
  }

  private onWorkerEvent(event: WorkerEvent): void {
    if (event.type === 'approval-request') {
      if (event.preview?.diff) {
        this.previews.set(event.id, event);
        if (vscode.workspace.getConfiguration('clikcode').get<boolean>('openDiffOnApproval', true)) void this.viewDiff(event.id);
      }
      if (!this.view.visible) {
        void vscode.window.showInformationMessage(`ClikCode asks: ${event.title}`, 'Show').then((choice) => { if (choice) void this.view.reveal(); });
      }
      return;
    }
    if (event.type === 'restore-draft') this.view.post({ type: 'setDraft', text: event.text });
    if (event.type === 'waiting-stop') {
      for (const id of this.previews.keys()) this.diffs.forget(id);
      this.previews.clear();
    }
  }

  async viewDiff(id: string): Promise<void> {
    const request = this.previews.get(id);
    const diff = request?.preview?.diff;
    if (!request || !diff) return;
    const { before, after } = diffSides(diff);
    await this.diffs.show(id, request.title, before, after, fileNameIn(request.title, request.detail));
  }

  // ---- what the user does --------------------------------------------------

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
    this.diffs.forget(id);
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

  onWebviewMessage(message: FromWebview): void {
    switch (message.type) {
      case 'ready':
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
      case 'command':
        if (message.command === 'clikcode.configure') void vscode.commands.executeCommand('workbench.action.openSettings', 'clikcode');
        else if (message.command.startsWith('clikcode.')) void vscode.commands.executeCommand(message.command);
        return;
      case 'openLink':
        if (/^(https?:|mailto:)/i.test(message.href)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const question of this.questions.values()) question.dispose();
    this.bridge?.dispose();
    this.bridge = undefined;
    this.changed.dispose();
  }
}
