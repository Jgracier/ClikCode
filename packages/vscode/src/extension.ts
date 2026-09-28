/** ClikCode for VS Code: a chat panel on the user's installed ClikCode. */
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat-view';
import { ClikCodeController } from './controller';
import { questionWithSelection } from './editor-context';
import type { ChatModel } from './model';
import { INSTALL_COMMAND } from './runtime';
import { DiffDocuments } from './ui';

/** What activate() returns: used by the integration tests, and a stable
 * surface for anything else that wants to drive the chat. */
export interface ClikCodeApi {
  readonly state: ChatModel;
  onDidChange: vscode.Event<ChatModel>;
  send(text: string): Promise<void>;
  open(mode: 'new' | 'continue' | 'resume', sessionId?: string): Promise<void>;
  ready(): Promise<void>;
}

export function statusText(model: ChatModel): { text: string; tooltip: string } {
  if (model.connection === 'error' || model.connection === 'stopped') return { text: '$(warning) ClikCode', tooltip: model.connectionError ?? 'ClikCode is not running' };
  if (!model.sessionId) return { text: '$(comment-discussion) ClikCode', tooltip: 'Open the ClikCode chat' };
  const where = [model.harness ?? 'no provider', model.model].filter(Boolean).join(' · ');
  const tooltip = [
    model.title ?? 'New chat', `Provider: ${model.harness ?? '—'}`, `Model: ${model.model ?? 'default'}`,
    ...(model.account ? [`Account: ${model.account}`] : []), ...(model.effort ? [`Effort: ${model.effort}`] : []),
    ...(model.permissions ? [`Permissions: ${model.permissions}`] : []), ...(model.accountUsage ? [`Usage: ${model.accountUsage}`] : []),
  ].join('\n');
  return { text: `${model.running ? '$(sync~spin)' : '$(comment-discussion)'} ${where}`, tooltip };
}

export function activate(context: vscode.ExtensionContext): ClikCodeApi {
  const log = vscode.window.createOutputChannel('ClikCode');
  const diffs = new DiffDocuments();
  let controller!: ClikCodeController;
  const view = new ChatViewProvider(context.extensionUri, (message) => controller.onWebviewMessage(message));
  controller = new ClikCodeController(view, diffs, log);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'clikcode.focus';
  const paint = (model: ChatModel): void => {
    const { text, tooltip } = statusText(model);
    status.text = text;
    status.tooltip = tooltip;
  };
  paint(controller.state);
  status.show();

  const slash = (line: string) => async () => {
    await view.reveal();
    await controller.send(line);
  };

  context.subscriptions.push(
    log, status, controller,
    controller.onDidChange(paint),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(DiffDocuments.scheme, diffs),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('clikcode.path') || event.affectsConfiguration('clikcode.nodePath')) void controller.restart();
    }),
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelType, {
      deserializeWebviewPanel: async (panel) => { view.restorePanel(panel); },
    }),
    vscode.commands.registerCommand('clikcode.openInEditor', () => view.openInEditor()),
    vscode.commands.registerCommand('clikcode.focus', async () => { await view.reveal(); view.post({ type: 'focus' }); }),
    vscode.commands.registerCommand('clikcode.newChat', async () => { await view.reveal(); await controller.open('new'); }),
    vscode.commands.registerCommand('clikcode.resumeChat', slash('/resume')),
    vscode.commands.registerCommand('clikcode.chooseProvider', slash('/provider')),
    vscode.commands.registerCommand('clikcode.chooseModel', slash('/model')),
    vscode.commands.registerCommand('clikcode.chooseAccount', slash('/account')),
    vscode.commands.registerCommand('clikcode.chooseEffort', slash('/effort')),
    vscode.commands.registerCommand('clikcode.choosePermissions', slash('/permissions')),
    vscode.commands.registerCommand('clikcode.openSettings', slash('/settings')),
    vscode.commands.registerCommand('clikcode.cancel', () => controller.cancel(true)),
    vscode.commands.registerCommand('clikcode.restart', () => controller.restart()),
    vscode.commands.registerCommand('clikcode.showLog', () => log.show()),
    vscode.commands.registerCommand('clikcode.install', async () => {
      const terminal = vscode.window.createTerminal({ name: 'Install ClikCode' });
      terminal.show();
      terminal.sendText(INSTALL_COMMAND);
      const choice = await vscode.window.showInformationMessage('When the install finishes, reconnect ClikCode.', 'Reconnect');
      if (choice) await controller.restart();
    }),
    vscode.commands.registerCommand('clikcode.runSlashCommand', async () => {
      let commands;
      try { commands = await controller.slashCommands(); } catch (error) {
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
      const { document, selection } = editor;
      const selected = {
        path: vscode.workspace.asRelativePath(document.uri, false),
        languageId: document.languageId,
        startLine: selection.start.line + 1,
        endLine: selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1,
        text: document.getText(selection),
      };
      const question = typeof asked === 'string' ? asked : await vscode.window.showInputBox({ prompt: `Ask ClikCode about ${selected.path}`, placeHolder: 'What do you want to know or change? (Enter with nothing: put it in the chat box instead)' });
      if (question === undefined) return;
      await view.reveal();
      if (question.trim()) await controller.send(questionWithSelection(question, selected));
      else view.post({ type: 'insert', text: questionWithSelection('', selected).trim() });
    }),
    vscode.commands.registerCommand('clikcode.attachFile', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') {
        void vscode.window.showInformationMessage('Open a file to attach it.');
        return;
      }
      await view.reveal();
      await controller.send(`/mention ${target.fsPath}`);
    }),
  );

  return {
    get state() { return controller.state; },
    onDidChange: controller.onDidChange,
    send: (text) => controller.send(text),
    open: (mode, sessionId) => controller.open(mode, sessionId),
    ready: () => controller.ensureStarted(),
  };
}

export function deactivate(): void {
  // Disposables registered on the context tear everything down.
}
