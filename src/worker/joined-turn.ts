/** What a window that joins a running turn draws (standard 11): the turn as
 * far as it has got, in the order an attached window drew it.
 *
 * The worker's snapshot carries the text, the calls, the plan, the settled
 * marks (thoughts, notices, approval outcomes), the thought being had, the
 * phase and the usage so far (protocol.ts LiveTurn). Calls and marks each
 * keep the worker's `seq`, so they are merged by (responseOffset, seq) --
 * orderMarks' rule, shared with a reopened chat (turn-mark-rows.ts).
 * Drawing is idempotent: a join, a return from the board and a mid-turn
 * snapshot all come to the same screen whatever order they came in. */

import { isTranscriptActivity, type LiveActivity, type LiveThought, type WorkerEvent } from './protocol.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnMark } from '../session/model.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { backgroundWorkOf, type BackgroundWork } from '../harness/protocol/background-agents.js';
import type { HarnessSession } from '../session/model.js';
import { joinedAnswerText } from '../turn/live-answer.js';
import { upsertMark } from '../turn/turn-marks.js';
import { isApprovalWaitPhase } from '../harness/protocol/turn-flow.js';
import { savedTurnRanks } from '../tui/render/turn-mark-rows.js';

export interface JoinedTurn {
  liveText: string;
  activities: readonly LiveActivity[];
  plan: readonly PlanEntry[];
  marks: readonly TurnMark[];
  /** Ids of marks that did not come from the worker's numbering (a decision
   * learned from another window answering). Any of them present, no mark's
   * seq is compared with a call's: the turn reads in arrival order. */
  unsequenced?: readonly string[];
  thought?: LiveThought;
  phase?: string;
  usage?: TurnUsage;
  /** What the vendor says runs in the background, by kind (a level). */
  background?: BackgroundWork;
}

/** What a window knows of the turn the worker is running: the turn as far as it has got (JoinedTurn), kept up to date from the
 * worker's events. The local follower (turn-bridge.ts) and a chat on another machine (remote/terminal-chat.ts) both keep one, so
 * a window that joins or comes back draws the whole turn -- the remote one used to draw only its text-less shell. */
export interface LiveTurnState {
  running: boolean;
  prompt?: string;
  liveText: string;
  activities: LiveActivity[];
  plan: readonly PlanEntry[];
  marks: TurnMark[];
  unsequenced: string[];
  thought?: LiveThought;
  phase?: string;
  usage?: TurnUsage;
  background?: BackgroundWork;
  /** The followed turn is the vendor's own background work (waiting-start `vendorWork`). */
  vendorWork?: boolean;
}

export function newLiveTurnState(): LiveTurnState {
  return { running: false, liveText: '', activities: [], plan: [], marks: [], unsequenced: [] };
}

type Snapshot = Extract<WorkerEvent, { type: 'snapshot' }>;

/** The snapshot's turn is the whole truth about these: what it lacks, the turn has not got. */
function joinLive(state: LiveTurnState, live: NonNullable<Snapshot['live']>, session: HarnessSession): void {
  // The journal is written on a debounce and can lag the live text: the longer copy stands, the same whichever arrived first (live-answer.ts).
  const journal = session.pendingTurn;
  const sameTurn = journal && (live.prompt === undefined || journal.prompt.trim() === live.prompt.trim());
  Object.assign(state, {
    running: true, prompt: live.prompt ?? state.prompt,
    liveText: joinedAnswerText(sameTurn ? journal.response : undefined, live.text),
    ...(live.activities ? { activities: [...live.activities] } : {}), ...(live.plan ? { plan: live.plan } : {}),
    marks: live.marks ? [...live.marks] : [], unsequenced: [], thought: live.thought, phase: live.phase, usage: live.usage,
    background: backgroundWorkOf(live), vendorWork: live.vendorWork === true,
  });
}

