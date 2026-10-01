/** Messages between the extension host and a chat webview. */
import type { ChatModel } from './model';
import type { ModelPatch } from './model-patch';
import type { IdeChoice, IdePickItem, IdeQueryName, IdeUiRequest, IdeUiResult } from './protocol';

/** A composer attachment: a file (or a range of one) the next message names. */
export interface Mention {
  path: string;
  /** Workspace-relative, for display and for the prompt. */
  label: string;
  startLine?: number;
  endLine?: number;
  /** A selection's text, sent with the message as a fenced block. */
  text?: string;
  languageId?: string;
  /** What VS Code's Problems panel reports in it (in the selection, for a
   * selection): `line 12 error: Cannot find name 'x'. (ts 2304)`. */
  problems?: string[];
}

/** Screens the webview shows besides the chat. */
export type WebviewScreen = 'chat' | 'history' | 'accounts' | 'settings';

export type ToWebview =
  | { type: 'model'; model: ChatModel }
  /** What changed since the last `model` or `patch`. */
  | { type: 'patch'; patch: ModelPatch }
  | { type: 'setDraft'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'mention'; mention: Mention }
  /** The active editor's selection, or none: offered with the next message. */
  | { type: 'selection'; mention?: Mention }
  | { type: 'focus' }
  | { type: 'show'; screen: WebviewScreen }
  /** The answer to a `request`. */
  | { type: 'response'; id: string; ok: boolean; data?: unknown; error?: string }
  /** A terminal picker, drawn in the panel. */
  | { type: 'ui-request'; id: string; request: IdeUiRequest }
  | { type: 'ui-update'; id: string; items: readonly IdePickItem[] }
  | { type: 'ui-cancel'; id: string }
  /** Integration tests only (extensionMode Test): read or drive the DOM. */
  | { type: 'probe'; id: string; action: 'query' | 'click' | 'type' | 'key'; selector: string; text?: string };

export type WebviewRequest =
  | { method: 'query'; query: IdeQueryName; provider?: string; network?: boolean }
  | { method: 'choose'; choice: IdeChoice }
  /** Workspace files matching a partial path, for @-mentions. */
  | { method: 'files'; text: string }
  | { method: 'open'; mode: 'new' | 'continue' | 'resume'; sessionId?: string }
  /** Conversation in a new editor tab. */
  | { method: 'openInTab'; sessionId?: string }
  /** Continue a conversation in the integrated terminal: `clikcode sessions resume`. */
  | { method: 'openInTerminal'; sessionId: string }
  /** Files dropped on the composer (from the Explorer or an editor tab) as
   * @-mentions, by their URIs. */
  | { method: 'mentions'; uris: string[] }
  /** An image pasted into the composer, saved where the agent can read it. */
  | { method: 'saveImage'; name: string; dataBase64: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; id: string }
  | { type: 'cancel'; restoreDraft: boolean }
  /** Take a queued message back before its turn. */
  | { type: 'unqueue'; id: string }
  | { type: 'approve'; id: string; approved: boolean | 'always' }
  | { type: 'viewDiff'; id: string }
  /** A change a tool call made: shown in the diff editor, or undone.
   * `userIndex` names the finished turn it is in; none, the running one. */
  | { type: 'change'; action: 'view' | 'revert'; key: string; userIndex?: number }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'openLink'; href: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'request'; id: string; request: WebviewRequest }
  | { type: 'ui-response'; id: string; result: IdeUiResult }
  | { type: 'focusChanged'; focused: boolean }
  | { type: 'probeResult'; id: string; result: unknown }
  /** A page error, for the log. */
  | { type: 'log'; text: string };
