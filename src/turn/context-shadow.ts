/** What a conversation would have carried had ClikCode left compaction to the vendor's default
 * (its own trigger near the top of the window): the "without auto-tune" side of `clikcode usage`.
 *
 * Every model call reads the whole context, so a turn's input is about the sum of its calls'
 * context readings. The shadow is that reading plus everything ClikCode's earlier compactions took
 * out -- until the shadow passes the vendor's own trigger, where the vendor would have compacted
 * too and the two sides meet again. A turn records the sum of both over its calls; the difference
 * is what the lower threshold saved (an estimate: the vendor's summary is taken to be as long as
 * ClikCode's). Dependency-free, so tests and the report can use it. */

/** Kept on the conversation between turns (HarnessSession.contextShadow). */
export interface ContextShadow {
  /** Tokens ClikCode's compactions removed since the sides last met. */
  removed: number;
  /** The latest call's reading. */
  last?: number;
  /** The compaction (CompactionRecord.at) the readings so far came after. */
  compactionAt?: string;
  /** A compaction was just seen: the reading before it, until the context rises again (a vendor's
   * own boundary reports only what its summary kept, first and lower). */
  pending?: { before: number; base: number; seen?: number };
}

/** One turn's sums over its model calls. */
export interface ContextTally { calls: number; contextSum: number; shadowSum: number }

/** Claude Code's room for its summary: min(output limit, 20k) + a 13k buffer (compaction.ts). */
const CLAUDE_SUMMARY_ROOM = 33_000;
/** Other vendors' default: about 90% of the window (Codex's auto-compact limit, opencode, Gemini). */
const DEFAULT_TRIGGER_SHARE = 0.9;

/** Where the vendor would have compacted by itself, for a model whose window is `window`. Undefined
 * without a window: then the shadow follows the real context and nothing is claimed as saved. */
export function vendorDefaultTrigger(window: number | undefined, claudeWindow: boolean): number | undefined {
  if (!window || window <= 0) return undefined;
  return claudeWindow ? Math.max(window - CLAUDE_SUMMARY_ROOM, Math.round(window / 2)) : Math.round(window * DEFAULT_TRIGGER_SHARE);
}

/** Note one model call's context reading `used`. `compactionAt` is the conversation's latest
 * compaction now; `trigger` the vendor's default (vendorDefaultTrigger). Returns the shadow
 * reading -- what the call would have read without ClikCode's threshold. */
export function noteShadowReading(shadow: ContextShadow, used: number, compactionAt: string | undefined, trigger: number | undefined): number {
  if (compactionAt !== shadow.compactionAt) {
    if (shadow.last !== undefined) shadow.pending = { before: shadow.last, base: shadow.removed };
    shadow.compactionAt = compactionAt;
  }
  if (shadow.pending) {
    const { before, base, seen } = shadow.pending;
    // The baseline would have compacted at this point too: both sides start again from here.
    if (trigger === undefined || before + base >= trigger) { shadow.removed = 0; shadow.pending = undefined; }
    else {
      // What the compaction left is the first reading that rose (the vendor's boundary reports
      // its summary alone, first); ClikCode's own first reading is already it, and the next call's
      // growth is then counted as left, not removed -- the estimate errs toward less saved.
      const left = seen !== undefined && used > seen ? seen : used;
      shadow.removed = base + Math.max(0, before - left);
      if (left === used) shadow.pending.seen = used;
      else shadow.pending = undefined;
    }
  }
  let reading = used + shadow.removed;
  if (trigger !== undefined && reading > trigger) { shadow.removed = 0; reading = used; }
  shadow.last = used;
  return reading;
}

export const emptyTally = (): ContextTally => ({ calls: 0, contextSum: 0, shadowSum: 0 });

export function addToTally(tally: ContextTally, used: number, shadow: number): void {
  tally.calls += 1;
  tally.contextSum += used;
  tally.shadowSum += shadow;
}

/** A turn's tokens without ClikCode's threshold: its own, plus what the shadow read beyond it. */
export function tokensWithoutTune(tokens: number, record: { contextSum?: number; shadowSum?: number }): number {
  const extra = (record.shadowSum ?? 0) - (record.contextSum ?? 0);
  return tokens + Math.max(0, extra);
}
