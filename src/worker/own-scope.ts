/** Moves a session worker out of the cgroup it was started in and into a
 * systemd scope of its own, so everything its agent runs is accounted apart
 * from the program that opened the conversation.
 *
 * A worker is spawned by a window -- VS Code's extension host, a terminal --
 * and a plain spawn inherits that window's cgroup. The kernel shares CPU and
 * memory reclaim between cgroups, not processes: MEASURED 2026-10-08, three
 * agents' pre-push test runs and a typecheck put ~400 processes in VS Code's
 * own scope (load 98 on 16 cores), and the editor -- one process among them
 * -- froze. In a scope of its own the agent still gets every idle core; the
 * editor just stops competing with it as an equal inside one group.
 *
 * The worker is ADOPTED (StartTransientUnit with its pid), not started through
 * `systemd-run`: adoption measured 10-20 ms at load 91, a `systemd-run --scope`
 * launch ~400 ms on the first message's path. It runs before the worker starts
 * any vendor process, so every child is born in the new scope.
 *
 * Linux under a systemd user manager only; anything else, or any failure,
 * leaves the worker where it is -- this changes where work is accounted, never
 * whether it runs. CLIKCODE_OWN_SCOPE=0 turns it off. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { lifecycle } from '../runtime/lifecycle-log.js';

/** Top level, BESIDE app.slice -- not inside it. A slice over its MemoryHigh
 * throttles every allocation of every process under it: MEASURED 2026-10-08,
 * with agents in app-clikcode.slice, app.slice sat at its 36G ceiling and VS
 * Code (in app.slice) could not even open, stalled ~68% of the time. Apart,
 * an agent ceiling throttles only agents. A host bounds them with one unit
 * file for this slice. */
export const AGENT_SLICE = 'clikcode.slice';
const ADOPT_TIMEOUT_MS = 2_000;
/** StartTransientUnit returns once the job is queued; the move lands just after. */
const MOVED_WAIT_MS = 500;

export function scopeUnitName(sessionId: string, pid: number): string {
  return `clikcode-worker-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${pid}.scope`;
}

export function adoptArgs(unit: string, pid: number): string[] {
  return [
    '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    unit, 'fail', '3',
    'PIDs', 'au', '1', String(pid),
    'Slice', 's', AGENT_SLICE,
    'CollectMode', 's', 'inactive-or-failed',
    '0',
  ];
}

/** Only a process the user's own manager owns can be moved by it: one under a
 * login session's scope or a system service (an SSH session without a user
 * manager, tailscaled) belongs to the system manager. */
export function userManagerOwns(cgroup: string): boolean {
  return /^0::\/user\.slice\/user-\d+\.slice\/user@\d+\.service\//m.test(cgroup);
}

async function ownCgroup(): Promise<string> {
  return readFile('/proc/self/cgroup', 'utf8').catch(() => '');
}

export async function moveToOwnScope(sessionId: string): Promise<boolean> {
  if (process.platform !== 'linux' || process.env.CLIKCODE_OWN_SCOPE === '0') return false;
  if (!userManagerOwns(await ownCgroup())) return false;
  const unit = scopeUnitName(sessionId, process.pid);
  const adopted = await new Promise<boolean>((resolveAdopt) => {
    execFile('busctl', adoptArgs(unit, process.pid), { timeout: ADOPT_TIMEOUT_MS }, (error) => resolveAdopt(!error));
  });
  if (adopted) {
    const deadline = Date.now() + MOVED_WAIT_MS;
    while (!(await ownCgroup()).includes(`/${unit}`) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  lifecycle('worker.scope', { worker: sessionId, unit, adopted });
  return adopted;
}
