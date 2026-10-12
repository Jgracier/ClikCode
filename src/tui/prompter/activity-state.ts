/** What the turn has done so far, as state: the plan, the thought, the activity log and the marks and decisions that settle into the transcript. */
import { sanitizeTerminalText } from '../render/text.js';
import { readTurnActivities } from '../../turn/turn-activities.js';
import { thoughtMarkId } from '../../turn/turn-marks.js';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import type { HarnessSession, TurnMark } from '../../session/model.js';
import { ActivityEntry, entryLines, settleDecisionEntry, stopEntries, upsertActivityEvent } from '../render/activity-log.js';
import { activityLifecyclePhase, withChildTool, appendThought, sameCall } from '../../harness/protocol/activity-view.js';
import { decisionRow, reasoningHeading } from '../../harness/protocol/turn-flow.js';
import { PlanEntry } from '../render/plan-block.js';
import { thoughtRow } from '../render/tool-rows.js';
import { callDecision, turnMarkLines } from '../render/turn-mark-rows.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

export function activity(this: TerminalHarnessPrompter, message: string, markId?: string): void {
  if (markId) this.markDrawn(markId);
  const normalized = sanitizeTerminalText(message, { keepSgr: true, singleLine: true }).trim();
  const last = this.activityEntries[this.activityEntries.length - 1];
  if (!normalized || last?.lines[last.lines.length - 1] === normalized) return;
  this.activityEntries = [...this.activityEntries, {
    anchor: this.turn ? this.activityAnchor : this.restingAnchor(),
    ...(this.turn ? { responseOffset: this.liveResponse.length } : {}),
    // Every entry gets one, waiting or not: it is this row's identity for
    // "already retired", and two rows that happen to say the same thing are
    // still two rows.
    sequence: ++this.timelineSequence,
    lines: [normalized],
  }];
  this.schedulePaint();
}

/** Optional: the agent's current plan/todo list, shown as a compact block in
 * the live region. Pass an empty list to remove it. */
export function setPlan(this: TerminalHarnessPrompter, entries: readonly PlanEntry[]): void {
  this.planEntries = entries.map((entry) => ({ ...entry }));
  // Where in the answer it first appeared: the row it leaves at the turn's end sits there.
  if (!entries.length) this.planStart = undefined;
  else if (this.planStart === undefined && this.turn) this.planStart = this.liveResponse.length;
  this.schedulePaint();
}

/** The plan at the end of the turn, kept as a row where it first appeared (standard section 7):
 * the band says what is left, and goes with the turn; the row says what was planned and how far it
 * got -- the same rows a reopened chat draws from the saved plan mark (turn-mark-rows.ts). */
export function settlePlan(this: TerminalHarnessPrompter): void {
  const entries = this.planEntries;
  const start = this.planStart;
  this.planStart = undefined;
  if (!entries.length || start === undefined || !this.turn) return;
  const lines = turnMarkLines({
    kind: 'plan', id: 'plan', seq: 0, responseOffset: start,
    entries: entries.map((entry) => ({ content: entry.content, status: entry.status })),
  } as never);
  if (!lines.length) return;
  // The worker numbered this plan and keeps it for a window joining later: one row, not two.
  this.markDrawn('plan');
  this.activityEntries = [...this.activityEntries, {
    anchor: this.activityAnchor, responseOffset: Math.min(start, this.liveResponse.length), sequence: ++this.timelineSequence,
    event: { kind: 'thinking', label: 'plan', id: 'plan' }, lines,
  }];
  this.planEntries = [];
}

/** `live`: this is the running turn's activity number `index`, which
 * happened `responseOffset` characters into its answer -- a worker's
 * record of the turn, replayed whole whenever a window (re)joins it. One
 * already shown is skipped, so replaying is safe at any moment. */
