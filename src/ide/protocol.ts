/** What an editor extension and `clikcode ide-bridge` say to each other.
 *
 * The bridge is the editor's ClikCode client: the same job the interactive
 * terminal does (attach to the conversation's worker, prepare what a turn
 * needs, drain queued messages, run the pickers), with the editor's own
 * widgets where the terminal draws its own. It runs as the user's installed
 * ClikCode, not a copy inside the extension, so the build the editor talks to
 * is the build the terminal talks to -- a second build would retire the
 * other client's workers on every attach (see worker/client.ts).
 *
 * Carried over Node's IPC channel, not stdio: vendor CLIs the bridge starts
 * inherit its stdout, and one stray line there must not be able to corrupt
 * the conversation. stdout and stderr are logs.
 *
 * Every worker event reaches the editor unchanged inside a `worker` message,
 * so a worker that learns a new event needs no change here -- and an editor
 * that does not know one ignores it.
 */
import type { ConversationSection, TurnFacts } from '../session/conversation-state.js';
import type { HarnessSession } from '../session/model.js';
import type { ClientCommand, WorkerEvent } from '../worker/protocol.js';

export type { ClientCommand, WorkerEvent };

/** One row of a picker. `actions` and `deleteAction` are the row's Tab
 * and Delete actions in the terminal picker; `inline` is a setting cycled in
 * place. */
export interface IdePickItem {
  label: string;
  detail?: string;
  group?: string;
  argHint?: string;
  actions?: ReadonlyArray<{ label: string; value: string }>;
  deleteAction?: { label: string; value: string };
  inline?: { choices: ReadonlyArray<{ label: string; value: string }>; current: string };
}

export type IdeUiRequest =
  | { kind: 'pick'; title: string; items: readonly IdePickItem[]; canGoBack: boolean }
  | { kind: 'input'; prompt: string; secret?: boolean };

/** `index` is into the items last sent for this request (an update replaces
 * them); `action` is one of that row's action values, or its deleteAction's;
 * `value`, for an inline row, the choice to set (absent: the next one, as
 * the terminal's →). */
export type IdeUiResult =
  | { cancelled: true; back?: boolean }
  | { index: number; action?: string; value?: string }
  | { text: string };

export type IdeRequest =
  /** Show a conversation: `resume` an id, `continue` the workspace's latest,
   * or start a `new` one in `workspace`. */
  | { type: 'open'; requestId: string; workspace: string; mode: 'new' | 'continue' | 'resume'; sessionId?: string; features?: readonly IdeFeature[] }
  /** A composer line, exactly as typed: conversation, `/command`, or `!shell`.
   * During a turn it steers (or queues); `id` comes back on the worker's
   * `submission` event. */
  | { type: 'send'; text: string; id?: string }
  | { type: 'cancel'; restoreDraft: boolean }
  /** Enter again: the oldest queued user message goes into the running turn. */
  | { type: 'send-queued' }
  /** Take a queued message back before its turn (see the worker's `unqueue`). */
  | { type: 'unqueue'; id: string }
  | { type: 'approval-response'; id: string; approved: boolean | 'always' }
  | { type: 'ui-response'; id: string; result: IdeUiResult }
  | { type: 'sign-in-result'; id: string; error?: string }
  /** Stop the link sign-in a `sign-in-link` event is showing. */
  | { type: 'sign-in-cancel'; id: string }
  /** Data for the editor's own screens. Only `slash-commands` before
   * revision 2 (a bridge from then answers every query with the command list,
   * so an editor checks `ready.revision` before asking for anything else). */
  | { type: 'query'; requestId: string; query: IdeQueryName; provider?: string; network?: boolean }
  /** A choice made in the editor's own widgets, applied as the terminal's
   * picker would apply it (revision 2). Answered by a `result`. */
  | { type: 'choose'; requestId: string; choice: IdeChoice }
  /** The conversations list is open (`on`) or closed in the editor: while
   * one is open the bridge sends `conversations-changed`. Counted, so two
   * open lists need two closes. An older bridge ignores it. */
  | { type: 'watch-conversations'; on: boolean }
  /** A key while /search walks mentions (`search` events): ↓ next, ↑
   * previous, Tab the next conversation, Esc done. */
  | { type: 'search-key'; key: 'next' | 'previous' | 'chat' | 'done' }
  | { type: 'close' };

/** What an editor handles beyond the base protocol, named with `open`; the
 * bridge uses one only when the editor names it, so an older editor keeps
 * the old behaviour. `copy`: /copy sends the text (a `copy` event) for the
 * editor's own clipboard. `search-walk`: /search walks mention by mention
 * (`search` events, answered by `search-key`) instead of a results panel. */
export type IdeFeature = 'copy' | 'search-walk';

/** Where /search is: the conversation open in the editor, the message and
 * which occurrence of the first word in it, the words to mark, and the line
 * that says where the walk is and which keys move it. */
export interface IdeSearchFocus { sessionId: string; messageIndex: number; occurrence: number; words: string[]; status: string }

