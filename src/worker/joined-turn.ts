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

import type { LiveActivity, LiveThought } from './protocol.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnMark } from '../session/model.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { BackgroundWork } from '../harness/protocol/background-agents.js';
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