export function activityEvent(this: TerminalHarnessPrompter, event: HarnessActivityEvent, live?: { index: number; responseOffset: number }): void {
  if (live) {
    if (live.index <= this.liveActivitiesShown) return;
    this.liveActivitiesShown = live.index;
  }
  // Anything the turn or one of its sub-agents does means it has not stalled.
  if (this.turn) this.turn.activeAt = Date.now();
  this.vendorAnswered();
  if (event.parentId) {
    // A sub-agent's own calls stay inside the agent row, which keeps its
    // spinner. They are not separate messages, and they do not move the
    // status line. The step under the row is what animates.
    // What it is doing (a call) or saying (its prose, its thinking) now:
    // a slot of its own, so one call finishing never clears another's.
    const offset = live?.responseOffset ?? this.liveResponse.length;
    const { counted } = this.liveChildren.apply(event, { offset, seq: ++this.timelineSequence });
    // And how much it has done, as Claude Code counts it: the agent row
    // ends "(12 tool uses, 1m 5s)". Once per call, not once per frame.
    if (counted) {
      this.activityEntries = this.activityEntries.map((entry) => {
        const parent = entry.event;
        if (!parent || parent.id !== event.parentId) return entry;
        const counted = withChildTool(parent, event);
        return { ...entry, event: counted, lines: entryLines(counted, entry.decision) };
      });
    }
    this.schedulePaint();
    return;
  }
  if (event.kind === 'thinking') {
    // Reasoning is one live row while it is had: the current item's text
    // as it accumulates (see appendThought). A bare "thinking" label says
    // nothing the spinner does not. A new item settles the one before.
    const next = appendThought(this.thought, sanitizeTerminalText(event.label, { singleLine: true }), event.id);
    if (next !== this.thought) {
      if (this.thought && this.thought.id !== next?.id) this.settleThought();
      if (!this.thought) {
        this.thoughtStart = {
          at: Date.now(), offset: this.liveResponse.length,
          ...(event.seq === undefined ? {} : { markId: thoughtMarkId(next?.id, event.seq) }),
        };
      }
      this.thought = next;
    }
    this.schedulePaint();
    return;
  }
  if (event.kind === 'tool-start') { this.settleThought(); if (this.turn) this.turn.callAt = ++this.statusOrder; }
  if (event.id && (event.kind === 'tool-done' || event.kind === 'tool-error')) this.liveChildren.parentEnded(event.id);
  const anchor = this.turn ? this.activityAnchor : this.restingAnchor();
  const responseOffset = this.turn ? live?.responseOffset ?? this.liveResponse.length : undefined;
  this.activityEntries = upsertActivityEvent(this.activityEntries, anchor, responseOffset, event, ++this.timelineSequence);
  // The status line names the open call. The transcript row under the
  // answer is that call's output, not a second clock.
  const lifecycle = activityLifecyclePhase(this.activeTools, event);
  this.activeTools = lifecycle.activeTools;
  this.schedulePaint();
}

/** The thought on screen is over -- the answer or a call began, a new one
 * took over, or the turn ended. It stays in the transcript where it was
 * had, as "Thought for 3s" (Claude Code's words, and VS Code's): taking
 * the row away broke the rule that nothing shown ever disappears. */
export function settleThought(this: TerminalHarnessPrompter): void {
  const thought = this.thought;
  const start = this.thoughtStart;
  this.thought = undefined;
  this.thoughtStart = undefined;
  if (!thought || !start || !this.turn) return;
  // The worker numbers this thought and keeps it for a window joining
  // later: the same row, so a snapshot that lists it draws nothing new.
  if (start.markId) this.markDrawn(start.markId);
  this.activityEntries = [...this.activityEntries, {
    anchor: this.activityAnchor, responseOffset: Math.min(start.offset, this.liveResponse.length), sequence: ++this.timelineSequence,
    event: { kind: 'thinking', label: thought.text },
    lines: [thoughtRow(Date.now() - start.at, reasoningHeading(thought.text))],
  }];
}

/** The worker's mark `id` is already on this screen, drawn by the window's
 * own live path (a notice, a decision it answered, a thought it watched
 * settle): a mid-turn snapshot that lists it again draws nothing. */
