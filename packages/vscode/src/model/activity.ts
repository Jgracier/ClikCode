/** A live turn's rows -- tool calls, thoughts -- folded in by the terminal's rules. */
import { asFileDiffs } from '../../../../src/agent/line-diff';
import { activityLifecyclePhase, appendThought, childActivity, mergeActivity, sameCall, stoppedCall, withChildTool } from '../../../../src/harness/protocol/activity-view';
import type { BackgroundWork } from '../../../../src/harness/protocol/background-agents';
import { CHILDREN_SHOWN } from '../../../../src/tui/render/child-rows';
import type { FileDiff, HarnessActivityEvent } from '../protocol';
import { stripAnsi } from '../text';
import type { Activity, LiveChild, LiveTurn } from './types';

const MAX_ACTIVITIES = 200;

/** A stamp for `writingAt` / `callAt`: the clock, but strictly after `other`,
 * so two events in one millisecond keep the order they came in (answerWriting
 * compares them). */
export function stampAfter(other: number | undefined): number {
  return Math.max(Date.now(), (other ?? Number.NEGATIVE_INFINITY) + 1);
}

/** The thought the worker is having now, as this window continues it. What
 * the window holds wins when it is the same thought or a newer one; a thought
 * the window never saw begin takes the worker's place and start time, and what
 * the window held is settled where it was. A thought already settled (a row
 * of the turn) is never reopened. */
export function withWorkerThought(live: LiveTurn, open: { id?: string; text: string; seq: number; responseOffset: number; startedAt: number } | undefined): LiveTurn {
  if (!open || !open.text.trim() || live.reasoning.some((entry) => entry.seq === open.seq)) return live;
  const held = live.thoughtStart;
  if (live.thought && held && held.seq >= open.seq) {
    return held.seq === open.seq && open.text.length > live.thought.text.length
      ? { ...live, thought: { ...live.thought, text: stripAnsi(open.text) } } : live;
  }
  const before = live.thought ? settled(live) : live;
  return {
    ...before, thought: { ...(open.id === undefined ? {} : { id: open.id }), text: stripAnsi(open.text) },
    thoughtStart: { offset: open.responseOffset, at: open.startedAt, seq: open.seq }, seen: Math.max(before.seen, open.seq),
  };
}

/** A row's place in the turn's order (standard 1.2): the worker's `seq` where
 * it sent one, else the next number of this window's own counter. The counter
 * first rises past everything the worker numbered, so a row that has none is
 * never mixed in among the worker's own numbers. */
export function takeSeq(live: Pick<LiveTurn, 'seen'>, given?: number): { seq: number; seen: number } {
  if (typeof given === 'number' && Number.isFinite(given)) return { seq: given, seen: Math.max(live.seen, given) };
  return { seq: live.seen + 1, seen: live.seen + 1 };
}

/** A live turn without the phase a report set before the vendor answered. */
export function withoutPhase<T extends { phase?: string }>(live: T): T {
  if (live.phase === undefined) return live;
  const { phase: _phase, ...rest } = live;
  return rest as T;
}

/** A finished turn's calls: none is running any more. One still open when
 * the turn was stopped is stopped (stoppedCall, as the terminal and the
 * saved turn have it); one a finished turn never reported finishing settles
 * as done, as the terminal draws it. Kept open, it span and its clock
 * counted on every reopen. */
export function settledCalls(activities: Activity[], stopped: boolean): Activity[] {
  const open = (rows: readonly Activity[]): boolean => rows.some((activity) => activity.kind === 'tool-start' || open(activity.children ?? []));
  if (!open(activities)) return activities;
  return activities.map((activity) => {
    const children = activity.children ? { children: settledCalls(activity.children, stopped) } : {};
    if (activity.kind !== 'tool-start') return { ...activity, ...children };
    const { child: _child, ...rest } = activity;
    return { ...(stopped ? stoppedCall(rest) : { ...rest, kind: 'tool-done' as const }), ...children };
  });
}

/** A level of background work as the live turn holds it: every kind, and the
 * agents again as the number older readers take. */
export function liveBackground(work: BackgroundWork | undefined): { background?: BackgroundWork; pendingBackground?: number } {
  return work ? { background: work, ...(work.agents ? { pendingBackground: work.agents } : {}) } : {};
}

/** A saved turn's row without this window's clock (a saved call is not
 * running: no seconds to count, and nothing that differs between two reads of
 * the same turn). */
