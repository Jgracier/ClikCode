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
