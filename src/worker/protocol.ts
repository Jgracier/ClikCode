/** The message shapes a session worker and an attached client exchange over
 * their socket. Framed as newline-delimited JSON: `encodeFrame` appends the
 * one separator the wire format depends on, a `FrameDecoder` hands back
 * however many complete frames a chunk completes and holds back a trailing
 * partial one for the next chunk -- a socket delivers bytes, not messages,
 * and JSON has no self-delimiting end marker of its own.
 */
import type { BackgroundWork } from '../harness/protocol/background-agents.js';
import type { HarnessQuestionRequest, HarnessQuestionResult } from '../harness/events/question.js';
import { StringDecoder } from 'node:string_decoder';
import { LineBuffer } from '../harness/protocol/json-lines.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessSession, TurnActivity, TurnMark } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { TakeBackOutcome } from '../turn/live-input.js';
import type { LiveSettingsFields } from '../turn/live-settings.js';

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
  /** `turnId` and `submittedAt` (the window's wall clock at Enter) carry the
   * turn's latency marks across the two processes (runtime/turn-latency.ts);
   * a client without them gets a turn the worker times from its own start. */
  | { type: 'submit'; text: string; echo: boolean; queuedTurnId?: string; turnId?: string; submittedAt?: number }
  /** A message typed while a turn runs. `id` is echoed back on the
   * `submission` event that says what actually happened to it. */
  | { type: 'steer'; text: string; id?: string }
  /** A message typed into a sub-agent's own view. `parentId` is the sub-agent
   * row's call id; `label` and `agentId` are the row's (the client has it).
   * What happens depends on the harness's declared `subagents.steer`
   * (docs/SUBAGENTS.md): a `relay` is a visible steer to the main agent; where
   * the harness gives no way the `submission` answer says exactly why. */
  | { type: 'steer-subagent'; parentId: string; text: string; label?: string; agentId?: string; id?: string }
  | { type: 'cancel'; restoreDraft: boolean }
  /** Enter again: the oldest queued user message goes into the running
   *  turn at its next pause. The turn is not cancelled. */
  | { type: 'send-queued' }
  | { type: 'approval-response'; id: string; approved: boolean | 'always' }
  /** The answer to a `question-request` (cancelled when the user dismissed it). */
  | { type: 'question-response'; id: string; result: HarnessQuestionResult }
  /** The vendor sign-in a `sign-in-request` asked for has finished, on the
   * client's own terminal; `error` when it failed. */
  | { type: 'sign-in-response'; id: string; error?: string }
  /** The client changed what the conversation runs on (account, provider,
   * model, effort, route) outside a turn -- a slash command, a sign-in. The
   * worker re-reads state and sends every window a snapshot, so the others
   * stop showing the old one. Sent when `shownSettingsKey` changes. */
  | { type: 'refresh' }
  /** The user changed model, effort, speed, permission mode or route while a
   * turn may be running. The window has already persisted them; the worker
   * holds them for the running turn, which reads them there and not from the
   * state file. */
  | { type: 'settings-changed'; settings: LiveSettingsFields }
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
 * when it happened -- where it sits between the answer's paragraphs. The same
 * shape a saved turn keeps its calls in (session/model.ts TurnActivity). */
export type LiveActivity = TurnActivity;

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
  /** The live turn is the vendor's own background work (see waiting-start). */
  vendorWork?: true;
  activities?: LiveActivity[]; plan?: PlanEntry[];
  /** The rest of what an attached window has drawn (additive): the thought
   * being had, the turn's settled thoughts / plan / notices / approval
   * outcomes in their own order (TurnMark, placed like a call), the turn's
   * latest phase, and its usage so far. A thought is not an activity, so
   * `activities` never carries one -- a window that took only that lost its
   * reasoning at every mid-turn snapshot. */
  thought?: LiveThought; marks?: TurnMark[]; phase?: string; usage?: TurnUsage;
  /** Background agents the vendor says are still running (standard section
   * 10); `background` is the same by kind, with workflows and the terminals
   * that are a footer indicator. */
  pendingBackground?: number;
  background?: BackgroundWork;
  /** Where in the answer the turn's plan row began (its mark's
   * `responseOffset`), for a window that reads `plan` and not `marks`. */
  planOffset?: number;
};

/** The thought being had, as a joining window continues it. `text` is its
 * newest words; `startedAt` (epoch ms, the worker's clock) lets the window
 * settle it with the duration the attached ones show. */
