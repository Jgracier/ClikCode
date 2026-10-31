/** Reading and ending a cgroup of ClikCode's: who is in it, how long the oldest process has lived, how much cpu it used.
 * Shared by the per-command lifetime limit (command-lifetime.ts) and `clikcode doctor`. All reads go through /proc and the
 * cgroup files, injectable so a test can use a directory of files. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupPids } from './command-groups.js';

/** A command whose command line carries this text is never ended for its age (harness/transport/background-commands.ts KEEP_MARK). */
export const KEEP = 'clikcode:keep';

/** Never ended for its age: the keep mark, or ClikCode's own browser host (an older host still lives in the worker scope that
 * started it, its group holding xvfb-run, the host and Chrome; ending that group would close the user's signed-in browser). */
export const isKept = (commandLine: string | undefined): boolean => !!commandLine && (commandLine.includes(KEEP) || /\bcomputer-host\b/.test(commandLine));

export interface CgroupReaders {
  /** Pids in the cgroup itself (not below it). */
  pids(dir: string): number[];
  /** Epoch ms the process started, or undefined once gone. */
  startedAt(pid: number): number | undefined;
  /** The process's command line, or undefined once gone. */
  commandLine(pid: number): string | undefined;
  file(path: string): string | undefined;
}

let boot: number | undefined;
function bootMs(): number | undefined {
  if (boot !== undefined) return boot;
  try {
    const seconds = Number(/^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    return Number.isFinite(seconds) ? (boot = seconds * 1000) : undefined;
  } catch { return undefined; }
}

export const realReaders: CgroupReaders = {
  pids: groupPids,
  startedAt: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const base = bootMs();
      return Number.isFinite(ticks) && base !== undefined ? base + (ticks / 100) * 1000 : undefined;
    } catch { return undefined; }
  },
  commandLine: (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { return undefined; } },
  file: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
};

export interface CgroupFacts {
  pids: number;
  /** Age of the oldest process in it, ms. Undefined when empty. */
  ageMs?: number;
  keep: boolean;
  /** The first command line in it that is not a bare shell wrapper, for a label. */
  command?: string;
  /** Cumulative cpu time of the cgroup and below, microseconds. */
  cpuUsec?: number;
  memoryBytes?: number;
  tasks?: number;
}

export function cgroupFacts(dir: string, now: number, read: CgroupReaders = realReaders): CgroupFacts {
  const pids = read.pids(dir);
  let oldest: number | undefined;
  let keep = false;
  let command: string | undefined;
  for (const pid of pids) {
    const started = read.startedAt(pid);
    if (started !== undefined && (oldest === undefined || started < oldest)) oldest = started;
    const line = read.commandLine(pid);
    if (isKept(line)) keep = true;
    if (line && !command) command = line;
  }
  const cpu = Number(/^usage_usec (\d+)/m.exec(read.file(join(dir, 'cpu.stat')) ?? '')?.[1]);
  const memory = Number(read.file(join(dir, 'memory.current')));
  const tasks = Number(read.file(join(dir, 'pids.current')));
  return {
    pids: pids.length, keep,
    ...(oldest !== undefined ? { ageMs: Math.max(0, now - oldest) } : {}),
    ...(command ? { command } : {}),
    ...(Number.isFinite(cpu) ? { cpuUsec: cpu } : {}),
    ...(Number.isFinite(memory) && memory > 0 ? { memoryBytes: memory } : {}),
    ...(Number.isFinite(tasks) && tasks > 0 ? { tasks } : {}),
  };
}

/** Ends everything in the cgroup and below it, at once, by the kernel (cgroup.kill). True when the write was accepted. */
export function killCgroup(dir: string): boolean {
  try { writeFileSync(join(dir, 'cgroup.kill'), '1'); return true; } catch { return false; }
}