export function withoutClock(activity: Activity): Activity {
  const { startedAt: _startedAt, ...rest } = activity;
  return activity.children ? { ...rest, children: activity.children.map(withoutClock) } : rest;
}

export function cleanEvent(event: HarnessActivityEvent): HarnessActivityEvent {
  const { diff: rawDiff, ...rest } = event;
  const files = asFileDiffs(rawDiff);
  return {
    ...rest,
    label: stripAnsi(event.label).replace(/\s+/g, ' ').trim() || 'tool',
    ...(event.output ? { output: event.output.map(stripAnsi) } : {}),
    ...(files?.length ? { diff: cleanDiff(files) } : {}),
  };
}

export function cleanDiff(files: FileDiff[]): FileDiff[] {
  return files.map((file) => ({ ...file, lines: file.lines.map((line) => ({ ...line, text: stripAnsi(line.text) })) }));
}

export function asActivity(key: string, event: HarnessActivityEvent, extra: Partial<Activity>): Activity {
  const { parentId: _parent, ...fields } = event;
  return { ...fields, key, ...extra } as Activity;
}

/** Children kept under one sub-agent row. */
export const MAX_CHILDREN = 200;

/** A sub-agent's frame into the row of its parent (anywhere in the tree):
 * its words, and -- for a call -- a child row of its own, merged by id like
 * any call, in the order the children began (standard 5). The parent's count
 * is of unique child call ids (withChildTool), never of frames. Returns the
 * rows unchanged when nothing changed, undefined when the parent is not here. */
export function placeChild(rows: Activity[], event: HarnessActivityEvent, offset: number): Activity[] | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.key !== event.parentId) {
      const inner = row.children?.length ? placeChild(row.children, event, offset) : undefined;
      if (!inner) continue;
      if (inner === row.children) return rows;
      const next = [...rows];
      next[index] = { ...row, children: inner };
      return next;
    }
    const says = childActivity(row.child, event);
    let parent = withChildTool(row, event);
    let children = row.children;
    if (event.kind !== 'thinking') {
      const held = row.children ?? [];
      const at = held.findIndex((entry) => sameCall(entry, event));
      if (at >= 0) {
        const merged = mergeActivity(held[at]!, event);
        const prior = held[at]!;
        children = [...held];
        children[at] = asActivity(prior.key, merged, {
          ...(prior.startedAt ? { startedAt: prior.startedAt } : {}),
          ...(prior.offset !== undefined ? { offset: prior.offset } : {}),
          ...(prior.seq !== undefined ? { seq: prior.seq } : {}),
          ...(prior.children ? { children: prior.children } : {}),
        });
      } else {
        const key = event.id ?? `${row.key}>#${held.length + 1}`;
        children = [...held, asActivity(key, event, { startedAt: Date.now(), offset, ...(event.seq !== undefined ? { seq: event.seq } : {}) })].slice(-MAX_CHILDREN);
      }
      // Counted from the unique ids it holds while it runs; a finished
      // parent's number is what the harness reported, else what was counted.
      if (row.kind === 'tool-start') parent = { ...parent, childTools: Math.max(parent.childTools ?? 0, children.length) };
    }
    if (says === row.child && parent === row && children === row.children) return rows;
    const next = [...rows];
    next[index] = { ...parent, ...(children ? { children } : {}), ...(says ? { child: says } : { child: undefined }) };
    return next;
  }
  return undefined;
}

export function liveChildren(parent: Activity, shown = CHILDREN_SHOWN): LiveChild[] {
  if (parent.kind !== 'tool-start' || !parent.children?.length) return [];
  const running = parent.children.filter((entry) => entry.kind === 'tool-start').slice(-shown);
  return running.map((child, rank) => ({
    parent, child, beside: (child.offset ?? 0) <= (parent.offset ?? 0), newest: rank === running.length - 1,
  }));
}

/** A tool frame into the turn's rows, by the terminal's rules: a later frame
 * of the same call (by id, or the open row with its label) merges into it --
 * never reopening a finished call -- and a sub-agent's frames say what it is
 * doing inside its parent's row rather than adding rows of their own. */
