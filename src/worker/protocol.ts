/** The message shapes a session worker and an attached client exchange over
 * their socket. Framed as newline-delimited JSON: `encodeFrame` appends the
 * one separator the wire format depends on, a `FrameDecoder` hands back
 * however many complete frames a chunk completes and holds back a trailing
 * partial one for the next chunk -- a socket delivers bytes, not messages,
 * and JSON has no self-delimiting end marker of its own.
 */
import { StringDecoder } from 'node:string_decoder';
import { LineBuffer } from '../harness/protocol/json-lines.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
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
  | { type: 'detach' }
  /** Take a queued message back before its turn (an editor's remove, or its
   * edit, which puts the text back in the composer). One whose turn has
   * already begun is that turn now, and stays. */
  | { type: 'unqueue'; id: string }
  /** Sent by a client on a different build. The worker exits if it is idle
   * and otherwise answers `retire-declined` and exits once it is. */
  | { type: 'retire' };

/** One tool row of the running turn, and how much of its answer had streamed
 * when it happened -- where it sits between the answer's paragraphs. */
export type LiveActivity = { event: HarnessActivityEvent; responseOffset: number };

/** A thought is never a transcript row (the prompter shows only the latest
 * one, live), so a running turn keeps every activity but those. Both ends
 * count a turn's activities by this one rule. */
export function isTranscriptActivity(event: HarnessActivityEvent): boolean {
  return event.kind !== 'thinking';
}

/** The turn in flight, as far as it has got: what a window joining it needs
 * to draw it whole. `prompt` is what it was started with, so a client that
 * did not start it can show it as the pending message. `activities` and
 * `plan` are additive: a worker older than them sends text only. */
export type LiveTurn = {
  text: string; waitingLabel: string; prompt?: string;
  activities?: LiveActivity[]; plan?: PlanEntry[];
};

/** What the worker tells an attached client. `snapshot` is always the first
 * event after `attach` answers -- the full session to paint, and, when a
 * turn is already running, what has streamed of it so far -- so a client is
 * never in the position of reconstructing "what's already on screen" from
 * persisted history the way reseedTranscript used to; it is simply told. */
export type WorkerEvent =
  | { type: 'attach-rejected'; reason: string }
  | { type: 'retire-declined'; reason: string }
  /** `live` is present exactly while a turn runs: a snapshot without it says
   * nothing is running, including the one that closes a turn. */
  | { type: 'snapshot'; session: HarnessSession; account?: string; live?: LiveTurn }
  | { type: 'delta'; text: string; mode: 'append' | 'replace' }
  | { type: 'activity'; event: HarnessActivityEvent }
  /** A line of the turn's own transcript that is not a tool call: an account
   * switch, a model substitution, an answer cut off at its limit. It was
   * sent as a thought, which a window shows only until the next one. */
  | { type: 'note'; message: string }
  | { type: 'phase'; message: string }
  | { type: 'plan'; entries: readonly PlanEntry[] }
  | { type: 'usage'; usage: TurnUsage }
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

/** One connection's incoming frames. Bytes are decoded as a stream, so a
 * character split across two chunks arrives whole, and only each new chunk
 * is searched for frame ends (json-lines.ts LineBuffer) -- a snapshot of a
 * long conversation arrives in many chunks, and re-splitting everything held
 * on each one cost the square of its size. Unparseable frames are dropped
 * rather than thrown -- one corrupt line must not take the whole connection
 * down when every frame around it is fine. */
export class FrameDecoder {
  private readonly text = new StringDecoder('utf8');
  private readonly lines = new LineBuffer();

  /** The messages this chunk completed, in order. */
  push(chunk: Buffer | string): unknown[] {
    const messages: unknown[] = [];
    for (const frame of this.lines.push(typeof chunk === 'string' ? chunk : this.text.write(chunk))) {
      if (!frame) continue;
      try { messages.push(JSON.parse(frame)); } catch { /* one corrupt frame does not sink the connection */ }
    }
    return messages;
  }
}
