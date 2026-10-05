/** Messages between the extension host and a chat webview. */
import type { ChatModel } from './model';
import type { ModelPatch } from './model-patch';
import type { IdeChoice, IdeConversation, IdePickItem, IdeQueryName, IdeUiRequest, IdeUiResult } from './protocol';

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
  /** A file that is an image: attached as one, not mentioned. */
  image?: boolean;
}

/** A row of the conversations list, as the extension answers `query
 * conversations`: marked when another chat showing it wants the user. */
export type ListedConversation = IdeConversation & { attention?: 'waiting' | 'unread' };

/** The lists a command can drop over the chat: the conversations, or the
 * chat's account menu. */
export type WebviewMenu = 'history' | 'accounts';

export type ToWebview =
  | { type: 'model'; model: ChatModel }
  /** What changed since the last `model` or `patch`. */
  | { type: 'patch'; patch: ModelPatch }
  | { type: 'setDraft'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'mention'; mention: Mention }
  | { type: 'focus' }
  | { type: 'show'; menu: WebviewMenu }
  /** The answer to a `request`. */
  | { type: 'response'; id: string; ok: boolean; data?: unknown; error?: string }
  /** A terminal picker, drawn in the panel. */
  | { type: 'ui-request'; id: string; request: IdeUiRequest }
  | { type: 'ui-update'; id: string; items: readonly IdePickItem[] }
  | { type: 'ui-cancel'; id: string }
  /** ClikCode saw the conversations change: an open list re-queries. */
  | { type: 'conversations-changed' }
  /** The view was shown or hidden. A retained page keeps running while
   * hidden, so it pauses its clock on this (webview/clock.ts). */
  | { type: 'visible'; visible: boolean }
  /** Integration tests only (extensionMode Test): read or drive the DOM. */
  | { type: 'probe'; id: string; action: 'query' | 'click' | 'type' | 'key' | 'paste'; selector: string; text?: string };

export type WebviewRequest =
  | { method: 'query'; query: IdeQueryName; provider?: string; network?: boolean }
  | { method: 'choose'; choice: IdeChoice }
  /** A conversations list opened (`on`) or closed: ClikCode tells it of
   * changes while it is open. */
  | { method: 'watchConversations'; on: boolean }
  /** Workspace files matching a partial path, for @-mentions. */
  | { method: 'files'; text: string }
  /** `resume` of a conversation another chat shows brings that chat up instead. */
  | { method: 'open'; mode: 'new' | 'continue' | 'resume'; sessionId?: string }
  /** Conversation in a new editor tab. */
  | { method: 'openInTab'; sessionId?: string }
  /** Files dropped on the composer (from the Explorer or an editor tab) as
   * @-mentions, by their URIs. */
  | { method: 'mentions'; uris: string[] }
  /** Pasted text, asked whether it refers to copied lines or files. */
  | { method: 'paste'; text: string }
  /** An image pasted into the composer, saved where the agent can read it. */
  | { method: 'saveImage'; name: string; dataBase64: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; id: string }
  | { type: 'cancel'; restoreDraft: boolean }
  /** Take a queued message back before its turn. `edit`: and put its text
   * back in the composer -- once the worker says it was still the user's to
   * take (a message already steered in stays sent, as in the terminal). */
  | { type: 'unqueue'; id: string; edit?: boolean }
  | { type: 'approve'; id: string; approved: boolean | 'always' }
  | { type: 'viewDiff'; id: string }
  /** A change a tool call made: shown in the diff editor, or undone.
   * `userIndex` names the finished turn it is in; none, the running one. */
  | { type: 'change'; action: 'view' | 'revert'; key: string; userIndex?: number }
  /** Every change a finished turn made: shown together in the diff editor,
   * or all undone. */
  | { type: 'turnChanges'; action: 'view' | 'revert'; userIndex: number }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'openLink'; href: string }
  /** Stop the link sign-in the card shows. */
  | { type: 'signInCancel'; id: string }
  /** Open the sign-in card's link again. */
  | { type: 'signInOpen'; url: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'request'; id: string; request: WebviewRequest }
  | { type: 'ui-response'; id: string; result: IdeUiResult }
  | { type: 'focusChanged'; focused: boolean }
  | { type: 'probeResult'; id: string; result: unknown }
  /** A page error, for the log. */
  | { type: 'log'; text: string };
