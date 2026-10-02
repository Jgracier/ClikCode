/** A vendor host reports its own `swarm` tool and, separately, the clerk.
 * Those are one call. A subagent is one row: the clerk's frames are that
 * row, and the bare tool frame is dropped once the clerk row exists. When
 * the host tool is already on screen, the clerk adopts its id so the row
 * updates in place. */

import type { HarnessActivityEvent } from '../harness/prompter.js';

export interface SwarmFold {
  /** Host tool-call ids waiting for a clerk, oldest first. */
  native: string[];
  /** Clerk ids that arrived before the host tool, oldest first. */
  early: string[];
  /** Host tool ids whose row the clerk already covers. */
  hidden: string[];
  /** Clerk call id to the id the row uses. */
  alias: ReadonlyMap<string, string>;
}

export function emptySwarmFold(): SwarmFold {
  return { native: [], early: [], hidden: [], alias: new Map() };
}

/** The host's own swarm tool, as a row label. `Swarm cap` is a result we
 * write ourselves, not that tool. */
export function isSwarmToolLabel(label: string): boolean {
  if (/clikcode[-_]?swarm\s*›\s*swarm\b/i.test(label)) return true;
  const verb = label.trim().split(/\s+/, 1)[0] ?? '';
  return verb.toLowerCase() === 'swarm' && !/^swarm cap$/i.test(label.trim());
}

/** `event` omitted means this frame must not become its own row. */
export function foldSwarmActivity(fold: SwarmFold, event: HarnessActivityEvent): { fold: SwarmFold; event?: HarnessActivityEvent } {
  if (event.swarm) return foldClerk(fold, event);
  if (!event.id || !isSwarmToolLabel(event.label)) return { fold, event };
  if (fold.hidden.includes(event.id) || [...fold.alias.values()].includes(event.id)) return { fold };
  if (fold.early.length > 0) {
    return { fold: { ...fold, early: fold.early.slice(1), hidden: [...fold.hidden, event.id] } };
  }
  if (event.kind === 'tool-start' && !fold.native.includes(event.id)) {
    return { fold: { ...fold, native: [...fold.native, event.id] }, event };
  }
  return { fold, event };
}

function foldClerk(fold: SwarmFold, event: HarnessActivityEvent): { fold: SwarmFold; event: HarnessActivityEvent } {
  if (event.parentId) {
    const parent = fold.alias.get(event.parentId);
    return { fold, event: parent && parent !== event.parentId ? { ...event, parentId: parent } : event };
  }
  if (!event.id) return { fold, event };
  const known = fold.alias.get(event.id);
  if (known) return { fold, event: known === event.id ? event : { ...event, id: known } };
  const native = fold.native[0];
  if (!native) {
    const alias = new Map(fold.alias);
    alias.set(event.id, event.id);
    return { fold: { ...fold, early: [...fold.early, event.id], alias }, event };
  }
  const alias = new Map(fold.alias);
  alias.set(event.id, native);
  return { fold: { ...fold, native: fold.native.slice(1), alias }, event: { ...event, id: native } };
}
