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
import type { HarnessSession } from '../session/model.js';
import type { ClientCommand, WorkerEvent } from '../worker/protocol.js';

export type { ClientCommand, WorkerEvent };
export { IDE_PROTOCOL } from './protocol-version.js';

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
  | { kind: 'input'; prompt: string };

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
  | { type: 'open'; requestId: string; workspace: string; mode: 'new' | 'continue' | 'resume'; sessionId?: string }
  /** A composer line, exactly as typed: conversation, `/command`, or `!shell`.
   * During a turn it steers (or queues); `id` comes back on the worker's
   * `submission` event. */
  | { type: 'send'; text: string; id?: string }
  | { type: 'cancel'; restoreDraft: boolean }
  /** Take a queued message back before its turn (see the worker's `unqueue`). */
  | { type: 'unqueue'; id: string }
  | { type: 'approval-response'; id: string; approved: boolean | 'always' }
  | { type: 'ui-response'; id: string; result: IdeUiResult }
  | { type: 'sign-in-result'; id: string; error?: string }
  /** Data for the editor's own screens. Only `slash-commands` before
   * revision 2 (a bridge from then answers every query with the command list,
   * so an editor checks `ready.revision` before asking for anything else). */
  | { type: 'query'; requestId: string; query: IdeQueryName; provider?: string; network?: boolean }
  /** A choice made in the editor's own widgets, applied as the terminal's
   * picker would apply it (revision 2). Answered by a `result`. */
  | { type: 'choose'; requestId: string; choice: IdeChoice }
  | { type: 'refresh' }
  | { type: 'close' };

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
  accounts: number;
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

export interface IdeModels {
  provider: string;
  models: IdeModel[];
  /** The model a new chat on it would use when none is chosen. */
  current?: string;
  /** The terminal offers "Enter a model ID…" here. */
  custom: boolean;
  error?: string;
}

export interface IdeConversation {
  id: string;
  title: string;
  provider?: string;
  /** Its label beside `provider`, not the stored id. */
  model?: string;
  workspace?: string;
  updatedAt: string;
  messages: number;
  /** First words of the last message, for the list. */
  preview?: string;
  activity?: 'working' | 'idle';
  current: boolean;
  /** Another terminal holds it right now. */
  elsewhere: boolean;
  /** Provider hops and forks behind it. */
  history: number;
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
  current: boolean;
  usage?: { label?: string; windows: IdeUsageWindow[]; learned?: boolean };
  actions: Array<'reauthenticate' | 'disconnect' | 'remove' | 'verified'>;
}

export interface IdeAccounts {
  accounts: IdeAccount[];
  /** Harnesses an account can be added to, by `choose add-account`. */
  addable: Array<{ provider: string; name: string }>;
  /** This chat's: switch accounts automatically when one runs out. */
  failover: 'auto' | 'never';
}

export interface IdeChatSettings {
  effort?: { current?: string; choices: string[] };
  permissions?: { current: string; choices: string[] };
  failover?: 'auto' | 'never';
  plan?: boolean;
  fast?: boolean;
  /** Harness-specific options (the /options list), counted. */
  options?: { available: number; set: number };
}

export interface IdeGateway {
  connected: boolean;
  apiUrl: string;
  credit?: { unlimited: boolean; balanceUsd?: number; allowed?: boolean; autoTopUp?: boolean };
  error?: string;
}

export type IdeChoice =
  /** Move this chat onto a provider (in place when empty, else a handoff),
   * then optionally a model on it. */
  | { kind: 'provider'; provider: string; model?: string }
  | { kind: 'model'; model: string }
  | { kind: 'effort'; value: string }
  | { kind: 'permissions'; value: string }
  | { kind: 'failover'; value: 'auto' | 'never' }
  | { kind: 'plan'; on: boolean }
  /** ClikDeploy Gateway: served by the fastest provider instead of the cheapest. */
  | { kind: 'fast'; on: boolean }
  | { kind: 'account'; accountId: string }
  | { kind: 'add-account'; provider: string }
  | { kind: 'account-action'; accountId: string; action: 'reauthenticate' | 'disconnect' | 'remove' | 'verified' }
  | { kind: 'conversation'; sessionId: string; action: 'rename' | 'fork' | 'archive' | 'delete'; name?: string }
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
  | { type: 'turn-end'; sessionId: string; error?: string }
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
  | { type: 'open-file'; path: string }
  | { type: 'usage'; label?: string; reset?: string }
  | { type: 'result'; requestId: string; ok: boolean; error?: string; data?: unknown }
  /** The conversation was left (/exit, /archive, /delete). */
  | { type: 'closed'; sessionId: string };

/** What `ide-terminal` runs: a vendor's sign-in, or one of its own commands,
 * with a real terminal. Base64 JSON on the command line, so no shell ever
 * re-parses an argv the vendor published. */
export interface IdeTerminalSpec { command: string; mode: 'login' | 'run'; argv: readonly string[] }

export function encodeTerminalSpec(spec: IdeTerminalSpec): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

export function decodeTerminalSpec(encoded: string): IdeTerminalSpec {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<IdeTerminalSpec>;
  if (typeof parsed.command !== 'string' || (parsed.mode !== 'login' && parsed.mode !== 'run') || !Array.isArray(parsed.argv)) {
    throw new Error('not an ide-terminal spec');
  }
  return { command: parsed.command, mode: parsed.mode, argv: parsed.argv.map(String) };
}
