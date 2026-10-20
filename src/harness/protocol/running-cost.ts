/** A vendor process's cost is a RUNNING TOTAL, not a turn's.
 *
 * Claude's `total_cost_usd` (a `result` record, and claude-agent-acp's
 * `usage_update.cost.amount`) is what the process has cost so far. It keeps
 * growing across the turns one process serves, it starts again from zero when
 * the process is respawned, and a process that resumes a conversation may
 * start from the cost that conversation had already reached. Recorded as the
 * turn's own, a one-minute turn read hundreds of dollars (MEASURED on the
 * user's invocation log: 2127 Claude records, 692 steps down, "per-turn"
 * values summing to $120k for what totals $47k when read as growth).
 *
 * The turn's cost is how far the total grew while it ran. Pure arithmetic;
 * the caller keeps `last` (the total seen most recently) with the process
 * that reported it, so a respawn or another account starts fresh. */

/** Where a turn's cost is measured from, after a new reading `reading` of the
 * running total. `base` is the total the turn began at (undefined when the
 * process had reported none), `last` the reading before this one.
 *
 *  - no reading before: the process just started. It began at zero, unless it
 *    resumed a conversation whose earlier cost it may have restored
 *    (`unknownStart`): then this reading is only the place to measure from.
 *  - a reading below the one before: the process began again (the total never
 *    falls within one), so it counts from zero.
 *  - otherwise the base stands. */
export function costBase(base: number | undefined, last: number | undefined, reading: number, unknownStart: boolean): number {
  if (last === undefined) return base ?? (unknownStart ? reading : 0);
  if (reading < last) return 0;
  return base ?? 0;
}

/** One process's running total, for a transport that reads it from a stream
 * of records within a single turn (the one-shot CLI). */
export class ProcessCost {
  private base: number | undefined;
  private last: number | undefined;

  constructor(private readonly unknownStart = false) {}

  /** The turn's cost so far, given the process's running total. */
  note(reading: number): number {
    this.base = costBase(this.base, this.last, reading, this.unknownStart);
    this.last = reading;
    return Math.max(0, reading - this.base);
  }
}
