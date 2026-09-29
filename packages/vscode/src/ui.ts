/** The bridge's questions (the terminal pickers) as VS Code quick picks and
 * input boxes; approval diffs as diff editors; sign-ins in terminals. */
import * as vscode from 'vscode';
import type { IdePickItem, IdeUiRequest, IdeUiResult } from './protocol';

interface PickEntry extends vscode.QuickPickItem { index?: number }
interface ActionButton extends vscode.QuickInputButton { action: string; destructive: boolean }

const ACTION_ICONS: Record<string, string> = { reauthenticate: 'key', disconnect: 'debug-disconnect', history: 'history', verified: 'pass' };

export function pickEntries(items: readonly IdePickItem[]): PickEntry[] {
  const entries: PickEntry[] = [];
  let group: string | undefined;
  items.forEach((item, index) => {
    if (item.group && item.group !== group) {
      group = item.group;
      entries.push({ label: item.group, kind: vscode.QuickPickItemKind.Separator });
    }
    const inline = item.inline
      ? item.inline.choices.map((choice) => (choice.value === item.inline!.current ? `[${choice.label}]` : choice.label)).join('  ')
      : undefined;
    const buttons: ActionButton[] = [
      ...(item.actions ?? []).map((action) => ({ iconPath: new vscode.ThemeIcon(ACTION_ICONS[action.value] ?? 'ellipsis'), tooltip: action.label, action: action.value, destructive: false })),
      ...(item.deleteAction ? [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: item.deleteAction.label, action: item.deleteAction.value, destructive: true }] : []),
    ];
    entries.push({
      label: item.argHint ? `${item.label} ${item.argHint}` : item.label,
      ...(item.detail || inline ? { description: [inline, item.detail].filter(Boolean).join(' · ') } : {}),
      ...(buttons.length ? { buttons } : {}),
      index,
    });
  });
  return entries;
}

/** One open question from the bridge. `update` replaces the rows of an open
 * pick (usage figures arriving); `dispose` abandons it. */
export class BridgeQuestion {
  private pick: vscode.QuickPick<PickEntry> | undefined;

  constructor(private readonly request: IdeUiRequest, private readonly answer: (result: IdeUiResult) => void) {}

  show(): void {
    const request = this.request;
    if (request.kind === 'input') {
      void vscode.window.showInputBox({ prompt: request.prompt, ignoreFocusOut: true }).then((text) => {
        this.answer(text === undefined ? { cancelled: true } : { text });
      });
      return;
    }
    const pick = vscode.window.createQuickPick<PickEntry>();
    this.pick = pick;
    pick.title = request.title;
    pick.matchOnDescription = true;
    pick.ignoreFocusOut = false;
    pick.items = pickEntries(request.items);
    if (request.canGoBack) pick.buttons = [vscode.QuickInputButtons.Back];
    let answered = false;
    const finish = (result: IdeUiResult): void => {
      if (answered) return;
      answered = true;
      this.answer(result);
      pick.hide();
    };
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0] ?? pick.activeItems[0];
      if (chosen?.index !== undefined) finish({ index: chosen.index });
    });
    pick.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) finish({ cancelled: true, back: true }); });
    pick.onDidTriggerItemButton(async ({ item, button }) => {
      const action = button as ActionButton;
      if (item.index === undefined) return;
      if (action.destructive) {
        const confirmed = await vscode.window.showWarningMessage(`${action.tooltip ?? 'Delete'}: ${item.label}?`, { modal: true }, 'Delete');
        if (confirmed !== 'Delete') return;
      }
      finish({ index: item.index, action: action.action });
    });
    pick.onDidHide(() => { finish({ cancelled: true }); pick.dispose(); });
    pick.show();
  }

  update(items: readonly IdePickItem[]): void {
    if (!this.pick) return;
    const active = this.pick.activeItems[0]?.index;
    const entries = pickEntries(items);
    this.pick.items = entries;
    const again = entries.find((entry) => entry.index === active);
    if (again) this.pick.activeItems = [again];
  }

  dispose(): void {
    this.pick?.hide();
  }
}

/** Before/after documents for approval diffs, served from memory. */
export class DiffDocuments implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'clikcode-diff';
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  async show(id: string, title: string, before: string, after: string, fileName = 'change'): Promise<void> {
    const safeName = fileName.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'change';
    const left = vscode.Uri.from({ scheme: DiffDocuments.scheme, path: `/${id}/before/${safeName}` });
    const right = vscode.Uri.from({ scheme: DiffDocuments.scheme, path: `/${id}/after/${safeName}` });
    this.contents.set(left.toString(), before);
    this.contents.set(right.toString(), after);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${title} (ClikCode proposes)`, { preview: true, preserveFocus: true });
  }

  /** The approval a diff editor's document belongs to. */
  static approvalOf(uri: vscode.Uri | undefined): string | undefined {
    if (uri?.scheme !== DiffDocuments.scheme) return undefined;
    return uri.path.split('/')[1] || undefined;
  }

  forget(id: string): void {
    for (const key of [...this.contents.keys()]) if (key.includes(`/${id}/`)) this.contents.delete(key);
  }
}

/** A file name worth giving the diff editor (for syntax colouring), taken
 * from the approval's title or detail when one names a path. */
export function fileNameIn(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    const match = text?.match(/([\w./-]+\.[A-Za-z0-9]{1,8})\b/);
    if (match) return match[1]!.split('/').pop();
  }
  return undefined;
}

/** Runs `clikcode ide-terminal` in a terminal and resolves with its outcome
 * when the terminal closes. */
export function runInTerminal(options: { name: string; node: string; args: string[]; env: Record<string, string>; cwd?: string }): Promise<void> {
  const terminal = vscode.window.createTerminal({
    name: `ClikCode: ${options.name}`,
    shellPath: options.node,
    shellArgs: options.args,
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    iconPath: new vscode.ThemeIcon('key'),
  });
  terminal.show();
  return new Promise((resolve, reject) => {
    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      listener.dispose();
      const code = closed.exitStatus?.code;
      if (code === 0) resolve();
      else reject(new Error(code === undefined ? `${options.name} was closed before it finished` : `${options.name} ended with exit code ${code}`));
    });
  });
}
