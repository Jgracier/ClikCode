/** The rows of a turn that are not tool calls, and the one order every row of
 * a turn is placed in.
 *
 * Standard 1: each row has a `seq`, assigned ONCE by the worker when it first
 * sees the row (MarkSequencer). Standards 4, 7, 8, 11: a settled thought, the
 * plan, a notice and an approval's outcome are kept with the turn as marks
 * (session/model.ts TurnMark), placed by (responseOffset, seq) like a call.
 *
 * Pure: the worker's observer (live) and the journal (durable) both use these
 * and so cannot disagree about what a mark is. */

import type { HarnessActivityEvent } from '../harness/prompter.js';
import { appendThought, type Thought } from '../harness/protocol/activity-view.js';
import { FAILURE_TEXT_LIMIT } from '../harness/protocol/stderr-line.js';
import { reasoningHeading } from '../harness/protocol/turn-flow.js';
import type { OpenThought, TurnMark } from '../session/model.js';

/** Bounds on what a turn's saved marks keep. They are guards against a
 * runaway, not a display width: other machines and clients read the saved
 * record, and the screen wraps and collapses what it shows. */
/** Characters of one thought's text kept (a reasoning item is a few KB at most). */
export const THOUGHT_MARK_CHARS = 20_000;
/** A heading and a label are one line each by nature: kept because they name a row. */
const HEADING_CHARS = 120;
const LABEL_CHARS = 200;
/** A notice is saved whole: a failure's cause is in it (failureText bounds a flood to this). */
const NOTICE_CHARS = FAILURE_TEXT_LIMIT + 8;
const PLAN_ENTRIES = 200;
const PLAN_ENTRY_CHARS = 2_000;
/** Marks a turn keeps. A thought per reasoning item and a notice per event
 * are small; this only stops a runaway turn from growing the file. */
export const MAX_TURN_MARKS = 2_000;

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** Hands out a turn's sequence numbers, one counter for the whole turn.
 *
 * A row's number is given the first time any part of the worker sees it, and
 * every later frame of it gets the same one: a call by its id (an id-less one
 * by its label while open, the way frames merge), a reasoning item by its id
 * (or, with none, the run of thinking frames with no other row between). */
export class MarkSequencer {
  private counter = 0;
  private readonly byId = new Map<string, number>();
  private readonly openLabels = new Map<string, number>();
  private anonymousThought: number | undefined;

  /** The newest number given. */
  peek(): number { return this.counter; }

  /** Never hand out a number at or below `value` again. */
  raiseTo(value: number): void { if (value > this.counter) this.counter = value; }

  /** A number for a row that has no frames (a steer, a plan, a notice). */
  take(): number {
    this.anonymousThought = undefined;
    return ++this.counter;
  }

  private remember(key: string): number {
    let seq = this.byId.get(key);
    if (seq === undefined) { seq = ++this.counter; this.byId.set(key, seq); }
    return seq;
  }

  /** The number of the row this frame belongs to. */
  seqFor(event: Pick<HarnessActivityEvent, 'kind' | 'label' | 'id' | 'seq'>): number {
    if (event.seq !== undefined) { this.raiseTo(event.seq); return event.seq; }
    if (event.kind === 'thinking') {
      if (event.id) return this.remember(`thought:${event.id}`);
      this.anonymousThought ??= ++this.counter;
      return this.anonymousThought;
    }
    this.anonymousThought = undefined;
    if (event.id) return this.remember(`call:${event.id}`);
    if (event.kind === 'tool-start') {
      const open = this.openLabels.get(event.label);
      if (open !== undefined) return open;
      const seq = ++this.counter;
      this.openLabels.set(event.label, seq);
      return seq;
    }
    // A completion some vendors report under a generic label closes the
    // newest open call.
    const key = this.openLabels.has(event.label) ? event.label : event.label === 'tool' ? [...this.openLabels.keys()].pop() : undefined;
    if (key === undefined) return ++this.counter;
    const seq = this.openLabels.get(key)!;
    this.openLabels.delete(key);
    return seq;
  }

  /** `event` with its `seq` set (in place when it can be: the next one to
   * see the same object -- the screen, after the journal -- then has it). */
  stamp<T extends HarnessActivityEvent>(event: T): T {
    if (event.seq !== undefined) { this.raiseTo(event.seq); return event; }
    const seq = this.seqFor(event);
    if (Object.isFrozen(event)) return { ...event, seq };
    event.seq = seq;
    return event;
  }
}

/** A thought's mark id: by the vendor's item id, else by its sequence. */
export const thoughtMarkId = (id: string | undefined, seq: number): string => `thought:${id ?? `#${seq}`}`;

/** The thought, settled: `Thought for Ns`, with its heading. */
export function settledThought(open: OpenThought, now: number): TurnMark {
  const heading = open.heading ?? reasoningHeading(open.text);
  return {
    kind: 'thought', id: thoughtMarkId(open.id, open.seq), seq: open.seq, responseOffset: open.responseOffset,
    durationMs: Math.max(0, now - open.startedAtMs),
    ...(heading ? { heading: clip(heading, HEADING_CHARS) } : {}),
    ...(open.text.trim() ? { text: clip(open.text, THOUGHT_MARK_CHARS) } : {}),
  };
}

type ThoughtStep = {
  /** The thought being had after this frame. */
  thought: OpenThought | undefined;
  /** A mark to record: the one this frame settled, or a settled one it
   * completed (the same id, merged -- never a second row). */
  mark?: TurnMark;
  /** The frame changed nothing. */
  unchanged?: true;
};

