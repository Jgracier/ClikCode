/** What a background command is doing, whether it has outlived its use, and how it is ended.
 *
 * A vendor reports "1 background terminal" and nothing else; the processes behind it are known by
 * their pids (persistent-session.ts leftCommands). This reads each one from /proc -- age, cpu, the
 * last time its output file changed -- so a status line can say what is being waited on, and so a
 * command that has run for hours at full cpu without a word (2026-10-30: a vitest worker spinning
 * for 32 h under a stopped sub-agent held a chat 'thinking' all that time) is marked stale and ended.
 *
 * Everything that ends a process here ends it BY PID, from a tracked command: its own process group
 * when it leads one that is not the vendor's, else the process and the processes below it. Never by
 * name or pattern. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { describeCommands, formatAge, type BackgroundCommand } from '../protocol/background-agents.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { commandLine, outputFile, processAlive } from './process-group.js';

/** One background command as a status line reads it. Times are epoch ms. */
export interface CommandStats extends BackgroundCommand {
  outputFile?: string;
  /** The command asked to be left alone (KEEP_MARK). */
  keep?: boolean;
}

/** A command that carries this text in its command line (or description) is never reaped for its
 * owner ending or by the policy: the one explicit "keep running" flag. */
export const KEEP_MARK = 'clikcode:keep';

export interface CommandPolicy {
  /** Longest a background command may run before it is stale. */
  maxLifetimeMs: number;
  /** Stale when it has run this long above hotCpuPercent with no output. */
  hotMs: number;
  hotCpuPercent: number;
}

const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The policy in force: 2 h at most, or 30 min above 90 % cpu with no output. CLIKCODE_BACKGROUND_MAX_MS and
 * CLIKCODE_BACKGROUND_HOT_MS change the two times (0 or unset keeps the default). */
export function commandPolicy(): CommandPolicy {
  return { maxLifetimeMs: envMs('CLIKCODE_BACKGROUND_MAX_MS', 2 * 3_600_000), hotMs: envMs('CLIKCODE_BACKGROUND_HOT_MS', 30 * 60_000), hotCpuPercent: 90 };
}

/** Why `stats` is stale at `now`, or undefined. Pure. */
export function staleVerdict(stats: CommandStats, now: number, policy: CommandPolicy = commandPolicy()): string | undefined {
  if (stats.keep || stats.startedAt === undefined) return undefined;
  const age = now - stats.startedAt;
  const silentSince = Math.max(stats.startedAt, stats.lastOutputAt ?? 0);
  if (age >= policy.maxLifetimeMs) return `ran ${formatAge(age)}, over the ${formatAge(policy.maxLifetimeMs)} limit`;
  if ((stats.cpuPercent ?? 0) > policy.hotCpuPercent && now - silentSince >= policy.hotMs) {
    return `cpu ${Math.round(stats.cpuPercent!)}% with no output for ${formatAge(now - silentSince)}`;
  }
  return undefined;
}

export { describeCommands, formatAge };

const TICKS_PER_SECOND = 100;

interface ProcessTimes { startTicks: number; cpuTicks: number; pgrp: number }

async function processTimes(pid: number): Promise<ProcessTimes | undefined> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(quiet('harness/transport/background-commands'));
  if (!text) return undefined;
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // After `pid (comm)`: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... starttime(index 19)
  const [pgrp, utime, stime, starttime] = [Number(fields[2]), Number(fields[11]), Number(fields[12]), Number(fields[19])];
  return [pgrp, utime, stime, starttime].every(Number.isFinite) ? { startTicks: starttime, cpuTicks: utime + stime, pgrp } : undefined;
}

let bootTime: number | undefined;
async function bootTimeMs(): Promise<number | undefined> {
  if (bootTime !== undefined) return bootTime;
  const text = await readFile('/proc/stat', 'utf8').catch(quiet('harness/transport/background-commands'));
  const seconds = Number(/^btime (\d+)/m.exec(text ?? '')?.[1]);
  return Number.isFinite(seconds) ? (bootTime = seconds * 1000) : undefined;
}

/** The cpu use of a command between two samples, remembered per pid here. */
export class CommandSampler {
  private readonly last = new Map<number, { at: number; ticks: number }>();