export type LiveThought = { id?: string; text: string; heading?: string; seq: number; responseOffset: number; startedAt: number };

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
  /** `stopped`: the snapshot that closes a stopped turn (see waiting-stop). */
  | { type: 'snapshot'; session: HarnessSession; account?: string; live?: LiveTurn; stopped?: true }
  | { type: 'delta'; text: string; mode: 'append' | 'replace' }
  | { type: 'activity'; event: HarnessActivityEvent }
  /** A line of the turn's own transcript that is not a tool call: an account
   * switch, a model substitution, an answer cut off at its limit. It was
   * sent as a thought, which a window shows only until the next one. */
  | { type: 'note'; message: string; seq?: number; responseOffset?: number }
  | { type: 'phase'; message: string }
  /** `seq`/`responseOffset`: where the plan row began (it updates in place). */
  | { type: 'plan'; entries: readonly PlanEntry[]; seq?: number; responseOffset?: number }
  | { type: 'usage'; usage: TurnUsage }
  /** Background work the vendor says is still running, as a level (0 =
   * none): the turn ends on `Waiting for N background agents`. `pending` is
   * the agents (what older windows read); `work` is every kind. */
  | { type: 'background'; pending: number; work?: BackgroundWork }
  | { type: 'approval-request'; id: string; title: string; detail?: string; preview?: ApprovalPreview; rule?: string; callId?: string; seq?: number; responseOffset?: number }
  /** A harness asks the user a question (options, several questions, free
   * text); answered with `question-response`. */
  | { type: 'question-request'; id: string; request: HarnessQuestionRequest; seq?: number; responseOffset?: number }
  /** An approval or question is no longer wanted (the vendor withdrew it, or
   * the turn ended): every window closes its prompt. */
  /** `outcome`/`label`: the user decided it -- the settled row the request
   * becomes where it was asked (TurnMark `outcome`). Absent when it was
   * withdrawn or the turn ended under it. `callId`: the call the request was
   * about (as on `approval-request`), so a window that never saw the request
   * settles that call's row with the decision. */
  | { type: 'request-closed'; id: string; outcome?: 'approved' | 'denied' | 'answered'; label?: string; callId?: string }
  /** A turn has started. `prompt` (additive) is its text: a client that did
   * not send it -- another window's turn, or one the worker started itself
   * for a finished background shell -- follows it from here to waiting-stop
   * and shows the prompt as the pending message. */
  | { type: 'waiting-start'; message: string; prompt?: string;
      /** The turn is the VENDOR's own background work, not one ClikCode started. A window leaves it on
       * Esc (the work is the vendor's and goes on); Ctrl+C is the explicit Stop. */
      vendorWork?: true }
  /** The turn is over. `stopped`: it was stopped (Esc or Ctrl+C in any
   * window), so every window ends it as stopped, not finished. */
  | { type: 'waiting-stop'; stopped?: true }
  /** A Stop was accepted (a turn is being aborted, or one about to start
   * will be): the one source of a client's "stopping". Ended by waiting-stop
   * or `stop-done`. */
  /** The vendor said something with no turn open: the worker has appended it to
   * the conversation (a snapshot follows with it in the transcript) and tells
   * every window, as it said it. */
  | { type: 'out-of-turn'; kind: 'message' | 'thought'; text: string; mode: 'append' | 'replace' }
  | { type: 'stopping'; restoreDraft?: true }
  /** A Stop that has nothing left to end: `nothing` when there was no turn
   * and no submit in flight to stop, else the vendor's background work it
   * stopped. Clients clear "stopping" on it. */
  | { type: 'stop-done'; nothing?: true }
  /** A `submit` the worker could not take on (it failed before a turn began).
   * The submitting client drops the prompt it echoed. Always followed by
   * `waiting-stop`. */
  | { type: 'submit-rejected'; message: string }
  /** A turn needs the vendor signed in. The worker has no terminal to run a
   * sign-in on, so the client runs it on its own and answers with
   * `sign-in-response`; the worker then retries the turn. */
  | { type: 'sign-in-request'; id: string; command: string; argv: readonly string[]; environment: Record<string, string>; name: string }
  /** `said`: the turn's own note already carries the failure's line. */
  | { type: 'turn-error'; message: string; said?: true }
  /** A cancelled turn that produced nothing worth keeping is discarded
   * outright (see worker-turn.ts's runTurn) -- but the words the user
   * actually typed are still theirs, so the client's own composer gets them
   * back rather than losing them entirely. Sent only when the client's
   * `cancel` asked for it (restoreDraft: true) and there truly was nothing
   * to preserve as an interrupted turn instead. */
  | { type: 'restore-draft'; text: string }
  /** What happened to a message typed during a turn -- the worker's answer,
   * not the client's guess. The client used to assume "queued" for every one
   * and never learn otherwise, so a message steered straight into the answer
   * said "queued for next turn" for the rest of the turn. */
  /** `unsteered`: queued though steering was asked for -- nothing running
   *  could take a steer (LiveTurnInputResult.unsteered). */
  | { type: 'submission'; id: string; disposition: 'steered' | 'queued' | 'error'; message?: string; unsteered?: boolean;
    /** Where a steered message was placed (its acknowledgement's order). */
    seq?: number; responseOffset?: number }
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
  | { type: 'submit-queued'; queuedTurnId: string }
  /** Answer to `unqueue`, sent to the asking client only. `removed`: it left
   * the queue; `running`: it is the turn running now; `gone`: it was no
   * longer queued (already run or taken back); `error`: the state could not
   * be read or written, and it is still queued. */
  | { type: 'unqueued'; id: string; outcome: TakeBackOutcome; message?: string };

/** What a window shows of a conversation's settings. A client that sees it
 * change between two reads of state sends `refresh`. */
export function shownSettingsKey(session: Pick<HarnessSession, 'id' | 'route' | 'accountId' | 'provider' | 'model' | 'effort' | 'nativeHarness'>): string {
  return [session.id, session.route, session.accountId, session.provider, session.model, session.effort, session.nativeHarness].join('|');
}

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