/** One reasoning frame, into the thought being had.
 *
 * The accumulation rule is activity-view.ts appendThought, the one the
 * terminal and the extension use. A new reasoning item settles the one
 * before. A frame of an item that already settled (the vendor repeats the
 * completed text after the answer began) is merged into its row, never a new
 * one: a row does not move once placed (standard 1.4). */
export function stepThought(
  prior: OpenThought | undefined, settled: readonly TurnMark[],
  event: Pick<HarnessActivityEvent, 'label' | 'id'> & { seq: number }, at: { offset: number; now: number },
): ThoughtStep {
  if (event.id) {
    const done = settled.find((mark) => mark.id === thoughtMarkId(event.id, event.seq));
    if (done?.kind === 'thought') {
      const text = event.label.replace(/\s+/g, ' ').trim();
      if (!text || /^thinking$/i.test(text) || text.startsWith('…') || text.length <= (done.text?.length ?? 0)) return { thought: prior, unchanged: true };
      const heading = reasoningHeading(text) ?? done.heading;
      return { thought: prior, mark: { ...done, text: clip(text, THOUGHT_MARK_CHARS), ...(heading ? { heading: clip(heading, HEADING_CHARS) } : {}) } };
    }
  }
  const was: Thought | undefined = prior ? { ...(prior.id === undefined ? {} : { id: prior.id }), text: prior.text } : undefined;
  const next = appendThought(was, event.label, event.id);
  if (next === was) return { thought: prior, unchanged: true };
  const sameItem = prior !== undefined && prior.id === next!.id;
  const settledPrior = prior && !sameItem ? settledThought(prior, at.now) : undefined;
  const base: OpenThought = sameItem ? prior : { ...(next!.id === undefined ? {} : { id: next!.id }), text: '', seq: event.seq, responseOffset: at.offset, startedAtMs: at.now };
  const heading = reasoningHeading(next!.text) ?? base.heading;
  return {
    thought: { ...base, text: next!.text, ...(heading ? { heading } : {}) },
    ...(settledPrior ? { mark: settledPrior } : {}),
  };
}

/** `mark` as it is kept: every text bounded. */
function boundMark(mark: TurnMark): TurnMark {
  switch (mark.kind) {
    case 'thought':
      return { ...mark, ...(mark.heading ? { heading: clip(mark.heading, HEADING_CHARS) } : {}), ...(mark.text ? { text: clip(mark.text, THOUGHT_MARK_CHARS) } : {}) };
    case 'notice':
      return { ...mark, message: clip(stripAnsi(mark.message).trim(), NOTICE_CHARS) };
    case 'outcome':
      return { ...mark, label: clip(stripAnsi(mark.label).replace(/\s+/g, ' ').trim(), LABEL_CHARS) };
    case 'plan':
      return {
        ...mark,
        entries: mark.entries.slice(0, PLAN_ENTRIES).map((entry) => ({
          content: clip(entry.content, PLAN_ENTRY_CHARS),
          ...(entry.status ? { status: entry.status } : {}), ...(entry.priority ? { priority: entry.priority } : {}),
        })),
      };
  }
}

/** One more mark of the turn. A mark with an id already kept updates that row
 * in place and keeps where it began (the plan, a thought completed after it
 * settled). Past MAX_TURN_MARKS the oldest go -- never the plan. */
export function upsertMark(marks: readonly TurnMark[], incoming: TurnMark): TurnMark[] {
  const mark = boundMark(incoming);
  const index = marks.findIndex((existing) => existing.id === mark.id);
  const next = [...marks];
  if (index >= 0) next[index] = { ...mark, seq: marks[index]!.seq, responseOffset: marks[index]!.responseOffset } as TurnMark;
  else next.push(mark);
  while (next.length > MAX_TURN_MARKS) {
    const drop = next.findIndex((existing) => existing.kind !== 'plan');
    next.splice(drop < 0 ? 0 : drop, 1);
  }
  return next;
}

/** Marks as stored, whatever wrote them: well-formed ones kept, anything else
 * skipped -- never thrown on. A journal from before marks has none. */
export function readTurnMarks(value: unknown): TurnMark[] {
  if (!Array.isArray(value)) return [];
  const kept = value.filter((item): item is TurnMark => {
    const mark = item as Partial<TurnMark> | null;
    return typeof mark === 'object' && mark !== null && typeof mark.id === 'string'
      && typeof mark.seq === 'number' && Number.isFinite(mark.seq)
      && typeof mark.responseOffset === 'number' && Number.isFinite(mark.responseOffset) && mark.responseOffset >= 0
      && (mark.kind === 'thought' ? typeof mark.durationMs === 'number'
        : mark.kind === 'plan' ? Array.isArray(mark.entries)
          : mark.kind === 'notice' ? typeof mark.message === 'string'
            : mark.kind === 'outcome' && typeof mark.label === 'string' && typeof mark.outcome === 'string');
  });
  return kept.length === value.length ? value as TurnMark[] : kept;
}

/** What a worker's observer hands the turn's journal: every mark it makes,
 * and the thought being had. It also takes the journal's counter, so a row
 * is numbered the same on the screen and in the saved turn.
 * (DurableTurnCheckpoint is the one implementation.) */
export interface TurnMarkJournal {
  readonly sequencer: MarkSequencer;
  recordMark(mark: TurnMark): void;
  setThought(thought: OpenThought | undefined): void;
  /** Where the steer `id` was placed, once the turn took it. */
  steerOrder(id: string): { seq: number; responseOffset: number } | undefined;
  /** The turn's durable record is final: saved, its journal folded into the conversation. */
  readonly finished?: boolean;
}
