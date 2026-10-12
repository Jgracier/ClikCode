/** The worker's durable marks (thoughts, plan, notices, decisions) as rows, and the order a turn's rows are drawn in. */
import { orderMarks } from '../../../../src/harness/protocol/activity-view';
import type { Decision } from '../../../../src/harness/protocol/turn-flow';
import { readTurnMarks } from '../../../../src/turn/turn-marks';
import { noticeLevel, stripAnsi } from '../text';
import { liveChildren, settled } from './activity';
import type { Activity, ChatModel, DecisionEntry, LiveTurn, Note, PlanAt, ThoughtEntry, TurnMark, TurnTrace } from './types';

/** Characters of a turn's reasoning a trace keeps. */
const MAX_REASONING = 12_000;

/** A turn's durable marks (what a snapshot carries as `live.marks`, a saved
 * answer as `marks`) as the rows this window draws. Anything malformed is
 * skipped (readTurnMarks). */
export interface MarkRows {
  reasoning: ThoughtEntry[];
  plan?: { entries: ChatModel['plan']; at: PlanAt };
  notices: Array<{ id: string; text: string; offset: number; seq: number }>;
  decisions: DecisionEntry[];
}

export function marksToRows(value: unknown): MarkRows {
  const rows: MarkRows = { reasoning: [], notices: [], decisions: [] };
  for (const mark of readTurnMarks(value)) {
    switch (mark.kind) {
      case 'thought':
        rows.reasoning.push({
          text: mark.text ? stripAnsi(mark.text) : '', offset: mark.responseOffset, ms: mark.durationMs, seq: mark.seq,
          ...(mark.heading ? { heading: stripAnsi(mark.heading) } : {}),
        });
        break;
      case 'plan':
        rows.plan = {
          entries: mark.entries.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })),
          at: { offset: mark.responseOffset, seq: mark.seq },
        };
        break;
      case 'notice':
        rows.notices.push({ id: mark.id, text: stripAnsi(mark.message), offset: mark.responseOffset, seq: mark.seq });
        break;
      case 'outcome': {
        const label = stripAnsi(mark.label);
        rows.decisions.push({
          id: mark.id, offset: mark.responseOffset, seq: mark.seq, ...(mark.callId ? { callId: mark.callId } : {}),
          decision: mark.outcome === 'approved' ? { kind: 'approved', label } : mark.outcome === 'answered' ? { kind: 'answered', label } : { kind: 'denied', label },
        });
        break;
      }
    }
  }
  return rows;
}

/** The worker's settled thoughts into the window's own. A row both hold is
 * one (same seq): the worker's duration, heading and place are authoritative,
 * and the window keeps its own text when it is longer (the worker's is
 * capped). Rows only one of them has stay. */
export function mergeReasoning(held: ThoughtEntry[], incoming: ThoughtEntry[]): ThoughtEntry[] {
  if (!incoming.length) return held;
  const merged = [...held];
  for (const entry of incoming) {
    const at = merged.findIndex((item) => item.seq === entry.seq);
    if (at < 0) { merged.push(entry); continue; }
    const prior = merged[at]!;
    merged[at] = {
      ...prior, ...entry, text: prior.text.length > entry.text.length ? prior.text : entry.text,
      ...(entry.heading || prior.heading ? { heading: entry.heading ?? prior.heading! } : {}),
    };
  }
  return merged;
}

export function mergeDecisions(held: DecisionEntry[] | undefined, incoming: DecisionEntry[]): DecisionEntry[] | undefined {
  if (!incoming.length) return held;
  const merged = [...(held ?? [])];
  for (const entry of incoming) {
    const at = merged.findIndex((item) => item.id === entry.id);
    if (at < 0) merged.push(entry);
    else {
      // The worker's row is authoritative for place; this window's own
      // knowledge of how it was answered (told, always) is not taken back.
      const prior = merged[at]!;
      const keep = prior.decision.kind === 'told' || prior.decision.kind === 'declined'
        || (prior.decision.kind === 'approved' && prior.decision.always && entry.decision.kind === 'approved');
      merged[at] = { ...prior, ...entry, decision: keep ? prior.decision : entry.decision, ...(prior.callId ? { callId: prior.callId } : {}) };
    }
  }
  return merged;
}