/** One worker event into the state. Called before anything draws the event, so a drawer sees the state already up to date with it. */
export function applyLiveEvent(state: LiveTurnState, event: WorkerEvent): void {
  switch (event.type) {
    case 'waiting-start':
      Object.assign(state, {
        running: true, prompt: event.prompt, liveText: '', activities: [], plan: [], marks: [], unsequenced: [],
        thought: undefined, phase: undefined, usage: undefined, vendorWork: event.vendorWork === true,
      });
      return;
    case 'waiting-stop':
      state.running = false;
      return;
    case 'snapshot':
      if (event.live) joinLive(state, event.live, event.session);
      // A snapshot without `live` says nothing is running: it holds the finished turn (the worker sends `live` for as long as a
      // turn's record is unfinished). Left running until waiting-stop, a prompt would follow the same turn again and draw it twice.
      else state.running = false;
      state.background = event.background ?? backgroundWorkOf(event.live);
      return;
    case 'delta':
      state.liveText = event.mode === 'replace' ? event.text : state.liveText + event.text;
      return;
    case 'activity':
      if (state.running && isTranscriptActivity(event.event)) state.activities.push({ event: event.event, responseOffset: state.liveText.length });
      return;
    case 'plan':
      if (state.running) state.plan = event.entries;
      return;
    case 'note':
      // A notice of the turn, where the worker placed it.
      if (state.running && event.seq !== undefined) {
        state.marks = upsertMark(state.marks, { kind: 'notice', id: `notice:${event.seq}`, seq: event.seq, responseOffset: event.responseOffset ?? state.liveText.length, message: event.message });
      }
      return;
    case 'phase':
      if (state.running) state.phase = event.message;
      return;
    case 'usage':
      if (state.running) state.usage = event.usage;
      return;
    case 'background':
      if (state.running) state.background = backgroundWorkOf({ background: event.work, pendingBackground: event.pending });
      return;
    default:
  }
}

/** The part of the terminal prompter a joined turn is drawn through. */
export interface JoinedTurnSurface {
  response(text: string, mode: 'replace'): void;
  activityEvent(event: HarnessActivityEvent, live?: { index: number; responseOffset: number }): void;
  joinMark(mark: TurnMark): void;
  joinThought(thought: LiveThought): void;
  setPlan(entries: readonly PlanEntry[]): void;
  phase(message: string): void;
  setTurnUsage(usage: TurnUsage): void;
  /** Optional: a surface with no footer indicator has nothing to draw. */
  setBackgroundWork?(work: BackgroundWork | undefined): void;
}

export function drawJoinedTurn(rl: JoinedTurnSurface, turn: JoinedTurn): void {
  if (turn.liveText) rl.response(turn.liveText, 'replace');
  // The plan is the band's (updated in place); its settled row is the saved
  // turn's. Everything else is a row at its place.
  const marks = turn.marks.filter((mark) => mark.kind !== 'plan');
  const ranks = savedTurnRanks(turn.activities, marks, { marksHaveSeq: !turn.unsequenced?.length });
  const order = marks.map((mark, index) => ({ mark, rank: ranks.marks[index]! })).sort((a, b) => a.rank - b.rank);
  // Calls keep their own order (the caller's index is monotonic); each mark
  // goes before the first call it precedes.
  let next = 0;
  turn.activities.forEach((item, index) => {
    while (next < order.length && order[next]!.rank < ranks.activities[index]!) rl.joinMark(order[next++]!.mark);
    rl.activityEvent(item.event, { index, responseOffset: item.responseOffset });
  });
  while (next < order.length) rl.joinMark(order[next++]!.mark);
  if (turn.thought) rl.joinThought(turn.thought);
  if (turn.plan.length) rl.setPlan(turn.plan);
  if (turn.phase && !isApprovalWaitPhase(turn.phase)) rl.phase(turn.phase);
  if (turn.usage) rl.setTurnUsage(turn.usage);
  if (turn.background) rl.setBackgroundWork?.(turn.background);
}
