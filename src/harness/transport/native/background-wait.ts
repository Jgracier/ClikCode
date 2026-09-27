/** Holding a vendor CLI's stdin open until its background work is done.
 *
 * Claude Code's `-p` mode ends the process when stdin closes, and on the way
 * out it KILLS every background task it started: a `Bash` with
 * `run_in_background`, an `Agent` launched in the background. Verified live
 * (claude 2.1.281): with the prompt piped and stdin closed, a backgrounded
 * `sleep 15; echo done` was reported `task_updated {status:"killed"}` right
 * after the `result`, and its output never reached anyone.
 *
 * With `--input-format stream-json` the prompt is a JSON message and stdin
 * can stay open. Then the task runs to completion, Claude emits
 * `task_notification {status:"completed"}`, and -- because it is idle -- it
 * starts a follow-up turn of its own (`system/init` ... `result`) that reads
 * the output and reports it. That is the whole mechanism; what is left is
 * deciding when nothing more can come, and closing stdin then.
 *
 * The stream says so, event by event:
 *  - `task_started {is_backgrounded:true}` -- a main-agent task that outlives
 *    the turn. Foreground tasks (`is_backgrounded:false`) and a subagent's own
 *    tasks (`owned_by_subagent:true`) also emit task events, and are not ours
 *    to wait for.
 *  - `background_tasks_changed {tasks:[...]}` -- the live list. It drops a
 *    task a moment BEFORE that task's notification arrives, so an empty list
 *    alone must not close stdin.
 *  - `task_notification` -- the task ended. Arriving while a turn is running,
 *    Claude folds it into that turn; arriving while idle, it starts a new one.
 *  - `system/init` opens a turn and `result` closes it.
 *
 * Settled = no turn open, no follow-up owed, no background task outstanding.
 * The two timers are safety ceilings for a promise the vendor did not keep (a
 * task that left the list with no notification; a notification that started
 * no turn), not the mechanism.
 */

type Json = Record<string, unknown>;

export interface BackgroundWait {
  /** Feed every parsed stdout record, in order. */
  note(value: Json): void;
  /** A user message was written to the held-open stdin: a turn is owed. */
  noteInput(): void;
  /** Main-agent background tasks still running. */
  readonly pending: number;
  /** Whether stdin is to be held open right now. */
  readonly settled: boolean;
  dispose(): void;
}

export interface BackgroundWaitOptions {
  /** Called once, when nothing more can arrive: close stdin. */
  onSettled(): void;
  onTaskStarted?(id: string, description: string): void;
  onTaskFinished?(id: string, status: string): void;
  /** Ceiling on a promise the vendor did not keep. Default 30 s. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 30_000;

export function createBackgroundWait(options: BackgroundWaitOptions): BackgroundWait {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const tasks = new Map<string, string>();
  const notOurs = new Set<string>();
  let turnOpen = true;
  let followUpOwed = false;
  let settled = false;
  let followUpTimer: NodeJS.Timeout | undefined;
  let orphanTimer: NodeJS.Timeout | undefined;
  const clear = (timer: NodeJS.Timeout | undefined): undefined => { if (timer) clearTimeout(timer); return undefined; };
  const finish = (id: string, status: string): boolean => {
    if (!tasks.delete(id)) return false;
    options.onTaskFinished?.(id, status);
    return true;
  };
  const check = (): void => {
    if (settled || turnOpen || followUpOwed || tasks.size > 0) return;
    settled = true;
    followUpTimer = clear(followUpTimer);
    orphanTimer = clear(orphanTimer);
    options.onSettled();
  };
  const arm = (callback: () => void): NodeJS.Timeout => {
    const timer = setTimeout(callback, graceMs);
    timer.unref();
    return timer;
  };
  const track = (id: string, description: string): void => {
    if (tasks.has(id) || notOurs.has(id)) return;
    tasks.set(id, description);
    options.onTaskStarted?.(id, description);
  };
  return {
    note(value) {
      if (settled) return;
      const type = value.type;
      const subtype = value.subtype;
      if (type === 'system' && subtype === 'init') {
        turnOpen = true;
        followUpOwed = false;
        followUpTimer = clear(followUpTimer);
        return;
      }
      if (type === 'result') {
        turnOpen = false;
        // A failed turn is over whatever is still running: the turn loop is
        // about to fail over or report, and nothing will read a follow-up.
        if (value.is_error === true) {
          for (const id of [...tasks.keys()]) finish(id, 'abandoned');
          followUpOwed = false;
        }
        check();
        return;
      }
      if (type !== 'system') return;
      const id = typeof value.task_id === 'string' ? value.task_id : undefined;
      if (subtype === 'task_started' && id) {
        if (value.is_backgrounded === true && value.owned_by_subagent !== true) {
          track(id, typeof value.description === 'string' ? value.description : 'background task');
        } else notOurs.add(id);
        return;
      }
      if (subtype === 'background_tasks_changed' && Array.isArray(value.tasks)) {
        const listed = new Set<string>();
        for (const entry of value.tasks) {
          const task = entry && typeof entry === 'object' ? entry as Json : undefined;
          if (typeof task?.task_id !== 'string') continue;
          listed.add(task.task_id);
          track(task.task_id, typeof task.description === 'string' ? task.description : 'background task');
        }
        // Gone from the list: its notification is due any moment. If it never
        // comes, stop waiting for it rather than holding the turn forever.
        const gone = [...tasks.keys()].some((task) => !listed.has(task));
        orphanTimer = clear(orphanTimer);
        if (gone) {
          orphanTimer = arm(() => {
            orphanTimer = undefined;
            for (const task of [...tasks.keys()]) if (!listed.has(task)) finish(task, 'unreported');
            check();
          });
        }
        return;
      }
      if (subtype === 'task_notification' && id) {
        if (!finish(id, typeof value.status === 'string' ? value.status : 'completed')) return;
        if (!turnOpen) {
          followUpOwed = true;
          followUpTimer = clear(followUpTimer);
          followUpTimer = arm(() => { followUpTimer = undefined; followUpOwed = false; check(); });
        }
        if (tasks.size === 0) orphanTimer = clear(orphanTimer);
        check();
      }
    },
    noteInput() {
      if (settled) return;
      turnOpen = true;
    },
    get pending() { return tasks.size; },
    get settled() { return settled; },
    dispose() {
      followUpTimer = clear(followUpTimer);
      orphanTimer = clear(orphanTimer);
    },
  };
}

/** One user message in Claude's stream-json input format. */
export function streamJsonUserMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}
