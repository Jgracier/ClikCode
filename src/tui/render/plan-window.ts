/** Which plan steps are on screen. A long plan is windowed around the step in
 * progress so it never crowds the conversation out of view; the terminal
 * (plan-block.ts) and the VS Code webview both show this window. */

import type { HarnessPlanEntry } from '../../harness/events/turn-observer.js';

export const PLAN_MAX_ROWS = 6;

export function planStepSettled(entry: Pick<HarnessPlanEntry, 'status'>): boolean {
  return entry.status === 'completed' || entry.status === 'cancelled';
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
