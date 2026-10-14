/** A turn's calls and thoughts, grouped while they happen.
 *
 * Calls and thoughts that run one after another, with no prose between them,
 * are one run. A run is held in the live region -- animated, newest calls under
 * its summary -- until prose follows it or the turn ends; only then does it
 * settle, ONCE, as a single summary row, and from that moment it is sealed.
 * Scrollback cannot be rewritten, so membership is remembered and never
 * recomputed once a run has been drawn. The same entries, in the same order,
 * give the same runs whether the turn is live or reopened.
 *
 * Failed and stopped calls, sub-agents and a call waiting on an approval are
 * part of the run but never folded into its summary row: each keeps a row of
 * its own, in place (harness/protocol/call-groups.ts standsAlone).
 *
 * The group's items are kept (GroupRegistry) so a tap or Ctrl+O can open them
 * without rewriting a row already drawn: the expansion is a panel in the live
 * region (group-panel.ts). */

import chalk from 'chalk';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { activityResult, tensedLabel } from '../../harness/protocol/turn-flow.js';
import { standsAlone, type GroupThought } from '../../harness/protocol/call-groups.js';
import { thoughtRow } from './tool-rows.js';
import { reasoningHeading } from '../../harness/protocol/turn-flow.js';
import type { ActivityEntry } from './activity-log.js';

/** Calls listed under a group while it is live. */
const LIVE_SHOWN_CALLS = 3;
/** Groups kept for expansion. */
const GROUPS_KEPT = 50;

export type GroupRow = { key: string; event: HarnessActivityEvent; thought?: GroupThought; responseOffset?: number };

export type CallRun<T extends GroupRow> = {
  /** The first item's key: the run's identity in the transcript. */
  key: string; items: T[];
  /** Final: nothing can join it or change it any more. */
  done: boolean;
};

export class CallGrouping {
  /** Sealed runs: run key -> the keys of its items, in order. */
  private readonly sealed = new Map<string, string[]>();
  private readonly owner = new Map<string, string>();

  reset(): void {
    this.sealed.clear();
    this.owner.clear();
  }

  /** `rows` in the order they happened; `ended` the turn is over; `prose`
   * how much of the answer has streamed, which is what says text followed a
   * call. */
  group<T extends GroupRow>(rows: readonly T[], ended: boolean, prose: number): Array<CallRun<T>> {
    const runs: Array<CallRun<T>> = [];
    const byKey = new Map<string, CallRun<T>>();
    let open: CallRun<T> | undefined;
    for (const row of rows) {
      const owned = this.owner.get(row.key);
      if (owned !== undefined) {
        let run = byKey.get(owned);
        if (!run) { run = { key: owned, items: [], done: true }; runs.push(run); byKey.set(owned, run); }
        run.items.push(row);
        continue;
      }
      const tail = open?.items[open.items.length - 1];
      if (open && tail && tail.responseOffset !== undefined && tail.responseOffset === row.responseOffset) { open.items.push(row); continue; }
      open = { key: row.key, items: [row], done: false };
      runs.push(open);
      byKey.set(open.key, open);
    }
    for (const [index, run] of runs.entries()) {
      if (this.sealed.has(run.key)) { run.done = true; continue; }
      const finished = run.items.every((item) => item.event.kind !== 'tool-start');
      const last = run.items[run.items.length - 1]!;
      const followed = index < runs.length - 1 || (last.responseOffset !== undefined && prose > last.responseOffset);
      run.done = ended || (finished && followed);
      if (run.done) {
        this.sealed.set(run.key, run.items.map((item) => item.key));
        for (const item of run.items) this.owner.set(item.key, run.key);
      }
    }
    return runs;
  }
}

/** One group's kept items, for expansion. */
export type GroupData = {
  id: string;
  items: Array<{ id: string; entry: ActivityEntry }>;
  /** Items still running (the live group). */
  running: boolean;
};

/** The groups of this view, newest last, bounded. */
export class GroupRegistry {
  private readonly groups = new Map<string, GroupData>();

  set(data: GroupData): void {
    this.groups.delete(data.id);
    this.groups.set(data.id, data);
    while (this.groups.size > GROUPS_KEPT) this.groups.delete(this.groups.keys().next().value!);
  }

  get(id: string): GroupData | undefined { return this.groups.get(id); }

  latest(): GroupData | undefined {
    let last: GroupData | undefined;
    for (const group of this.groups.values()) last = group;
    return last;
  }

  get size(): number { return this.groups.size; }

  clear(): void { this.groups.clear(); }
}

/** A thought kept as its row's data (the settled row and the expansion). */
export function thoughtEntryRow(thought: GroupThought): string {
  return thoughtRow(thought.durationMs, thought.heading ?? reasoningHeading(thought.text));
}

/** The call's line under a live group, in the tense of its state with what it
 * found; a stopped call says so, a failed one is red. */
export function liveItemLine(entry: ActivityEntry, ended: boolean): string {
  if (entry.thought) return chalk.dim(chalk.italic(`✻ ${plainThought(entry.thought)}`));
  const base = entry.event!;
  const event = ended && base.kind === 'tool-start' ? { ...base, kind: 'tool-done' as const } : base;
  const result = activityResult(event);
  if (event.stopped) return `${chalk.dim(event.label)} ${chalk.yellow('stopped')}`;
  const label = event.kind === 'tool-error' ? `${event.label} failed` : tensedLabel(event.label, event.kind === 'tool-start');
  return event.kind === 'tool-error' ? chalk.red(label) : chalk.dim(`${label}${result ? ` · ${result}` : ''}`);
}

const plainThought = (thought: GroupThought): string => thoughtEntryRow(thought).replace(/\u001b\[[0-9;]*m/g, '').replace(/^✻ /, '');

export { LIVE_SHOWN_CALLS, standsAlone };