  /** `pid` as it is now. Linux only for age and cpu; elsewhere just the label. */
  async sample(pid: number, extras: { label?: string; outputFile?: string } = {}, now: number = Date.now(), policy: CommandPolicy = commandPolicy()): Promise<CommandStats> {
    const [times, boot, label, output] = await Promise.all([
      processTimes(pid), bootTimeMs(), extras.label !== undefined ? extras.label : commandLine(pid), extras.outputFile ?? outputFile(pid),
    ]);
    const text = label ?? 'background command';
    const stats: CommandStats = { pid, label: text, ...(output ? { outputFile: output } : {}) };
    if (times) {
      stats.pgid = times.pgrp;
      if (boot !== undefined) stats.startedAt = boot + (times.startTicks / TICKS_PER_SECOND) * 1000;
      const before = this.last.get(pid);
      this.last.set(pid, { at: now, ticks: times.cpuTicks });
      // The first look has no earlier one to compare with: the whole life's average stands in for it.
      if (before && now > before.at) stats.cpuPercent = Math.max(0, ((times.cpuTicks - before.ticks) / TICKS_PER_SECOND) / ((now - before.at) / 1000) * 100);
      else if (stats.startedAt !== undefined && now > stats.startedAt) stats.cpuPercent = Math.max(0, (times.cpuTicks / TICKS_PER_SECOND) / ((now - stats.startedAt) / 1000) * 100);
    }
    if (output) {
      const info = await stat(output).catch(() => undefined);
      if (info && info.size > 0) stats.lastOutputAt = info.mtimeMs;
    }
    if (text.includes(KEEP_MARK)) stats.keep = true;
    const stale = staleVerdict(stats, now, policy);
    if (stale) stats.stale = stale;
    return stats;
  }

  forget(alive: ReadonlySet<number>): void {
    for (const pid of [...this.last.keys()]) if (!alive.has(pid)) this.last.delete(pid);
  }
}

/** The pids below `pid` (its children, theirs...), read from /proc. */
async function descendants(pid: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  const entries = await readdir('/proc').catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const text = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
    if (!text) return;
    const parent = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isFinite(parent)) children.set(parent, [...children.get(parent) ?? [], Number(name)]);
  }));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) if (!found.includes(child)) { found.push(child); queue.push(child); }
  return found;
}

export interface KillReport { pid: number; how: 'group' | 'tree' | 'gone'; signalled: number[]; error?: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** End the tracked command `pid`: SIGTERM, then SIGKILL after `graceMs` to whatever is left. When it
 * leads a process group of its own (the vendor spawns a tool's shell that way) the whole group goes
 * with one signal; a group shared with the vendor or with this process is never signalled -- the
 * command and the processes below it are, by pid. Never matched by name. */
export async function killCommand(pid: number, options: { vendorPgid?: number; graceMs?: number; kill?: (target: number, signal: NodeJS.Signals) => void } = {}): Promise<KillReport> {
  const send = options.kill ?? ((target: number, signal: NodeJS.Signals) => { process.kill(target, signal); });
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !processAlive(pid)) return { pid, how: 'gone', signalled: [] };
  const times = await processTimes(pid);
  const own = times?.pgrp === pid && pid !== options.vendorPgid && pid !== process.pid && times.pgrp !== process.pid;
  const below = await descendants(pid);
  const signalled: number[] = [];
  const attempt = (target: number, signal: NodeJS.Signals): string | undefined => {
    try { send(target, signal); signalled.push(target); return undefined; } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? undefined : String((error as Error).message);
    }
  };
  let error: string | undefined;
  if (own) error = attempt(-pid, 'SIGTERM');
  // Below the command even when it leads a group: a descendant may have gone into another (setsid).
  for (const child of [pid, ...below].reverse()) error = attempt(child, 'SIGTERM') ?? error;
  await sleep(options.graceMs ?? 2_000);
  for (const target of [pid, ...below]) if (processAlive(target)) error = attempt(target, 'SIGKILL') ?? error;
  if (own) error = attempt(-pid, 'SIGKILL') ?? error;
  return { pid, how: own ? 'group' : 'tree', signalled, ...(error ? { error } : {}) };
}