export interface IdeSlashCommand {
  command: string; description: string; argHint?: string; group?: string;
  /** Other names the command answers to. */
  aliases?: readonly string[];
  /** The values its argument takes (models, effort levels, accounts, chats),
   * as the terminal's palette completes them when the list was read. */
  argValues?: ReadonlyArray<{ value: string; label?: string; detail?: string }>;
}

// ---- revision 2: structured data for the editor's screens -----------------

export type IdeQueryName = 'slash-commands' | 'providers' | 'models' | 'conversations' | 'accounts' | 'chat-settings' | 'gateway';

/** One thing a conversation can run on: a vendor harness, ClikDeploy
 * Gateway, or ClikCode Local. `id` is what `choose` takes back. */
export interface IdeProvider {
  id: string;
  kind: 'harness' | 'gateway' | 'clikcode-local';
  name: string;
  installed: boolean;
  version?: string;
  /** `auto`: choosing it installs it; `manual`: the user installs it. */
  install: 'ready' | 'auto' | 'manual';
  integration?: string;
  /** A ready account, a credential the vendor keeps on disk, or a Gateway key. */
  signedIn: boolean;
  current: boolean;
  /** Whether it has a model list to choose from. */
  choosesModel: boolean;
}

/** How the chat's model reads beside its provider (`big-pickle` for
 * OpenCode's `opencode/big-pickle`), for the model it names: the session's
 * reported model, else its chosen one. Display only; ids stay as they are. */
export interface IdeModelLabel { model: string; label: string }

export interface IdeModel {
  id: string;
  /** How the model reads beside its provider; `id` is what is sent. */
  label: string;
  detail?: string;
  current: boolean;
  /** Listed but not choosable here, and why (a local model that does not fit). */
  unavailable?: string;
}

/** A Gateway agent private to the connected account (`GET /v1/agents`). */
export interface IdeAgent {
  id: string;
  name: string;
  detail?: string;
  /** Selected for this chat: its turns run as this agent. */
  current: boolean;
}

export interface IdeModels {
  provider: string;
  models: IdeModel[];
  /** The Gateway only: the account's agents, listed before its models. Never
   * cached by the editor across accounts; the bridge asks with the current key. */
  agents?: IdeAgent[];
  /** Why the agent roster could not be read; the models still list. */
  agentsError?: string;
  /** The terminal offers "Enter a model ID…" here. */
  custom: boolean;
  error?: string;
}

export interface IdeConversation {
  id: string;
  title: string;
  /** Not drawn on the row; the history menu's search still matches it. */
  provider?: string;
  updatedAt: string;
  messages: number;
  /** First words of the last thing the user asked, for the list. */
  preview?: string;
  activity?: 'working' | 'idle';
  /** The generating turn, when `working`: what the row's state is read from
   * (conversationState). Absent from a bridge before this field. */
  turn?: TurnFacts;
  /** An approval in it is waiting on the user. */
  needsYou?: boolean;
  /** A turn parked until the quota resets: when it sends again. */
  resumeAt?: string;
  /** Where the terminal board lists it: Working (generating), Recent (last
   * 24 hours), Older. Absent from a bridge before this field. */
  section?: ConversationSection;
  current: boolean;
}

export interface IdeUsageWindow { name: string; usedPct: number; resetsAt?: string }

export interface IdeAccount {
  id: string;
  provider: string;
  /** The harness that signs it in. */
  harness?: string;
  providerName: string;
  label: string;
  status: 'ready' | 'needs_login' | 'offline';
  problem?: 'verify' | 'reauth' | 'out-of-usage';
  /** With 'out-of-usage': when it is back, where something says (accountBackAt). */
  backAt?: string;
  current: boolean;
  /** `learned`: estimated from the account's own refusals, for a harness
   *  that reports no usage. */
  usage?: { label?: string; windows: IdeUsageWindow[]; learned?: boolean };
  actions: Array<'reauthenticate' | 'disconnect' | 'remove' | 'verified'>;
}

export interface IdeAccounts {
  accounts: IdeAccount[];
  /** Harnesses an account can be added to, by `choose add-account`. */
  addable: Array<{ provider: string; name: string }>;
  /** The provider this chat runs on, as the bridge reads it now: what the
   * account menu titles, lists and adds to. The panel's own copy can lag a
   * switch, and a menu built from both once added a Grok account under a
   * Copilot title. Absent on the Gateway and ClikCode Local. */
  chat?: { provider: string; name: string };
}

export interface IdeChatSettings {
  effort?: { current?: string; choices: string[] };
  permissions?: { current: string; choices: string[] };
  plan?: boolean;
  fast?: boolean;
  /** One switch. Off until this chat turns it on. `current` and `choices`
   * stay so an editor from before the switch still renders one On row. */
  swarm?: { enabled: boolean; current?: string[]; choices?: Array<{ id: string; label: string; detail: string }> };
  /** `/send`: what a message typed mid-turn does, in every chat. */
  send?: 'steer' | 'queue';
}