export function markDrawn(this: TerminalHarnessPrompter, id: string): void {
  this.drawnMarks.add(`${this.activityAnchor}:${id}`);
}

/** A settled mark of the running turn this window joined (a thought, a
 * notice, an approval's outcome), drawn where the worker placed it. By id,
 * so a snapshot repeated at any moment draws it once (the plan is the
 * band's: setPlan). Rows arrive in the worker's order and take this
 * window's counter in that order; a worker `seq` is never compared with
 * it (standards 1 and 11, joined-turn.ts). */
export function joinMark(this: TerminalHarnessPrompter, mark: TurnMark): void {
  if (!this.turn || mark.kind === 'plan') return;
  const lines = turnMarkLines(mark);
  const key = `${this.activityAnchor}:${mark.id}`;
  if (!lines.length || this.drawnMarks.has(key)) return;
  this.drawnMarks.add(key);
  // A decision that names its call settles that call's row: one event, one row.
  const on = callDecision(mark);
  if (on) {
    this.activityEntries = settleDecisionEntry(this.activityEntries, {
      anchor: this.activityAnchor, responseOffset: Math.min(mark.responseOffset, this.liveResponse.length), sequence: ++this.timelineSequence, ...on,
    });
    this.schedulePaint();
    return;
  }
  this.activityEntries = [...this.activityEntries, {
    anchor: this.activityAnchor, responseOffset: Math.min(mark.responseOffset, this.liveResponse.length), sequence: ++this.timelineSequence,
    event: { kind: 'thinking', label: mark.id, id: mark.id }, lines,
  }];
  this.schedulePaint();
}

/** The thought being had when this window joined: the live row carries on
 * from its newest words, and settles with the worker's own start time. */
export function joinThought(this: TerminalHarnessPrompter, thought: { id?: string; text: string; responseOffset: number; startedAt: number }): void {
  if (!this.turn || this.thought) return;
  this.thought = { ...(thought.id === undefined ? {} : { id: thought.id }), text: sanitizeTerminalText(thought.text, { singleLine: true }) };
  this.thoughtStart = { at: thought.startedAt, offset: Math.min(thought.responseOffset, this.liveResponse.length) };
  this.schedulePaint();
}

/** A decision's settled row. On the row of the call it was about when the
 * vendor named one (a refusal replaces the call's own failure line, an
 * approval is said on the call that runs): one event, one row. Else at the
 * answer's current place like any note, and never merged with an identical
 * earlier one: two denials of the same command are two decisions. */
export function settleDecision(this: TerminalHarnessPrompter, decision: Parameters<typeof decisionRow>[0], callId?: string): void {
  if (!this.turn) return;
  this.activityEntries = settleDecisionEntry(this.activityEntries, {
    anchor: this.activityAnchor, responseOffset: this.liveResponse.length, sequence: ++this.timelineSequence,
    ...(callId === undefined ? {} : { callId }), decision,
  });
}

/** This turn's own calls: the anchor is reused when a turn left no
 * message, so the sequence decides. */
export function ofThisTurn(this: TerminalHarnessPrompter, entry: ActivityEntry): boolean {
  return entry.anchor >= this.activityAnchor && (entry.sequence ?? 0) > this.emitted.turnSequenceFloor;
}

/** The saved turn is the durable copy: a call it records as stopped is
 * stopped here too, whichever window stopped the turn. */
export function settleSavedStops(this: TerminalHarnessPrompter, session: HarnessSession): void {
  const stopped = (session.messages ?? []).slice(this.activityAnchor).flatMap((message) => (message.role === 'assistant'
    ? readTurnActivities(message.activities, message.content.length).flatMap((activity) => (activity.event.stopped && !activity.event.parentId ? [activity.event] : []))
    : []));
  if (!stopped.length) return;
  this.activityEntries = stopEntries(this.activityEntries, (entry) => this.ofThisTurn(entry) && stopped.some((event) => sameCall(entry.event!, event)));
}
