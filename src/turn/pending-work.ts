/** Continuing a turn the harness ended while it was still waiting.
 *
 * Several vendor CLIs background a long command instead of blocking on it.
 * Antigravity is the clearest case: `run_command` carries its own
 * `WaitMsBeforeAsync`, and once that elapses the CLI says
 *
 *   root agent idle; waiting up to 5s for 1 background task(s)
 *   "...launched in the background. I will report its output as soon as it
 *    finishes."
 *   terminating 1 background task(s) on exit
 *
 * and exits, leaving its own tool step in state ACTIVE rather than DONE. The
 * promise in that sentence can never be kept inside that turn -- the process
 * that would report the output is gone. Found live: a session sat untouched
 * for ten minutes with its answer already complete in the vendor's own task
 * log, because nothing re-drove the harness to go read it.
 *
 * The signal is deliberately the generic one every transport already
 * produces: a `tool-start` with no matching `tool-done`/`tool-error`. Nothing
 * here is antigravity-specific, so a harness that backgrounds work the same
 * way is handled without another table entry.
 *
 * The hazard in that signal is the mirror image of the bug: a harness whose
 * parser never reports completions at all would look permanently mid-wait and
 * earn a continuation on EVERY turn, quietly multiplying what each turn costs.
 * So a tracker refuses to report pending work until it has seen that harness
 * settle at least one tool -- proof the pairing is real for this harness and
 * not an absence the parser was never going to fill. That evidence is kept per
 * harness across turns, because the turn that backgrounds a command is often
 * the one that ran no other tool.
 */

export interface PendingWorkTracker {
  /** Feed every activity event the turn produced. */
  note(event: { kind: string; id?: string } | undefined): void;
  /** Tools started and never settled, or 0 while this harness is unproven. */
  readonly outstanding: number;
  /** Start of a new attempt: a failover retry must not inherit the abandoned
   *  starts of the attempt it replaced. */
  reset(): void;
}

/** Harnesses observed to settle a tool, so their unmatched starts mean
 *  something. Module-level and per-process: the evidence is about the vendor's
 *  parser, not about one session. */
const settlesTools = new Set<string>();

/** Exposed for tests; a real run only ever adds to this. */
export function forgetToolPairingEvidence(): void {
  settlesTools.clear();
}

export function createPendingWorkTracker(command: string): PendingWorkTracker {
  const running = new Set<string>();
  let anonymous = 0;
  return {
    note(event) {
      if (!event) return;
      if (event.kind === 'tool-start') {
        if (event.id) running.add(event.id);
        else anonymous += 1;
        return;
      }
      if (event.kind !== 'tool-done' && event.kind !== 'tool-error') return;
      settlesTools.add(command);
      // Same pairing rule the idle watchdog uses: a completion whose start was
      // never seen still settles one outstanding tool.
      if (event.id && running.delete(event.id)) return;
      if (anonymous > 0) anonymous -= 1;
      else if (running.size > 0) running.delete(running.values().next().value as string);
    },
    get outstanding() {
      if (!settlesTools.has(command)) return 0;
      return running.size + anonymous;
    },
    reset() {
      running.clear();
      anonymous = 0;
    },
  };
}

/** Two independent bounds on continuing a turn, whichever binds first.
 *
 *  A count alone was the original mistake here: three attempts at 2s/8s/20s
 *  is a thirty-second budget, so a test suite or build that takes five
 *  minutes still had its answer stranded -- the exact failure this is meant
 *  to fix, merely made rarer. Antigravity's own system prompt tells the model
 *  to "simply pause and end the turn to wait for the background task to
 *  complete", so a wait is as long as the work is, and a budget has to be a
 *  duration.
 *
 *  The count still matters, because every continuation is a real model turn:
 *  it is what stops a backoff from becoming an unbounded polling loop. The
 *  duration is what makes the feature actually work. For reference the idle
 *  watchdog already allows a running tool a full hour of silence
 *  (DEFAULT_TOOL_IDLE_TIMEOUT_MS), so ten minutes here is conservative. */
export const MAX_PENDING_CONTINUATIONS = 6;
export const PENDING_WORK_BUDGET_MS = 10 * 60 * 1000;

/** Exponential backoff, capped, so a slow command is not hammered at a fixed
 *  interval and the whole budget is not spent in the first few seconds. */
export function pendingContinuationDelayMs(attempt: number): number {
  return Math.min(2_000 * 4 ** attempt, 120_000);
}

/** Whether a turn may be continued again: bounded in attempts AND in time. */
export function mayContinuePendingWork(attempts: number, elapsedMs: number): boolean {
  return attempts < MAX_PENDING_CONTINUATIONS && elapsedMs < PENDING_WORK_BUDGET_MS;
}

/** What the harness is told. Phrased as an instruction to go and look rather
 *  than an assertion that the work is done, because it may not be: the harness
 *  is the only thing that can actually tell. Antigravity exposes
 *  `manage_task(Action="list")` for exactly this, and other harnesses have
 *  their own, so this names the goal and lets each use whatever it has. */
export const PENDING_CONTINUATION_PROMPT =
  'A command you launched in the background is no longer being waited on by that turn. '
  + 'List your background tasks and check that command now -- its status, its output, and any '
  + 'task log it wrote -- then report the result. If it is still running, wait for it and then report.';
