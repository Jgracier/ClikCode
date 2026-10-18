/** A running sub-agent's own calls, as live rows.
 *
 * Each concurrent child has its own slot: one finishing never clears another's
 * (there used to be one slot per parent, and any child's `tool-done` emptied
 * it). A slot lives from the child's start frame to its `done`/`error`, or to
 * its parent's end. Children are never a transcript row of their own -- they
 * are drawn nested under the parent while it runs and vanish when it settles,
 * which keeps the parent's `(N tool uses)` as the only record.
 *
 * Placement is the standard's (section 5): a child sits under its parent, in
 * the order the children began, and never above text emitted before it. A
 * child that began at the parent's own offset sits directly under the parent;
 * one that began after more of the answer was written sits at its own
 * (offset, seq), which is below that text. */

import type { HarnessActivityEvent } from '../../harness/prompter.js';

/** Live children listed under one running parent. */
export const CHILDREN_SHOWN = 3;

type Slot = { parentId: string; label: string; offset: number; seq: number };

type ChildRow = {
  /** Unique within the turn. */
  id: string; parentId: string; label: string;
  /** Where it sorts, in the same (offset, seq) space as every other row. */
  offset: number; seq: number;
  /** The child that began last under its parent: it carries the count. */
  newest: boolean;
};

export class LiveChildren {
  private readonly slots = new Map<string, Slot>();
  /** Child calls already counted, so a progress frame is not a second use. */
  private readonly counted = new Set<string>();

  reset(): void {
    this.slots.clear();
    this.counted.clear();
  }

  private static key(event: HarnessActivityEvent): string {
    const parent = event.parentId!;
    return `${parent}\u0000${event.kind === 'thinking' ? 'thought' : event.id ?? `label:${event.label}`}`;
  }

  /** Fold one child frame in. `counted` is true for a call not seen before:
   * the parent's tool-use count goes up by one, whatever the frame count. */
  apply(event: HarnessActivityEvent, at: { offset: number; seq: number }): { counted: boolean } {
    if (!event.parentId) return { counted: false };
    const key = LiveChildren.key(event);
    if (event.kind === 'tool-done' || event.kind === 'tool-error') {
      this.slots.delete(key);
      return { counted: false };
    }
    if (event.kind !== 'tool-start' && event.kind !== 'thinking') return { counted: false };
    let counted = false;
    if (event.kind === 'tool-start') {
      // Its own words give way to the call it moved on to.
      this.slots.delete(`${event.parentId}\u0000thought`);
      if (!this.counted.has(key)) { this.counted.add(key); counted = true; }
    }
    const prior = this.slots.get(key);
    // A frame that fills in a row already placed never moves it.
    this.slots.set(key, prior ? { ...prior, label: event.label } : { parentId: event.parentId, label: event.label, offset: at.offset, seq: at.seq });
    return { counted };
  }

  /** What a parent's newest live child is doing now. */
  latest(parentId: string): string | undefined {
    let found: Slot | undefined;
    for (const slot of this.slots.values()) if (slot.parentId === parentId && (!found || slot.seq > found.seq)) found = slot;
    return found?.label;
  }

  /** The parent finished: nothing under it is live any more. */
  parentEnded(parentId: string): void {
    for (const [key, slot] of this.slots) if (slot.parentId === parentId) this.slots.delete(key);
  }

  /** Clamp offsets after the answer was replaced by a shorter one. */
  rebase(commonPrefix: number): void {
    for (const slot of this.slots.values()) if (slot.offset > commonPrefix) slot.offset = commonPrefix;
  }

  /** The rows to draw: the last few live children of each given running
   * parent, placed by the rule above. */
  rows(parents: ReadonlyArray<{ id: string; offset?: number; seq?: number }>): ChildRow[] {
    const out: ChildRow[] = [];
    for (const parent of parents) {
      const mine = [...this.slots.entries()].filter(([, slot]) => slot.parentId === parent.id)
        .sort((left, right) => left[1].seq - right[1].seq).slice(-CHILDREN_SHOWN);
      for (const [rank, [key, slot]] of mine.entries()) {
        const beside = parent.offset !== undefined && parent.seq !== undefined && slot.offset <= parent.offset;
        out.push({
          id: `child#${key}`, parentId: parent.id, label: slot.label,
          offset: beside ? parent.offset! : slot.offset,
          // Directly under the parent, in the order they began.
          seq: beside ? parent.seq! + (rank + 1) / 1000 : slot.seq,
          newest: rank === mine.length - 1,
        });
      }
    }
    return out;
  }
}
