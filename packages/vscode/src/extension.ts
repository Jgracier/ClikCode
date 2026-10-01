/** ClikCode for VS Code: every coding agent ClikCode runs, in the editor. */
import * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';
import { PANEL_TYPE, supportsSecondarySidebar, VIEW_IDS, WebviewSurface } from './chat-view';
import { ClikCodeController, type ControllerHost } from './controller';
import { questionWithSelection } from './editor-context';
import { chatModelLabel, providerDisplayName, type ChatModel } from './model';
import { INSTALL_COMMAND, INSTALL_FALLBACK_COMMAND } from './compat';
import { DiffDocuments } from './ui';
import { registerCustomAcpCommands } from './custom-acp';
import { mentionFromEditor, mentionFromUri } from './mentions';
import type { WebviewMenu } from './webview-protocol';

/** What activate() returns: used by the integration tests, and a stable
 * surface for anything else that wants to drive the chat. The top-level
 * members are the side bar chat. */
export interface ClikCodeApi {
  readonly state: ChatModel;
  onDidChange: vscode.Event<ChatModel>;
  send(text: string): Promise<void>;
  open(mode: 'new' | 'continue' | 'resume', sessionId?: string): Promise<void>;
  ready(): Promise<void>;
  /** The chat commands act on: the one focused last. */
  readonly active: { readonly state: ChatModel; onDidChange: vscode.Event<ChatModel> };
  /** Chats open in editor tabs. */
  readonly tabs: number;
  /** Each tab chat's state, oldest first. */
  tabStates(): ChatModel[];
  /** Integration tests: read or drive the active chat's page. */
  probe(action: 'query' | 'click' | 'type' | 'key', selector: string, text?: string): Promise<unknown>;
}

/** The status bar item: ClikCode's name and what it is doing; provider,
 * model and account are in the composer, and in the tooltip here. */
export function statusText(model: ChatModel): { text: string; tooltip: string } {
  if (model.connection === 'error' || model.connection === 'stopped') return { text: '$(warning) ClikCode', tooltip: model.connectionError ?? 'ClikCode is not running' };
  if (!model.sessionId) return { text: '$(comment-discussion) ClikCode', tooltip: 'Open the ClikCode chat' };
  const name = providerDisplayName(model);
  const usage = model.currentAccount?.usage?.label ?? model.accountUsage;
  const waiting = model.approvals.length > 0;
  const tooltip = [
    `${model.title ?? 'New chat'}${waiting ? ' (waiting for your approval)' : model.running ? ' (working)' : ''}`,
    `Provider: ${name ?? '—'}`, `Model: ${chatModelLabel(model, name) ?? 'default'}`,
    ...(model.account ? [`Account: ${model.account}`] : []), ...(model.effort ? [`Effort: ${model.effort}`] : []),
    ...(model.permissions ? [`Permissions: ${model.permissions}`] : []), ...(usage ? [`Usage: ${usage}`] : []),
  ].join('\n');
  const icon = waiting ? '$(bell-dot)' : model.running ? '$(sync~spin)' : '$(comment-discussion)';
  return { text: `${icon} ClikCode`, tooltip };
}

