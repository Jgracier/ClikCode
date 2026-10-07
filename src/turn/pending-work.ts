/** Tools a harness started and never settled before it exited.
 *
 * Several vendor CLIs background a long command and then exit, leaving the
 * step ACTIVE. The process that would report the output is gone. Starting
 * another model turn to go and look does not bring that process back. The
 * count here is how many calls, by id, were still open, so the turn can say
 * so. A frame with no id is not a call that can be counted. A completion
 * whose id was never started does not close some other call.
 */

export interface PendingWorkTracker {
  /** Feed every activity event the turn produced. */
  note(event: { kind: string; id?: string } | undefined): void;
  /** Tools started, by id, and never settled. */
  readonly outstanding: number;
  /** Start of a new attempt: a failover retry must not inherit the abandoned
   *  starts of the attempt it replaced. */
  reset(): void;
}

export function createPendingWorkTracker(_command: string): PendingWorkTracker {
  const running = new Set<string>();
  const settled = new Set<string>();
  return {
    note(event) {
      if (!event?.id) return;
      // Late detail for a call already finished is not a new call.
      if (settled.has(event.id)) return;
      if (event.kind === 'tool-start') {
        running.add(event.id);
        return;
      }
      if (event.kind !== 'tool-done' && event.kind !== 'tool-error') return;
      settled.add(event.id);
      running.delete(event.id);
    },
    get outstanding() {
      return running.size;
    },
    reset() {
      running.clear();
    },
  };
}