export function upsertActivity(live: LiveTurn, raw: HarnessActivityEvent, offset = live.text.length): LiveTurn {
  if (raw.kind === 'thinking' && !raw.parentId) return live;
  const event = cleanEvent(raw);
  if (event.parentId) {
    const placed = placeChild(live.activities, event, offset);
    if (placed === live.activities) return live;
    if (placed) return { ...live, activities: placed };
    // Its parent was never seen (or is gone): its reasoning is nothing to
    // draw, its call is a row of its own rather than lost.
    if (event.kind === 'thinking') return live;
  }
  for (let index = live.activities.length - 1; index >= 0; index -= 1) {
    const prior = live.activities[index]!;
    if (!sameCall(prior, event)) continue;
    const merged = mergeActivity(prior, event);
    const activities = [...live.activities];
    activities[index] = asActivity(prior.key, merged, {
      ...(prior.startedAt ? { startedAt: prior.startedAt } : {}),
      ...(prior.offset !== undefined ? { offset: prior.offset } : {}),
      ...(prior.seq !== undefined ? { seq: prior.seq } : {}),
      ...(prior.children ? { children: prior.children } : {}),
      ...(prior.child && merged.kind === 'tool-start' ? { child: prior.child } : {}),
    });
    return { ...live, activities };
  }
  const { seq, seen } = takeSeq(live, event.seq);
  const row = asActivity(event.id ?? `#${seq}`, event, { startedAt: Date.now(), offset, seq });
  // A call began: answer text after it is a new response (answerWriting).
  const began = event.kind === 'tool-start' ? { callAt: stampAfter(live.writingAt) } : {};
  return { ...live, ...began, seen, activities: [...live.activities, row].slice(-MAX_ACTIVITIES) };
}

/** The terminal's rule: the thought being had accumulates (appendThought);
 * a tool starting, or a new reasoning item, settles it into the turn's
 * reasoning. */
export function withThought(live: LiveTurn, event: HarnessActivityEvent): LiveTurn {
  if (event.parentId) return live;
  if (event.kind === 'tool-start') return settled(live);
  if (event.kind !== 'thinking') return live;
  const next = appendThought(live.thought, stripAnsi(event.label), event.id);
  if (!next || next === live.thought) return live;
  const fresh = !live.thought || live.thought.id !== next.id;
  const before = fresh ? settled(live) : live;
  // A thought takes its place in the order when it begins, not when it is
  // settled -- the call it led to is settled after it.
  const taken = takeSeq(before, event.seq);
  return { ...before, thought: next, ...(fresh ? { seen: taken.seen, thoughtStart: { offset: live.text.length, at: Date.now(), seq: taken.seq } } : {}) };
}

/** The thought being had, settled in its place: a tool started, the answer
 * began, or a new reasoning item took over. */
export function settled(live: LiveTurn): LiveTurn {
  if (!live.thought) return live;
  const start = live.thoughtStart ?? { offset: live.text.length, at: Date.now(), seq: live.seen };
  return { ...live, thought: undefined, thoughtStart: undefined, reasoning: [...live.reasoning, { text: live.thought.text, offset: start.offset, ms: Date.now() - start.at, seq: start.seq }] };
}

/** The status line follows the work, as in the terminal: the newest open
 * call names the verb, the turn's own phase otherwise. */
export function withToolPhase(live: LiveTurn, event: HarnessActivityEvent): LiveTurn {
  if (event.parentId || event.kind === 'thinking') return live;
  const lifecycle = activityLifecyclePhase(new Map(live.openTools), event);
  const closed = live.openTools.length > 0 && !lifecycle.activeTools.size;
  return {
    ...live, openTools: [...lifecycle.activeTools], toolPhase: lifecycle.activeTools.size ? lifecycle.phase : undefined,
    ...(closed ? { thinkingSince: Date.now() } : {}),
  };
}

export function applyActivity(live: LiveTurn, event: HarnessActivityEvent, offset?: number): LiveTurn {
  return withToolPhase(withThought(upsertActivity(live, event, offset), event), event);
}

export function freshLive(waitingLabel: string, startedAt = Date.now()): LiveTurn {
  return { text: '', waitingLabel, activities: [], reasoning: [], seen: 0, openTools: [], steers: [], startedAt, thinkingSince: Date.now(), activeAt: Date.now() };
}

/** Text replaced wholesale keeps the rows placed in what it kept; one placed
 * past the point where the texts differ moves back to it. */
export function rebaseOffsets<T extends { offset?: number }>(items: T[], previous: string, replacement: string): T[] {
  let common = 0;
  while (common < previous.length && common < replacement.length && previous[common] === replacement[common]) common += 1;
  return items.some((item) => (item.offset ?? 0) > common) ? items.map((item) => ((item.offset ?? 0) > common ? { ...item, offset: common } : item)) : items;
}
