/** The agent loop's one guard against a model repeating itself.
 *
 * A call that fails again and again with the same arguments, while nothing
 * the agent did in between could have changed the outcome, will not start
 * working: the model is told to stop and explain. "Nothing changed" is the
 * point. A test command that fails, an edit, then the same test command is
 * the normal way to work, so any successful write- or exec-class call ends
 * the streak of every earlier failure. A failing call counts only against
 * itself; a read that succeeds forgets only its own failures. */
export const STALL_LIMIT = 3;

export class StallGuard {
  private readonly failures = new Map<string, number>();

  /** Record one call's outcome. True when this call has now failed `STALL_LIMIT`
   * times in a row with identical arguments and nothing changed in between. */
  record(key: string, outcome: { failed: boolean; mayChangeState: boolean }): boolean {
    if (!outcome.failed) {
      if (outcome.mayChangeState) this.failures.clear();
      else this.failures.delete(key);
      return false;
    }
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    return count >= STALL_LIMIT;
  }
}

/** The same call giving the same output this many times: the model is checking something that cannot change. */
export const REPEAT_NOTE_AT = 3;
/** And this many: it is not going to stop on its own, so the turn ends with what was done. */
export const REPEAT_STOP_AT = 6;
/** Calls whose identical answers mean no progress. Polling tools (bash_output, wait, monitor) are expected to repeat. */
export const REPEAT_CHECKED = new Set(['read_file', 'list_dir', 'glob', 'grep', 'bash']);

/** Counts how often each call has returned exactly the same output. A different output (the file changed, the test now passes)
 * starts the count again, so re-reading after a real change never counts. */
export class RepeatGuard {
  private readonly seen = new Map<string, { output: string; count: number }>();

  /** Record a successful call's output; returns how many times in a row this call has now given exactly it. */
  record(key: string, output: string): number {
    const before = this.seen.get(key);
    const count = before && before.output === output ? before.count + 1 : 1;
    this.seen.set(key, { output, count });
    return count;
  }
}