export interface IdeGateway {
  connected: boolean;
  apiUrl: string;
  credit?: { unlimited: boolean; balanceUsd?: number; allowed?: boolean; autoTopUp?: boolean };
  error?: string;
}

export type IdeChoice =
  /** Move this chat onto a provider (in place, history and all),
   * then optionally a model on it. */
  | { kind: 'provider'; provider: string; model?: string }
  | { kind: 'model'; model: string }
  /** Run this Gateway chat as one of the account's agents; null for none. */
  | { kind: 'agent'; agent: string | null }
  | { kind: 'effort'; value: string }
  | { kind: 'permissions'; value: string }
  | { kind: 'plan'; on: boolean }
  /** ClikDeploy Gateway: served by the fastest provider instead of the cheapest. */
  | { kind: 'fast'; on: boolean }
  /** Turn swarm on or off. `names` is the editor from before the switch:
   * any name meant on, and an empty list meant off. */
  | { kind: 'swarm'; enabled?: boolean; names?: string[] }
  | { kind: 'account'; accountId: string }
  | { kind: 'add-account'; provider: string }
  | { kind: 'account-action'; accountId: string; action: 'reauthenticate' | 'disconnect' | 'remove' | 'verified' }
  /** Fork and archive are slash commands (/fork, /archive). */
  | { kind: 'conversation'; sessionId: string; action: 'rename' | 'delete'; name?: string }
  /** A Stripe checkout page for Gateway credit: `data.url`. */
  | { kind: 'gateway-credit' };

export type IdeEvent =
  /** `protocol` is IDE_PROTOCOL.version (protocol-version.ts); a ClikCode
   * from before it sends none. `revision` is IDE_PROTOCOL.revision: which
   * additive requests it understands (absent: 1). */
  | { type: 'ready'; version: string; protocol?: number; revision?: number; build?: string; pid: number }
  /** The conversation shown, from the state file: on open, on a switch, and
   * after anything that changed it outside a turn. */
  | { type: 'session'; session: HarnessSession; account?: string; modelLabel?: IdeModelLabel }
  | { type: 'worker'; sessionId: string; event: WorkerEvent }
  /** This client submitted a turn; `prompt` is what to show as the user's
   * message until the worker's snapshot carries it (absent for synthetic
   * prompts such as /review). */
  | { type: 'turn-start'; sessionId: string; prompt?: string; queuedTurnId?: string }
  /** Work outside a turn the user is waiting on (a picker's lookups, a local
   * model loading); undefined label when it is over. */
  | { type: 'busy'; label?: string }
  | { type: 'notice'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'panel'; title: string; body: string }
  /** A command's structured result, as `--json` would print it. */
  | { type: 'output'; payload: Record<string, unknown> }
  | { type: 'restore-draft'; text: string }
  | { type: 'ui-request'; id: string; request: IdeUiRequest }
  | { type: 'ui-update'; id: string; items: readonly IdePickItem[] }
  /** Run `clikcode ide-terminal <spec>` in a terminal; answer sign-in-result
   * when it exits. */
  | { type: 'sign-in'; id: string; name: string; spec: string; environment: Record<string, string> }
  /** A link sign-in running in the bridge: show the link and code, open the
   * link, and offer `sign-in-cancel`. Sent again if the code arrives later;
   * `done` when it is over, however it ended. */
  | { type: 'sign-in-link'; id: string; name: string; url?: string; code?: string; done?: boolean }
  | { type: 'open-file'; path: string }
  | { type: 'usage'; label?: string; reset?: string }
  /** /copy: put this on the editor's clipboard (`copy` feature). */
  | { type: 'copy'; text: string }
  /** /search walking mentions (`search-walk` feature): show this one;
   * no `focus` when the walk is over. */
  | { type: 'search'; focus?: IdeSearchFocus }
  | { type: 'result'; requestId: string; ok: boolean; error?: string; data?: unknown }
  /** The conversation was left (/exit, /archive, /delete). */
  | { type: 'closed'; sessionId: string }
  /** Something a conversations list shows may have changed (a turn started
   * or ended, a worker exited): query it again. Sent while a list is open. */
  | { type: 'conversations-changed' };

/** What `ide-terminal` runs: one of a vendor's own interactive commands,
 * with a real terminal. Base64 JSON on the command line, so no shell ever
 * re-parses an argv the vendor published. */
export interface IdeTerminalSpec { command: string; mode: 'run'; argv: readonly string[] }

export function encodeTerminalSpec(spec: IdeTerminalSpec): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

export function decodeTerminalSpec(encoded: string): IdeTerminalSpec {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<IdeTerminalSpec>;
  if (typeof parsed.command !== 'string' || parsed.mode !== 'run' || !Array.isArray(parsed.argv)) {
    throw new Error('not an ide-terminal spec');
  }
  return { command: parsed.command, mode: parsed.mode, argv: parsed.argv.map(String) };
}
