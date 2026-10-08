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
 * Linux under a systemd user manager; anywhere else, or if the move fails,
 * the worker lowers its own priority instead (lowerOwnPriority). Neither
 * changes whether work runs, only who yields when both want the CPU.
 * CLIKCODE_OWN_SCOPE=0 turns both off. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { constants, setPriority, totalmem } from 'node:os';
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

/** The agent slice's memory ceiling when the host defines none: agents past
 * it are throttled (never killed), and the rest of RAM stays for the desktop
 * and editor however much the agents allocate. */
export const DEFAULT_AGENT_MEMORY_SHARE = 0.75;

/** Creates the agent slice with the default ceiling. systemd refuses when a
 * unit file for it exists -- a host's own limits win, untouched. */
export function sliceArgs(memoryHighBytes: number): string[] {
  return [
    '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    AGENT_SLICE, 'fail', '2',
    'Description', 's', 'ClikCode agent work',
    'MemoryHigh', 't', String(Math.floor(memoryHighBytes)),
    '0',
  ];
}

/** Only a process the user's own manager owns can be moved by it: one under a
 * login session's scope or a system service (an SSH session without a user
 * manager, tailscaled) belongs to the system manager. */
export function userManagerOwns(cgroup: string): boolean {
  return /^0::\/user\.slice\/user-\d+\.slice\/user@\d+\.service\//m.test(cgroup);
}

/** Where the agent slice lives in the cgroup tree, from this process's own line. */
export function agentSliceDirectory(cgroup: string): string | undefined {
  const manager = /^0::(\/user\.slice\/user-\d+\.slice\/user@\d+\.service)\//m.exec(cgroup)?.[1];
  return manager ? `/sys/fs/cgroup${manager}/${AGENT_SLICE}` : undefined;
}

async function ownCgroup(): Promise<string> {
  return readFile('/proc/self/cgroup', 'utf8').catch(() => '');
}

function busctl(args: string[]): Promise<boolean> {
  return new Promise((resolveCall) => {
    execFile('busctl', args, { timeout: ADOPT_TIMEOUT_MS }, (error) => resolveCall(!error));
  });
}

async function moveToOwnScope(sessionId: string, cgroup: string): Promise<boolean> {
  const slice = agentSliceDirectory(cgroup);
  // Only the first worker on a boot finds no slice; every later one skips this call.
  if (slice && !existsSync(slice)) await busctl(sliceArgs(totalmem() * DEFAULT_AGENT_MEMORY_SHARE));
  const unit = scopeUnitName(sessionId, process.pid);
  const adopted = await busctl(adoptArgs(unit, process.pid));
  if (adopted) {
    const deadline = Date.now() + MOVED_WAIT_MS;
    while (!(await ownCgroup()).includes(`/${unit}`) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  lifecycle('worker.scope', { worker: sessionId, unit, adopted });
  return adopted;
}

/** Without cgroups to separate them (macOS, Windows, Linux without a user
 * manager), the worker lowers its own priority and every process it starts
 * inherits it -- on Windows too, for BELOW_NORMAL. A nice value, not macOS's
 * background QoS: that confines work to the efficiency cores even on an idle
 * machine. Nice only matters under contention -- the editor then wins about
 * nine to one -- and idle cores still all go to the agent. */
function lowerOwnPriority(sessionId: string): void {
  let lowered = true;
  try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch { lowered = false; }
  lifecycle('worker.priority', { worker: sessionId, lowered });
}

/** Keeps the agent's work from starving the program the user is looking at.
 * Call before any vendor process starts, so every child is born separated. */
export async function separateFromForeground(sessionId: string): Promise<void> {
  if (process.env.CLIKCODE_OWN_SCOPE === '0') return;
  if (process.platform === 'linux') {
    const cgroup = await ownCgroup();
    if (userManagerOwns(cgroup) && await moveToOwnScope(sessionId, cgroup)) return;
  }
  lowerOwnPriority(sessionId);
}
