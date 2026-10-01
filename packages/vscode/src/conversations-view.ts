/** The conversations, as a list in VS Code's own side bar: what each one is
 * doing (working, waiting on an answer, finished while nobody looked), and a
 * click that brings it up -- its open tab if it has one, a new tab if not. */
import * as vscode from 'vscode';
import type { ClikCodeController } from './controller';
import type { IdeConversation } from './protocol';
import { relativeTime } from './webview/format';
import { conversationState, type ConversationState } from './conversation-state';

const ICON: Record<ConversationState, vscode.ThemeIcon> = {
  'needs-input': new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('editorWarning.foreground')),
  working: new vscode.ThemeIcon('loading~spin'),
  unread: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('textLink.foreground')),
  idle: new vscode.ThemeIcon('comment-discussion'),
};

const STATE_WORDS: Record<ConversationState, string> = {
  'needs-input': 'Waiting for your answer', working: 'Working', unread: 'Finished', idle: '',
};

/** How often an on-screen list re-reads what other windows changed. */
const REFRESH_MS = 15_000;

export class ConversationsView implements vscode.TreeDataProvider<IdeConversation>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private rows: IdeConversation[] = [];
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<IdeConversation> | undefined;

  constructor(
    /** Every open chat; the first that can answer reads the list. */
    private readonly chats: () => ClikCodeController[],
  ) {}

  attach(view: vscode.TreeView<IdeConversation>): void {
    this.view = view;
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); this.schedule(); });
    this.schedule();
  }

  /** Re-read the list (debounced: a stream of chat changes is one read). */
  refresh(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = undefined; void this.load(); }, 250);
  }

  /** A chat changed what it shows: only the states need repainting. */
  repaint(): void {
    this.changed.fire();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = this.view?.visible ? setInterval(() => { void this.load(); }, REFRESH_MS) : undefined;
  }

  private async load(): Promise<void> {
    if (this.view && !this.view.visible) return;
    const chats = this.chats();
    // Any chat already connected answers; failing that the side bar's
    // connects to (it is the one chat that is always there).
    for (const [index, chat] of [...chats, ...chats.slice(0, 1)].entries()) {
      const rows = await chat.conversations(index === chats.length).catch(() => undefined);
      if (!rows) continue;
      this.rows = rows;
      this.changed.fire();
      return;
    }
  }

  getChildren(element?: IdeConversation): IdeConversation[] {
    if (element) return [];
    if (!this.rows.length) void this.load();
    return this.rows;
  }

  getTreeItem(conversation: IdeConversation): vscode.TreeItem {
    const open = this.chats().map((chat) => ({ sessionId: chat.state.sessionId, approvals: chat.state.approvals.length, running: chat.state.running, unread: chat.unread }));
    const state = conversationState(conversation, open);
    const item = new vscode.TreeItem(conversation.title || 'New chat', vscode.TreeItemCollapsibleState.None);
    item.id = conversation.id;
    item.iconPath = ICON[state];
    item.description = [STATE_WORDS[state], conversation.provider, relativeTime(conversation.updatedAt)].filter(Boolean).join(' · ');
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(conversation.title || 'New chat')}**\n\n`);
    if (conversation.preview) tooltip.appendMarkdown(`${escape(conversation.preview)}\n\n`);
    tooltip.appendMarkdown([conversation.provider, conversation.model, `${conversation.messages} message${conversation.messages === 1 ? '' : 's'}`].filter(Boolean).map((part) => escape(part!)).join(' · '));
    item.tooltip = tooltip;
    item.contextValue = 'conversation';
    item.command = { command: 'clikcode.showConversation', title: 'Open', arguments: [conversation.id] };
    return item;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.changed.dispose();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
