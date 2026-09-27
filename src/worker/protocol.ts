/** The message shapes a session worker and an attached client exchange over
 * their socket. Framed as newline-delimited JSON: `encodeFrame` appends the
 * one separator the wire format depends on, `decodeFrames` consumes however
 * many complete frames a chunk contains and holds back a trailing partial
 * one for the next chunk -- a socket delivers bytes, not messages, and JSON
 * has no self-delimiting end marker of its own.
 */
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';

/** What a client may ask the worker to do. `submit`/`steer`/`cancel` mirror
 * the same three actions a terminal already offers a running turn; `attach`
 * is the very first message a connection sends, and the only one the worker
 * answers unconditionally -- everything else assumes a session is already
 * attached to. */
export type ClientCommand =
  /** The one command answered unconditionally: token proves this client was
   * told the socket path by something that already had the runtime record
   * (filesystem permissions restrict who can even try), not a security
   * boundary against a local attacker who could read the record file
   * directly anyway -- just belt-and-suspenders against a stale socket path
   * some other process's connection happened to land on. */
  | { type: 'attach'; token: string }
  | { type: 'submit'; text: string; echo: boolean; queuedTurnId?: string }
  /** A message typed while a turn runs. `id` is echoed back on the
   * `submission` event that says what actually happened to it. */
  | { type: 'steer'; text: string; id?: string }
  | { type: 'cancel'; restoreDraft: boolean }
  | { type: 'approval-response'; id: string; approved: boolean | 'always' }
  /** The vendor sign-in a `sign-in-request` asked for has finished, on the
   * client's own terminal; `error` when it failed. */
  | { type: 'sign-in-response'; id: string; error?: string }
  /** The client made a change the worker did not: an account swap from a
   * local-only login flow, a manual edit to state. Re-read rather than
   * synchronize field-by-field -- the source of truth is the state file
   * either way, this just says "yours might be stale now." */
  | { type: 'refresh' }
  /** Get ready for the conversation's route: on an agent route (the Gateway,
   * ClikCode Local) start its MCP servers and, for the Gateway, open the
   * connection and fetch its model list; on any other route stop them. */
  | { type: 'prepare' }
  /** Stop everything local this worker started for the conversation. */
  | { type: 'release' }
  | { type: 'detach' };

/** What the worker tells an attached client. `snapshot` is always the first
 * event after `attach` answers -- the full session to paint, and, when a
 * turn is already running, what has streamed of it so far -- so a client is
 * never in the position of reconstructing "what's already on screen" from
 * persisted history the way reseedTranscript used to; it is simply told. */
export type WorkerEvent =
  | { type: 'attach-rejected'; reason: string }
  /** `live.prompt` is what the running turn was started with, so a client
   * that did not start it can show it as the pending message. */
  | { type: 'snapshot'; session: HarnessSession; account?: string; live?: { text: string; waitingLabel: string; prompt?: string } }
  | { type: 'delta'; text: string; mode: 'append' | 'replace' }
  | { type: 'activity'; event: HarnessActivityEvent }
  | { type: 'phase'; message: string }
  | { type: 'plan'; entries: readonly PlanEntry[] }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'approval-request'; id: string; title: string; detail?: string; preview?: ApprovalPreview; rule?: string }
  /** A turn has started. `prompt` (additive) is its text: a client that did
   * not send it -- another window's turn, or one the worker started itself
   * for a finished background shell -- follows it from here to waiting-stop
   * and shows the prompt as the pending message. */
  | { type: 'waiting-start'; message: string; prompt?: string }
  | { type: 'waiting-stop' }
  | { type: 'suspend' }
  /** A turn needs the vendor signed in. The worker has no terminal to run a
   * sign-in on, so the client runs it on its own and answers with
   * `sign-in-response`; the worker then retries the turn. */
  | { type: 'sign-in-request'; id: string; command: string; argv: readonly string[]; environment: Record<string, string>; name: string }
  | { type: 'resume' }
  | { type: 'notice'; message: string }
  | { type: 'turn-error'; message: string }
  /** A cancelled turn that produced nothing worth keeping is discarded
   * outright (see session-worker.ts's runTurn) -- but the words the user
   * actually typed are still theirs, so the client's own composer gets them
   * back rather than losing them entirely. Sent only when the client's
   * `cancel` asked for it (restoreDraft: true) and there truly was nothing
   * to preserve as an interrupted turn instead. */
  | { type: 'restore-draft'; text: string }
  /** What happened to a message typed during a turn -- the worker's answer,
   * not the client's guess. The client used to assume "queued" for every one
   * and never learn otherwise, so a message steered straight into the answer
   * said "queued for next turn" for the rest of the turn. */
  | { type: 'submission'; id: string; disposition: 'steered' | 'queued' | 'error'; message?: string }
  /** The worker is exiting (idle timeout, explicit stop, an unrecoverable
   * error) -- told, not just disconnected, so a client can say why instead
   * of a bare "connection closed". */
  | { type: 'shutdown'; reason: string }
  /** The conversation's queued turns changed (a message queued behind a
   * running turn, a background-shell notification recorded). An idle client
   * re-reads them from state and runs the one at the head; it no longer only
   * notices at its next prompt. Additive: a client that ignores it runs the
   * queue at its next prompt as before. */
  | { type: 'queue-changed' }
  /** Answer to a `submit` that arrived while another turn was running, sent
   * to the submitting client only: nothing runs two turns at once, so the
   * message was queued (`queuedTurnId`) and runs after the current one. */
  | { type: 'submit-queued'; queuedTurnId: string };

const FRAME_SEPARATOR = '\n';

export function encodeFrame(message: ClientCommand | WorkerEvent): string {
  return `${JSON.stringify(message)}${FRAME_SEPARATOR}`;
}

/** Consumes every complete frame in `buffer`, returning the parsed messages
 * and whatever incomplete tail is left to prepend to the next chunk.
 * Unparseable frames are dropped rather than thrown -- one corrupt line must
 * not take the whole connection down when every frame around it is fine. */
export function decodeFrames(buffer: string): { messages: unknown[]; rest: string } {
  const parts = buffer.split(FRAME_SEPARATOR);
  const rest = parts.pop() ?? '';
  const messages: unknown[] = [];
  for (const part of parts) {
    if (!part) continue;
    try { messages.push(JSON.parse(part)); } catch { /* one corrupt frame does not sink the connection */ }
  }
  return { messages, rest };
}
