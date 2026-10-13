/** Keeps agents' commands from taking the memory the desktop and editor need,
 * by reacting, not predicting: commands grow, so nothing is capped up front.
 *
 * Every conversation's worker watches the agent slice (own-scope.ts) against
 * what the machine can give it -- free memory less a reserve for the desktop,
 * and never past the slice's own hard ceiling. Near that line the agent whose
 * command is largest is told memory is getting tight (a nudge). Past it, that
 * command -- the largest one any agent is running -- is stopped, and its agent
 * is told what was stopped and why, so it can run something lighter. The
 * notes go to the model only (turn/resource-notes.ts).
 *
 * A "command" is what an agent ran: the first process below a shell, with
 * everything it started. The worker, the vendor's own process and MCP servers
 * are never one. Each worker acts only on its own conversation's processes;
 * every worker reads the same numbers, so exactly the owner acts.
 *
 * MEASURED 2026-10-10/12: agents' test runs exhausted RAM and swap and the
 * kernel's own pick took VS Code's GPU process (the editor quit); a soft
 * per-chat ceiling instead throttled whole conversations silently. Linux
 * only: it needs the worker in its own scope under the agent slice. */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';

const GIB = 2 ** 30;
const TICK_MS = 2_000;
/** Told memory is getting tight from here (of the limit)... */
export const NUDGE_AT = 0.85;
/** ...and again only once usage has fallen back below this. */
export const NUDGE_REARM_BELOW = 0.75;
/** A stopped command's memory takes a moment to come back. */
const KILL_SETTLE_MS = 5_000;
/** The slice's own MemoryMax kills by the kernel's choice; this acts first. */
const SLICE_MAX_SHARE = 0.97;

export interface MemorySample {
  /** MemTotal and MemAvailable (/proc/meminfo), bytes. */
  total: number;
  available: number;
  /** What the agent slice holds that cannot simply be dropped: anon + shmem + kernel. */
  agentUsed: number;
  /** The slice's memory.max, if it has one. */
  agentMax?: number;
}

export interface AgentBudget { used: number; limit: number; ratio: number }

/** Room left for the desktop and editor beyond what they use now. */
export function desktopReserve(total: number): number {
  return Math.max(4 * GIB, total * 0.08);
}

/** What agents may hold right now: theirs plus what is free, less the
 * desktop's reserve, and never past the slice's own ceiling. */
export function agentBudget(sample: MemorySample): AgentBudget {
  const byMachine = sample.agentUsed + sample.available - desktopReserve(sample.total);
  const bySlice = sample.agentMax ? sample.agentMax * SLICE_MAX_SHARE : Infinity;
  const limit = Math.max(0, Math.min(byMachine, bySlice));
  return { used: sample.agentUsed, limit, ratio: limit > 0 ? sample.agentUsed / limit : Infinity };
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Resident plus swapped, bytes. */
  bytes: number;
  /** Basename of the executable: tells a shell running a script from what it runs. */
  exe: string;
  command: string;
}

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh', 'mksh', 'busybox']);
const MCP = /(?:^|[\s/@_-])mcp(?:$|[\s/._-])|-mcp\b|\bmcp-/i;
const WORKER = /\ssession-worker\s/;

export interface CommandTree {
  /** The worker whose conversation ran it. */
  worker: number;
  root: ProcessEntry;
  pids: number[];
  bytes: number;
}

export interface ProcessView {
  /** Every command an agent is running, largest first. */
  commands: CommandTree[];
  /** Each worker's whole tree, bytes. */
  byWorker: Map<number, number>;
}

/** Commands and their owners, from the processes in the agent slice. */
export function viewProcesses(entries: readonly ProcessEntry[]): ProcessView {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const workers = entries.filter((entry) => WORKER.test(` ${entry.command} `));
  const byWorker = new Map<number, number>();
  const commands: CommandTree[] = [];
  const subtree = (root: ProcessEntry): ProcessEntry[] => {
    const out: ProcessEntry[] = [];
    const stack = [root];
    while (stack.length) {
      const next = stack.pop()!;
      out.push(next);
      stack.push(...(children.get(next.pid) ?? []));
    }
    return out;
  };
  for (const worker of workers) {
    byWorker.set(worker.pid, subtree(worker).reduce((sum, entry) => sum + entry.bytes, 0));
    // Down from the worker: a process with a shell above it (below the
    // worker) and none of its own ancestors already a command is a command.
    const walk = (entry: ProcessEntry, belowShell: boolean): void => {
      for (const child of children.get(entry.pid) ?? []) {
        const shell = SHELLS.has(child.exe);
        if (!shell && belowShell && !MCP.test(child.command)) {
          const tree = subtree(child);
          commands.push({ worker: worker.pid, root: child, pids: tree.map((item) => item.pid), bytes: tree.reduce((sum, item) => sum + item.bytes, 0) });
          continue;
        }
        walk(child, belowShell || shell);
      }
    };
    if (byPid.has(worker.pid)) walk(worker, false);
  }
  commands.sort((a, b) => b.bytes - a.bytes);
  return { commands, byWorker };
}

export type GuardAction =
  | { kind: 'none' }
  | { kind: 'nudge'; worker: number; command?: CommandTree }
  | { kind: 'stop'; command: CommandTree };

/** What to do at this ratio: stop the largest command past the limit; near
 * it, nudge whoever runs the largest (or, with no command running, holds the
 * most). Who acts is the owner (`worker`), and only they. */