export function activate(context: vscode.ExtensionContext): ClikCodeApi {
  const log = vscode.window.createOutputChannel('ClikCode');
  // Integration tests keep the log where the runner can read it.
  const logFile = context.extensionMode === vscode.ExtensionMode.Test ? process.env.CLIKCODE_IT_LOG : undefined;
  if (logFile) {
    const append = log.appendLine.bind(log);
    log.appendLine = (line: string) => { append(line); try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } };
  }
  const diffs = new DiffDocuments();
  const secondary = supportsSecondarySidebar(vscode.version);
  if (!secondary) void vscode.commands.executeCommand('setContext', 'clikcode.doesNotSupportSecondarySidebar', true);
  const sidebarViewId = secondary ? VIEW_IDS.secondary : VIEW_IDS.activity;
  const testing = context.extensionMode === vscode.ExtensionMode.Test;

  const tabs = new Map<vscode.WebviewPanel, ClikCodeController>();
  let tabCount = 0;
  const host: ControllerHost = {
    log, diffs,
    openInTab: async (sessionId) => { openTab(sessionId ? { mode: 'resume', sessionId } : { mode: 'new' }); },
    reveal: async (controller) => {
      if (controller === sidebar) { await revealSidebar(); return; }
      for (const [panel, owner] of tabs) if (owner === controller) panel.reveal(panel.viewColumn, false);
    },
    chats: () => all(),
  };
  const sidebar = new ClikCodeController(host, undefined, 'side bar');

  const all = (): ClikCodeController[] => [sidebar, ...tabs.values()];
  /** The chat a command acts on: the one focused last, else the side bar. */
  const active = (): ClikCodeController => {
    if (sidebar.focused) return sidebar;
    const focusedTab = [...tabs].find(([panel]) => panel.active)?.[1];
    if (focusedTab) return focusedTab;
    return all().sort((left, right) => right.lastFocusedAt - left.lastFocusedAt).find((item) => item.lastFocusedAt > 0) ?? sidebar;
  };

  async function revealSidebar(): Promise<void> {
    await vscode.commands.executeCommand(`${sidebarViewId}.focus`);
  }

  const onChatFocus = (): void => {
    void vscode.commands.executeCommand('setContext', 'clikcode.chatFocused', all().some((item) => item.focused));
    paint();
  };

  function surfaceFor(controller: ClikCodeController, webview: vscode.Webview, kind: 'sidebar' | 'tab', visible: () => boolean): { surface: WebviewSurface; dispose(): void } {
    const surface = new WebviewSurface(webview, kind, visible, context.extensionUri, (from, message) => {
      if (message.type === 'focusChanged') onChatFocus();
      controller.onWebviewMessage(from, message);
    });
    const attached = controller.attach(surface);
    return { surface, dispose: () => { attached.dispose(); surface.dispose(); } };
  }

  const sidebarProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const { dispose } = surfaceFor(sidebar, view.webview, 'sidebar', () => view.visible);
      view.onDidDispose(dispose);
    },
  };

  /** A chat in an editor tab of its own: its own connection and conversation. */
  function restoreTab(panel: vscode.WebviewPanel, first: { mode: 'new' | 'continue' | 'resume'; sessionId?: string }): ClikCodeController {
    tabCount += 1;
    const controller = new ClikCodeController(host, first, `tab ${tabCount}`);
    tabs.set(panel, controller);
    panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, 'media', 'editor-light.svg'), dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'editor-dark.svg') };
    const { dispose } = surfaceFor(controller, panel.webview, 'tab', () => panel.visible);
    // A tab that is waiting on an answer, or finished out of sight, says so
    // in its title, where it shows among the other tabs.
    const title = (): void => {
      const model = controller.state;
      const flag = model.approvals.length || controller.unread ? '● ' : '';
      panel.title = `${flag}${model.title ? truncate(model.title, 32) : 'ClikCode'}`;
    };
    const retitle = controller.onDidChange(title);
    panel.onDidChangeViewState(() => { title(); paint(); });
    panel.onDidDispose(() => {
      tabs.delete(panel);
      retitle.dispose();
      dispose();
      controller.dispose();
      paint();
    });
    const watch = controller.onDidChange(paint);
    context.subscriptions.push(watch);
    return controller;
  }

  /** Another chat tab, as many as wanted: a tab in the group the ClikCode
   * tabs already share (the active one's, else the last one's), and beside
   * the editor only for the first. Opening every chat `Beside` split the
   * window into another column each time -- a new editor group per chat,
   * which soon ran out of room -- where a tab was what was asked for. */
  function openTab(first: { mode: 'new' | 'continue' | 'resume'; sessionId?: string }): ClikCodeController {
    const existing = [...tabs.keys()];
    const column = (existing.find((panel) => panel.active) ?? existing.at(-1))?.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'ClikCode', { viewColumn: column, preserveFocus: false }, { retainContextWhenHidden: true });
    return restoreTab(panel, first);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'clikcode.focus';
  let running: boolean | undefined;
  function paint(): void {
    const state = active().state;
    const { text, tooltip } = statusText(state);
    status.text = text;
    status.tooltip = tooltip;
    // "Stop Current Turn" is offered in the command palette only while there is one.
    if (state.running !== running) { running = state.running; void vscode.commands.executeCommand('setContext', 'clikcode.running', running); }
  }
  paint();
  status.show();

  /** Shows the chat a command acts on, and returns it. */
  const shown = async (): Promise<ClikCodeController> => {
    const target = active();
    await host.reveal(target);
    return target;
  };
  const slash = (line: string) => async () => {
    const target = await shown();
    await target.send(line);
  };
  const menu = (name: WebviewMenu) => async () => {
    const target = await shown();
    target.post({ type: 'show', menu: name });
  };
  const addToChat = async (target: unknown): Promise<void> => {
    const uri = target instanceof vscode.Uri ? target : undefined;
    const editor = vscode.window.activeTextEditor;
    const mention = uri && (!editor || editor.document.uri.toString() !== uri.toString())
      ? mentionFromUri(uri)
      : editor ? mentionFromEditor(editor) : undefined;
    if (!mention || (uri && uri.scheme !== 'file') || (!uri && editor?.document.uri.scheme !== 'file' && editor?.document.uri.scheme !== 'untitled')) {
      void vscode.window.showInformationMessage('Open a file to add it to the chat.');
      return;
    }
    const chat = await shown();
    chat.post({ type: 'mention', mention });
    chat.post({ type: 'focus' });
  };
  /** Accept or reject the proposed change shown in the active diff editor. */
  const decideDiff = (approved: boolean | 'always') => async (target?: unknown): Promise<void> => {
    const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
    const id = DiffDocuments.approvalOf(uri);
    const owner = id ? all().find((item) => item.hasApproval(id)) : undefined;
    if (!id || !owner) {
      void vscode.window.showInformationMessage('This change is no longer waiting for an answer.');
      return;
    }
    // "Always" only where the request offered a rule to remember, as in the
    // terminal: a choice that looks remembered and is not is worse than none.
    if (approved === 'always' && !owner.state.approvals.find((item) => item.id === id)?.rule) {
      void vscode.window.showInformationMessage('This change can only be allowed once.');
      return;
    }
    owner.approve(id, approved);
  };

  registerCustomAcpCommands(context);
  context.subscriptions.push(
    log, status, sidebar,
    sidebar.onDidChange(paint),
    new vscode.Disposable(() => { for (const controller of tabs.values()) controller.dispose(); }),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.secondary, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.activity, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(DiffDocuments.scheme, diffs),
    vscode.workspace.registerTextDocumentContentProvider(DiffDocuments.madeScheme, diffs),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('clikcode.path') || event.affectsConfiguration('clikcode.nodePath')) for (const controller of all()) void controller.restart();
    }),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: async (panel, state: unknown) => {
        const sessionId = typeof (state as { sessionId?: unknown } | undefined)?.sessionId === 'string' ? (state as { sessionId: string }).sessionId : undefined;
        restoreTab(panel, sessionId ? { mode: 'resume', sessionId } : { mode: 'continue' });
      },
    }),
    vscode.commands.registerCommand('clikcode.open', async () => { await revealSidebar(); sidebar.post({ type: 'focus' }); }),
    vscode.commands.registerCommand('clikcode.openInNewTab', () => { openTab({ mode: 'new' }); }),
    // The ClikCode button in the editor's tab bar, as Claude Code's and
    // Codex's are: each click a new chat in a tab of its own.
    vscode.commands.registerCommand('clikcode.newChatTab', () => { openTab({ mode: 'new' }); }),
    vscode.commands.registerCommand('clikcode.openInNewWindow', async () => {
      openTab({ mode: 'new' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }),
    vscode.commands.registerCommand('clikcode.focus', async () => { const target = await shown(); target.post({ type: 'focus' }); }),
    vscode.commands.registerCommand('clikcode.blur', () => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')),
    vscode.commands.registerCommand('clikcode.newChat', async () => { const target = await shown(); await target.open('new'); target.post({ type: 'focus' }); }),
    vscode.commands.registerCommand('clikcode.showHistory', menu('history')),
    vscode.commands.registerCommand('clikcode.showAccounts', menu('accounts')),
    vscode.commands.registerCommand('clikcode.openSettings', slash('/settings')),
    vscode.commands.registerCommand('clikcode.chooseProvider', slash('/provider')),
    vscode.commands.registerCommand('clikcode.chooseModel', slash('/model')),
    vscode.commands.registerCommand('clikcode.chooseAccount', slash('/account')),
    vscode.commands.registerCommand('clikcode.chooseEffort', slash('/effort')),
    vscode.commands.registerCommand('clikcode.choosePermissions', slash('/permissions')),
    vscode.commands.registerCommand('clikcode.cancel', () => active().cancel(true)),
    vscode.commands.registerCommand('clikcode.restart', () => active().restart()),
    vscode.commands.registerCommand('clikcode.showLog', () => log.show()),
    vscode.commands.registerCommand('clikcode.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),
    vscode.commands.registerCommand('clikcode.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#clikcode.start`, false)),
    vscode.commands.registerCommand('clikcode.addToChat', addToChat),
    vscode.commands.registerCommand('clikcode.insertAtMention', () => addToChat(undefined)),
    vscode.commands.registerCommand('clikcode.acceptProposedDiff', decideDiff(true)),
    vscode.commands.registerCommand('clikcode.rejectProposedDiff', decideDiff(false)),
    vscode.commands.registerCommand('clikcode.alwaysAllowProposedDiff', decideDiff('always')),
    // Install and update are the same npm command; the fallback is for a machine that cannot reach the npm registry.
    ...(['install', 'update'] as const).map((verb) => vscode.commands.registerCommand(`clikcode.${verb}`, async () => {
      const terminal = vscode.window.createTerminal({ name: verb === 'install' ? 'Install ClikCode' : 'Update ClikCode' });
      terminal.show();
      terminal.sendText(INSTALL_COMMAND);
      log.appendLine(`Running: ${INSTALL_COMMAND}\nIf the npm registry is not reachable, run instead: ${INSTALL_FALLBACK_COMMAND}`);
      const choice = await vscode.window.showInformationMessage(`When \`${INSTALL_COMMAND}\` finishes, reconnect ClikCode.`, 'Reconnect', 'Install from GitHub instead');
      const reconnect = async (): Promise<void> => { for (const controller of all()) await controller.restart(); };
      if (choice === 'Install from GitHub instead') {
        terminal.sendText(INSTALL_FALLBACK_COMMAND);
        if (await vscode.window.showInformationMessage('When the install finishes, reconnect ClikCode.', 'Reconnect')) await reconnect();
      } else if (choice) await reconnect();
    })),
    vscode.commands.registerCommand('clikcode.updateExtension', async () => {
      await vscode.commands.executeCommand('workbench.extensions.search', `@id:${context.extension.id}`);
      await vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
    }),
    vscode.commands.registerCommand('clikcode.runSlashCommand', async () => {
      const target = active();
      let commands;
      try { commands = await target.slashCommands(); } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      const items: Array<vscode.QuickPickItem & { command?: string }> = [];
      let group: string | undefined;
      for (const command of commands) {
        if (command.group && command.group !== group) { group = command.group; items.push({ label: group, kind: vscode.QuickPickItemKind.Separator }); }
        items.push({ label: command.command, description: command.argHint, detail: command.description, command: command.command });
      }
      const chosen = await vscode.window.showQuickPick(items, { title: 'ClikCode command', matchOnDetail: true });
      if (!chosen?.command) return;
      if (chosen.description) {
        const args = await vscode.window.showInputBox({ prompt: `${chosen.command} ${chosen.description}`, placeHolder: 'Leave empty to run it without arguments' });
        if (args === undefined) return;
        await slash(args.trim() ? `${chosen.command} ${args.trim()}` : chosen.command)();
        return;
      }
      await slash(chosen.command)();
    }),
    // A question passed as the argument (a keybinding's `args`) skips the box.
    vscode.commands.registerCommand('clikcode.askAboutSelection', async (asked?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      const mention = mentionFromEditor(editor);
      const selected = { path: mention.label, languageId: mention.languageId ?? '', startLine: mention.startLine ?? 1, endLine: mention.endLine ?? 1, text: mention.text ?? '' };
      const question = typeof asked === 'string' ? asked : await vscode.window.showInputBox({ prompt: `Ask ClikCode about ${selected.path}`, placeHolder: 'What do you want to know or change? (Enter with nothing: add it to the chat instead)' });
      if (question === undefined) return;
      const target = await shown();
      if (question.trim()) await target.send(questionWithSelection(question, selected));
      else { target.post({ type: 'mention', mention }); target.post({ type: 'focus' }); }
    }),
  );

  return {
    get state() { return sidebar.state; },
    onDidChange: sidebar.onDidChange,
    send: (text) => sidebar.send(text),
    open: (mode, sessionId) => sidebar.open(mode, sessionId),
    ready: () => sidebar.ensureStarted(),
    get active() { const target = active(); return { state: target.state, onDidChange: target.onDidChange }; },
    get tabs() { return tabs.size; },
    tabStates: () => [...tabs.values()].map((controller) => controller.state),
    probe: (action, selector, text) => {
      if (!testing) return Promise.reject(new Error('probes run only under the extension test host'));
      return active().probe(action, selector, text);
    },
  };
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function deactivate(): void {
  // Disposables registered on the context tear everything down.
}
