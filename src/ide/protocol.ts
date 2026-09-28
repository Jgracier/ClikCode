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

/** One row of a quick pick. `actions` and `deleteAction` are the row's Tab
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
 * them); `action` is one of that row's action values, or its deleteAction's. */
export type IdeUiResult =
  | { cancelled: true; back?: boolean }
  | { index: number; action?: string }
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
  | { type: 'approval-response'; id: string; approved: boolean | 'always' }
  | { type: 'ui-response'; id: string; result: IdeUiResult }
  | { type: 'sign-in-result'; id: string; error?: string }
  | { type: 'query'; requestId: string; query: 'slash-commands' }
  | { type: 'refresh' }
  | { type: 'close' };

export interface IdeSlashCommand { command: string; description: string; argHint?: string; group?: string }

export type IdeEvent =
  /** `protocol` is IDE_PROTOCOL.version (protocol-version.ts); a ClikCode
   * from before it sends none. */
  | { type: 'ready'; version: string; protocol?: number; build?: string; pid: number }
  /** The conversation shown, from the state file: on open, on a switch, and
   * after anything that changed it outside a turn. */
  | { type: 'session'; session: HarnessSession; account?: string }
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
