/** A turn's looking-around calls, merged into one row while they happen.
 *
 * Reads and searches in a row are one row (turn-flow.ts's explores and
 * exploreSummary): "Read 3 files, searched 2 patterns", and under it the
 * last few calls, dimmed, the way Cursor shows them. collapseToolRuns does
 * this for rows outside a turn; this is the turn's own, live.
 *
 * Scrollback cannot be rewritten, so a merged row may only grow while it is
 * the live tail. It is held in the live region until something follows it --
 * another kind of call, or the answer's prose -- or the turn ends, and only
 * then settles; from that moment it is sealed, and a later read starts a row
 * of its own. Membership is remembered, never recomputed: a row's place in a
 * group cannot change once the group has been drawn. */

import chalk from 'chalk';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { activityResult, explores, exploreSummary, tensedLabel } from '../../harness/protocol/turn-flow.js';
import { TOOL_CATEGORY_STYLE } from '../../harness/protocol/tool-category-style.js';

/** Calls listed under a merged row. */
export const EXPLORE_SHOWN_CALLS = 3;

export type GroupRow = { key: string; event: HarnessActivityEvent; responseOffset?: number };

export type TurnGroup<T extends GroupRow> = {
  /** The first member's key: the group's identity in the transcript. */
  key: string; members: T[];
  /** Two or more looking-around calls, drawn as one merged row. */
  merged: boolean;
  /** Final: nothing can join it or change it any more. */
  done: boolean;
};

/** Reads and searches; a failed one still belongs to the group it was in. */
const looking = (event: HarnessActivityEvent): boolean => !event.agent && (event.category === 'read' || event.category === 'search');

export class ExploreGrouping {
  private readonly groupOf = new Map<string, string>();
  private readonly sealed = new Set<string>();

  reset(): void {
    this.groupOf.clear();
    this.sealed.clear();
  }

  /** `rows` in the order they happened; `ended` the turn is over; `prose`
   * how much of the answer has streamed, which is what says text followed a
   * call. */
  group<T extends GroupRow>(rows: readonly T[], ended: boolean, prose: number): Array<TurnGroup<T>> {
    const groups: Array<TurnGroup<T>> = [];
    const byKey = new Map<string, TurnGroup<T>>();
    for (const row of rows) {
      const assigned = this.groupOf.get(row.key);
      const known = assigned === undefined ? undefined : byKey.get(assigned);
      if (known) { known.members.push(row); continue; }
      const last = groups[groups.length - 1];
      const tail = last?.members[last.members.length - 1];
      // Joins the row before it only when both only look around, no prose
      // came between them (the same offset into the answer), and that row's
      // group is still the open tail.
      if (assigned === undefined && last && tail && explores(row.event) && last.members.every((member) => looking(member.event))
        && !this.sealed.has(last.key) && tail.responseOffset !== undefined && tail.responseOffset === row.responseOffset) {
        last.members.push(row);
        this.groupOf.set(row.key, last.key);
        continue;
      }
      const key = assigned ?? row.key;
      const group: TurnGroup<T> = { key, members: [row], merged: false, done: false };
      groups.push(group);
      byKey.set(key, group);
      this.groupOf.set(row.key, key);
    }
    for (const [index, group] of groups.entries()) {
      group.merged = group.members.length > 1;
      const finished = group.members.every((member) => member.event.kind !== 'tool-start');
      const last = group.members[group.members.length - 1]!;
      const followed = index < groups.length - 1 || (last.responseOffset !== undefined && prose > last.responseOffset);
      // A lone call that is not looking around settles when it finishes, as
      // every row always has; one that is could still become a merged row.
      const open = group.members.every((member) => looking(member.event)) && !this.sealed.has(group.key) && !followed;
      group.done = ended || this.sealed.has(group.key) || (finished && !open);
      if (group.done) this.sealed.add(group.key);
    }
    return groups;
  }
}

/** A merged row: the summary, then the last calls dimmed (unindented; the
 * caller places them under it), each in the tense of its state with what it
 * found. `ended` words calls that never reported
 * finishing as finished, since the turn is. */
export function mergedExploreLines(events: readonly HarnessActivityEvent[], ended: boolean): { summary: string; calls: string[]; running: boolean } {
  const settled = events.map((event) => (ended && event.kind === 'tool-start' ? { ...event, kind: 'tool-done' as const } : event));
  const running = settled.some((event) => event.kind === 'tool-start');
  const calls = settled.slice(-EXPLORE_SHOWN_CALLS).map((event) => {
    const result = activityResult(event);
    // Stopped with its turn is not a failure (HarnessActivityEvent.stopped).
    if (event.stopped) return `${chalk.dim(event.label)} ${chalk.yellow('stopped')}`;
    const label = event.kind === 'tool-error' ? `${event.label} failed` : tensedLabel(event.label, event.kind === 'tool-start');
    return event.kind === 'tool-error' ? chalk.red(label) : chalk.dim(`${label}${result ? ` · ${result}` : ''}`);
  });
  return { summary: exploreSummary(settled), calls, running };
}

/** The settled merged row's first line, in the style of the work it was. */
export function mergedExploreSummaryLine(events: readonly HarnessActivityEvent[], summary: string): { line: string; category: 'read' | 'search' } {
  const category = events.some((event) => event.category === 'read') ? 'read' : 'search';
  const style = TOOL_CATEGORY_STYLE[category];
  return { line: `${style.paint(style.glyph)} ${chalk.dim(summary)}`, category };
}
