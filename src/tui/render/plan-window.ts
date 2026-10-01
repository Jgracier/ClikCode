/** Which plan steps are on screen. A long plan is windowed around the step in
 * progress so it never crowds the conversation out of view; the terminal
 * (plan-block.ts) and the VS Code webview both show this window. */

import type { HarnessPlanEntry } from '../../harness/events/turn-observer.js';

export const PLAN_MAX_ROWS = 6;

export function planStepSettled(entry: Pick<HarnessPlanEntry, 'status'>): boolean {
  return entry.status === 'completed' || entry.status === 'cancelled';
}

/** Whether a plan still has a place on screen: while any step is open. Once
 * every step is done (or dropped) it has said all it had to, and goes -- as
 * Claude Code's todo list and Codex's plan do. A plan left unfinished when a
 * turn ends stays, until the next turn starts. */
export function planStillNeeded(entries: ReadonlyArray<Pick<HarnessPlanEntry, 'status'>>): boolean {
  return entries.some((entry) => !planStepSettled(entry));
}

/** The visible steps with their positions, how many are settled, and how
 * many the window left out. `capacity` counts the "more" row. */
export function planWindow<T extends Pick<HarnessPlanEntry, 'status'>>(entries: readonly T[], maxRows = PLAN_MAX_ROWS): {
  visible: Array<{ entry: T; index: number }>; done: number; hidden: number;
} {
  const done = entries.filter(planStepSettled).length;
  const capacity = Math.max(1, Math.min(maxRows, PLAN_MAX_ROWS));
  let visible = entries.map((entry, index) => ({ entry, index }));
  if (visible.length > capacity) {
    const active = Math.max(0, entries.findIndex((entry) => !planStepSettled(entry)));
    const start = Math.max(0, Math.min(active - 1, entries.length - (capacity - 1)));
    visible = visible.slice(start, start + capacity - 1);
  }
  return { visible, done, hidden: entries.length - visible.length };
}