export function decideAction(budget: AgentBudget, view: ProcessView): GuardAction {
  if (budget.ratio < NUDGE_AT) return { kind: 'none' };
  const largest = view.commands[0];
  if (budget.ratio >= 1 && largest) return { kind: 'stop', command: largest };
  if (largest) return { kind: 'nudge', worker: largest.worker, command: largest };
  const heaviest = [...view.byWorker].sort((a, b) => b[1] - a[1])[0];
  return heaviest ? { kind: 'nudge', worker: heaviest[0] } : { kind: 'none' };
}

const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;
const shown = (command: string): string => (command.length > 160 ? `${command.slice(0, 157)}...` : command);

export function nudgeNote(budget: AgentBudget, conversations: number, command?: CommandTree): string {
  return [
    `Memory on this machine is getting tight: agents are using ${gb(budget.used)} of the ${gb(budget.limit)} they can have`
      + ` (${conversations} conversation${conversations === 1 ? '' : 's'} share it).`,
    command ? `Your \`${shown(command.root.command)}\` is the largest command running, at ${gb(command.bytes)}.` : '',
    'Prefer lighter work for now: run only the tests for what you changed, use fewer parallel workers, and avoid starting another heavy build or suite.'
      + ' If memory runs out, ClikCode stops the largest command and tells you.',
  ].filter(Boolean).join(' ');
}

export function stopNote(budget: AgentBudget, conversations: number, command: CommandTree): string {
  const others = command.pids.length - 1;
  return [
    `ClikCode stopped \`${shown(command.root.command)}\`${others ? ` (and ${others} process${others === 1 ? '' : 'es'} it started)` : ''}`
      + ` at ${gb(command.bytes)}: agents had used all the memory this machine can give them (${gb(budget.used)} of ${gb(budget.limit)},`
      + ` shared by ${conversations} conversation${conversations === 1 ? '' : 's'}), and it was the largest command running.`,
    'It did not fail on its own; it was killed (exit 137 / SIGKILL). Run something lighter instead: only the tests or files you changed,'
      + ' fewer parallel workers (e.g. --maxWorkers=2, -j2), or split it into smaller runs. Do not rerun it unchanged.',
  ].join(' ');
}

// --- Reading the machine -----------------------------------------------------

function readNumber(path: string): number | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === 'max' ? undefined : Number(text);
  } catch { return undefined; }
}

export function sampleMemory(sliceDir: string): MemorySample | undefined {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const field = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) * 1024;
    const stat = readFileSync(join(sliceDir, 'memory.stat'), 'utf8');
    const statField = (name: string): number => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(stat)?.[1] ?? 0);
    const agentMax = readNumber(join(sliceDir, 'memory.max'));
    return {
      total: field('MemTotal'), available: field('MemAvailable'),
      agentUsed: statField('anon') + statField('shmem') + statField('kernel'),
      ...(agentMax ? { agentMax } : {}),
    };
  } catch { return undefined; }
}

function slicePids(dir: string): number[] {
  const pids: number[] = [];
  const visit = (path: string): void => {
    try {
      for (const line of readFileSync(join(path, 'cgroup.procs'), 'utf8').split('\n')) if (line) pids.push(Number(line));
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) visit(join(path, entry.name));
    } catch { /* fail-open-ok: a scope that ended mid-read has no processes left to count */ }
  };
  visit(dir);
  return pids;
}

export function readProcesses(sliceDir: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const pid of slicePids(sliceDir)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kib = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0);
      let exe = '';
      try { exe = readlinkSync(`/proc/${pid}/exe`).split('/').pop()!.replace(/ \(deleted\)$/, ''); } catch { /* fail-open-ok: a zombie has no exe; it is no shell */ }
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      entries.push({ pid, ppid, bytes: (kib('VmRSS') + kib('VmSwap')) * 1024, exe, command });
    } catch { /* fail-open-ok: the process exited between listing and reading */ }
  }
  return entries;
}

// --- Acting --------------------------------------------------------------------

export interface ResourceGuardOptions {
  sessionId: string;
  sliceDir: string;
  /** Hand a note to this conversation's model (turn/resource-notes.ts). */
  deliver: (note: string) => void;
}

export function startResourceGuard(options: ResourceGuardOptions): () => void {
  const { sessionId, sliceDir, deliver } = options;
  let nudged = false;
  let settleUntil = 0;
  const tick = (): void => {
    const sample = sampleMemory(sliceDir);
    if (!sample) return;
    const budget = agentBudget(sample);
    if (budget.ratio < NUDGE_REARM_BELOW) nudged = false;
    if (budget.ratio < NUDGE_AT || Date.now() < settleUntil) return;
    const view = viewProcesses(readProcesses(sliceDir));
    const action = decideAction(budget, view);
    const conversations = view.byWorker.size;
    if (action.kind === 'stop' && action.command.worker === process.pid) {
      for (const pid of action.command.pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* fail-open-ok: it already exited, which is what was wanted */ } }
      settleUntil = Date.now() + KILL_SETTLE_MS;
      lifecycle('resource.stop', { session: sessionId, command: shown(action.command.root.command), bytes: action.command.bytes, processes: action.command.pids.length, used: budget.used, limit: budget.limit });
      deliver(stopNote(budget, conversations, action.command));
    } else if (action.kind === 'nudge' && action.worker === process.pid && !nudged) {
      nudged = true;
      lifecycle('resource.nudge', { session: sessionId, ...(action.command ? { command: shown(action.command.root.command), bytes: action.command.bytes } : {}), used: budget.used, limit: budget.limit });
      deliver(nudgeNote(budget, conversations, action.command));
    }
  };
  const timer = setInterval(() => {
    try { tick(); } catch (error) { lifecycle('resource.error', { session: sessionId, message: error instanceof Error ? error.message : String(error) }); }
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
