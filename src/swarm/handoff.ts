/** A clerk working inside the host chat. The row stays up after the host
 * turn ends, so the host can keep going while the handoff runs. */

import type { HarnessActivityEvent } from '../harness/prompter.js';

export interface SwarmHandoffRow {
  event: HarnessActivityEvent;
  child?: string;
  startedAt: number;
}

/** Fold one spool event into the host's handoff rows. `handled` means it
 * belongs to a handoff, not to the host's own tool log. */
export function applySwarmHandoff(
  rows: readonly SwarmHandoffRow[], event: HarnessActivityEvent, now = Date.now(),
): { rows: SwarmHandoffRow[]; handled: boolean } {
  if (event.parentId) {
    const index = rows.findIndex((row) => row.event.id === event.parentId);
    if (index < 0) return { rows: [...rows], handled: false };
    const child = event.kind === 'tool-start' || event.kind === 'thinking' ? event.label : undefined;
    const next = [...rows];
    next[index] = { ...rows[index]!, ...(child ? { child } : { child: undefined }) };
    return { rows: next, handled: true };
  }
  if (!event.swarm) return { rows: [...rows], handled: false };
  const index = event.id ? rows.findIndex((row) => row.event.id === event.id) : -1;
  if (index >= 0) {
    const prior = rows[index]!;
    const next = [...rows];
    next[index] = { ...prior, event: { ...prior.event, ...event, swarm: event.swarm ?? prior.event.swarm } };
    return { rows: next, handled: true };
  }
  if (event.kind !== 'tool-start') return { rows: [...rows], handled: true };
  return { rows: [...rows, { event, startedAt: now }], handled: true };
}

/** Rows still spinning. A finished handoff leaves the strip when the next
 * host turn starts, because its card is then a message in the chat. */
export function runningHandoffs(rows: readonly SwarmHandoffRow[]): SwarmHandoffRow[] {
  return rows.filter((row) => row.event.kind === 'tool-start');
}