/** A turn's reasoning for its trace: every thought, the newest kept when
 * there is more than a trace holds. */
export function turnReasoning(live: LiveTurn | undefined): ThoughtEntry[] | undefined {
  if (!live) return undefined;
  const all = settled(live).reasoning;
  const kept: ThoughtEntry[] = [];
  let room = MAX_REASONING;
  for (let index = all.length - 1; index >= 0 && room > 0; index -= 1) {
    const entry = all[index]!;
    const text = entry.text.length > room ? `…${entry.text.slice(-room)}` : entry.text;
    kept.unshift({ ...entry, text });
    room -= text.length;
  }
  return kept.length ? kept : undefined;
}

/** A turn's notices for drawing: the window's own notes of the turn plus the
 * worker's saved ones, a notice both have drawn once (same mark, same seq, or
 * the same words at the same place). */
export function turnNoticeNotes(notes: readonly Note[] | undefined, trace: Pick<TurnTrace, 'notices' | 'userIndex'>): Note[] {
  const held = [...(notes ?? [])];
  for (const notice of trace.notices ?? []) {
    if (held.some((note) => note.markId === notice.id || note.seq === notice.seq || (note.text === notice.text && note.offset === notice.offset))) continue;
    held.push({
      kind: 'notice', level: noticeLevel(notice.text), text: notice.text, after: trace.userIndex + 1, turn: trace.userIndex,
      offset: notice.offset, seq: notice.seq, markId: notice.id,
    });
  }
  return held;
}

/** A turn's calls, thoughts, plan, notices and steered messages in the order
 * they happened (standard section 1): by where in the answer they came, then
 * by `seq` -- the order they began in, a steer's being the moment it was
 * acknowledged. A steer with no seq (a saved turn's) goes after whatever was
 * already at its place. */
export function turnMarks(
  text: string, activities: readonly Activity[], thoughts: readonly ThoughtEntry[], steers: ReadonlyArray<{ text: string; offset: number; seq?: number }>,
  extra: { plan?: PlanAt; notes?: ReadonlyArray<{ offset: number; seq: number; note: Note }>; decisions?: readonly DecisionEntry[] } = {},
): TurnMark[] {
  const at = (offset: number): number => Math.min(offset, text.length);
  // A decision the vendor tied to a call settles that call's row; the others
  // are rows of their own at the place they were asked.
  const onCall = new Map<string, Decision>();
  const alone: DecisionEntry[] = [];
  for (const entry of extra.decisions ?? []) {
    if (entry.callId && activities.some((activity) => activity.key === entry.callId)) onCall.set(entry.callId, entry.decision);
    else alone.push(entry);
  }
  // One comparator for every surface (activity-view.ts orderMarks): the CLI
  // and the extension cannot disagree about where a row sits.
  return orderMarks([
    ...thoughts.map((thought) => ({ offset: at(thought.offset), seq: thought.seq, thought })),
    ...activities.map((activity, index) => ({
      offset: at(activity.offset ?? 0), seq: activity.seq ?? index, activity: onCall.has(activity.key) ? { ...activity, decision: onCall.get(activity.key)! } : activity,
    })),
    ...alone.map((entry) => ({ offset: at(entry.offset), seq: entry.seq, decision: entry })),
    // Live children that began after more answer was written: a row of their
    // own under that text, in the order they began, just after their parent.
    ...activities.flatMap((activity, index) => liveChildren(activity).flatMap((live, rank) => (live.beside ? [] : [{
      offset: at(live.child.offset ?? 0), seq: live.child.seq ?? (activity.seq ?? index) + (rank + 1) / 1000, child: live,
    }]))),
    ...steers.map((steer, steerIndex) => ({ offset: at(steer.offset), seq: steer.seq ?? Number.MAX_SAFE_INTEGER, steer: steer.text, steerIndex })),
    ...(extra.plan ? [{ offset: at(extra.plan.offset), seq: extra.plan.seq, plan: true as const }] : []),
    ...(extra.notes ?? []).map(({ offset, seq, note }) => ({ offset: at(offset), seq, note })),
  ], (mark) => ({ responseOffset: mark.offset, seq: mark.seq }));
}
