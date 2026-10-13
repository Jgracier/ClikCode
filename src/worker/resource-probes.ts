/** What the resource guard reads, per platform. Both probes answer the same
 * two questions -- how much memory agents may still use, and what could be
 * stopped -- so the guard's decisions and its notes to agents are the same
 * everywhere; only how exactly they are measured differs.
 *
 * Linux in a divided scope (own-scope.ts): command cgroups and each
 * process's proportional anonymous memory, including pages allocated before
 * a command was moved. A sweep can miss a short-lived or exec'd shell, so
 * unidentified work is never a stop candidate. Everywhere else -- macOS,
 * Windows, Linux without a systemd user manager -- the process table:
 * each live worker's shell descendants, sized by resident memory
 * (approximate: shared pages can count twice). */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { AGENT_GROUP, bestLabel, COMMAND_GROUP, commandLabel, findCommands, groupPids, readProc, type ProcInfo, type ProcReader } from './command-groups.js';
import { WORKER_PID_ENV } from './own-scope.js';

/** How a unit is stopped: its cgroup, or its process tree. */
export type StopTarget = { cgroup: string } | { pids: number[]; root: number; command: string; startedAt?: string };

/** Something that can be stopped, as its probe accounts it. */
export interface Unit {
  kind: 'command';
  target: StopTarget;
  /** The live worker whose agent ran it (commands only). */
  owner?: number;
  label: string;
  /** What stopping it frees: its anonymous memory and swap (Linux), its
   * resident memory (elsewhere). Never its files in /tmp. */
  freeable: number;
}

export interface Inventory {
  units: Unit[];
  /** Pids of the live workers. */
  workers: number[];
}

export interface MemorySample {
  total: number;
  /** Memory the machine can still hand out, bytes. */
  available: number;
  /** What agents hold that cannot simply be dropped; the whole machine's use where agents are not accounted apart. */
  used: number;
  /** A ceiling of agents' own, below what the machine allows (Linux: the slice's MemoryHigh / MemoryMax). */
  ceiling?: number;
  /** The machine says memory is critical now: Linux, agents stalled on memory
   * 10%+ of the last 10 s; macOS, the kernel's critical pressure level. */
  critical: boolean;
}

export interface Probe {
  sample(): MemorySample | undefined | Promise<MemorySample | undefined>;
  inventory(): Inventory | Promise<Inventory>;
  stop(target: StopTarget): boolean | Promise<boolean>;
}

const execFileAsync = promisify(execFile);

const isWorker = (command: string | undefined): boolean => !!command && /\ssession-worker\s/.test(` ${command} `);

// --- Linux: cgroups ------------------------------------------------------------

/** Every agent in the slice stalled on memory this much of the last 10 s: critical. */
export const STALL_CRITICAL_PERCENT = 10;

function readNumber(path: string): number | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === 'max' ? undefined : Number(text);
  } catch { return undefined; }
}

function statField(dir: string, name: string): number {
  try { return Number(new RegExp(`^${name} (\\d+)`, 'm').exec(readFileSync(join(dir, 'memory.stat'), 'utf8'))?.[1] ?? 0); } catch { return 0; }
}

/** Memory allocated before a process was moved to its command group remains
 * charged to its old cgroup until freed. smaps_rollup follows the process,
 * so it includes that memory; PSS avoids double-counting shared pages. */
function processFreeable(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (name: string): number => Number(new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(stat)?.[1] ?? 0);
    return (kb('Pss_Anon') + kb('SwapPss')) * 1024;
  } catch { return 0; }
}

/** What killing a group frees: its anonymous memory and its swap. */
export function cgroupFreeable(dir: string): number {
  const chargedHere = statField(dir, 'anon') + (readNumber(join(dir, 'memory.swap.current')) ?? 0);
  const residentProcesses = groupPids(dir).reduce((sum, pid) => sum + processFreeable(pid), 0);
  return Math.max(chargedHere, residentProcesses);
}

export function sampleSlice(sliceDir: string): MemorySample | undefined {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const field = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) * 1024;
    // Past MemoryHigh the kernel throttles every agent, so the lower of the two
    // is the ceiling. MEASURED 2026-10-13: with only memory.max (38G) counted,
    // agents sat throttled at 34-37G for a morning until the user killed commands.
    const ceilings = [readNumber(join(sliceDir, 'memory.high')), readNumber(join(sliceDir, 'memory.max'))].filter((value): value is number => !!value);
    let stalled = 0;
    try { stalled = Number(/^full avg10=([\d.]+)/m.exec(readFileSync(join(sliceDir, 'memory.pressure'), 'utf8'))?.[1]) || 0; } catch { /* fail-open-ok: no pressure file, judged by the numbers alone */ }
    return {
      total: field('MemTotal'), available: field('MemAvailable'),
      used: statField(sliceDir, 'anon') + statField(sliceDir, 'shmem') + statField(sliceDir, 'kernel'),
      ...(ceilings.length ? { ceiling: Math.min(...ceilings) } : {}),
      critical: stalled >= STALL_CRITICAL_PERCENT,
    };
  } catch { return undefined; }
}

/** The worker pid our systemd-run shim stamped on a scope, if it did. */
export function workerPidFromEnv(envText: string): number | undefined {
  const value = envText.split('\0').find((entry) => entry.startsWith(`${WORKER_PID_ENV}=`))?.slice(WORKER_PID_ENV.length + 1);
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Everything precisely owned by a worker. A systemd scope is included only
 * when this process's own shim tagged it with a worker pid. Anything else
 * in the slice is left alone. */
export function sliceInventory(sliceDir: string, read: ProcReader = readProc, remembered?: { scopeDir: string; labels: ReadonlyMap<string, string> }, readEnv: (pid: number) => string | undefined = readProcessEnv): Inventory {
  let names: string[] = [];
  try { names = readdirSync(sliceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return { units: [], workers: [] }; }
  const units: Unit[] = [];
  const workers: number[] = [];
  for (const name of names) {
    const dir = join(sliceDir, name);
    if (!name.startsWith('clikcode-worker-')) continue;
    const divided = (() => { try { return statSync(join(dir, AGENT_GROUP)).isDirectory(); } catch { return false; } })();
    const agentPids = groupPids(divided ? join(dir, AGENT_GROUP) : dir);
    const worker = agentPids.find((pid) => isWorker(read(pid)?.command));
    if (worker === undefined) continue;
    workers.push(worker);
    if (!divided) continue;
    for (const group of readdirSync(dir).filter((child) => COMMAND_GROUP.test(child))) {
      const groupDir = join(dir, group);
      const infos = groupPids(groupDir).map(read).filter((entry): entry is ProcInfo => !!entry);
      const rootPid = Number(group.slice(4));
      const root = infos.find((entry) => entry.pid === rootPid) ?? read(rootPid);
      const saved = remembered && dir === remembered.scopeDir ? remembered.labels.get(group) : undefined;
      units.push({ kind: 'command', target: { cgroup: groupDir }, owner: worker, label: bestLabel(root, infos.filter((entry) => entry.pid !== rootPid), saved) || group, freeable: cgroupFreeable(groupDir) });
    }
  }
  for (const name of names) {
    if (!/^run-.*\.(scope|service)$/.test(name)) continue;
    const dir = join(sliceDir, name);
    const pids = groupPids(dir);
    const tagged = pids.map(readEnv).map((text) => text ? workerPidFromEnv(text) : undefined).find((pid): pid is number => pid !== undefined);
    if (tagged === undefined) continue;
    const infos = pids.map(read).filter((entry): entry is ProcInfo => !!entry);
    units.push({
      kind: 'command', target: { cgroup: dir }, ...(workers.includes(tagged) ? { owner: tagged } : {}),
      label: bestLabel(undefined, infos) || name, freeable: cgroupFreeable(dir),
    });
  }
  return { units, workers };
}

function readProcessEnv(pid: number): string | undefined {
  try { return readFileSync(join('/proc', String(pid), 'environ'), 'utf8'); } catch { return undefined; }
}

export function cgroupProbe(sliceDir: string, remembered?: { scopeDir: string; labels: ReadonlyMap<string, string> }): Probe {
  return {
    sample: () => sampleSlice(sliceDir),
    inventory: () => sliceInventory(sliceDir, readProc, remembered),
    stop: (target) => {
      if (!('cgroup' in target)) return false;
      try { writeFileSync(join(target.cgroup, 'cgroup.kill'), '1'); return true; } catch { return false; }
    },
  };
}

// --- Everywhere else: the process table ----------------------------------------

export interface TableEntry extends ProcInfo { bytes: number; startedAt?: string }

/** `ps -axo pid=,ppid=,rss=,ucomm=,args=` (macOS, Linux): rss in KiB. */
export function parsePs(output: string): TableEntry[] {
  const entries: TableEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), bytes: Number(match[3]) * 1024, exe: match[4]!.split('/').pop()!.toLowerCase(), command: match[5] ?? '' });
  }
  return entries;
}

/** Win32_Process as JSON: command lines can contain tabs and newlines. */
export function parseWindowsProcesses(output: string): TableEntry[] {
  try {
    const parsed: unknown = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row: unknown) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Record<string, unknown>;
      if (!Number.isInteger(item.ProcessId) || !Number.isInteger(item.ParentProcessId) || typeof item.Name !== 'string') return [];
      const startedAt = windowsStartedAt(item.CreationDate);
      return [{
        pid: Number(item.ProcessId), ppid: Number(item.ParentProcessId), bytes: Number(item.WorkingSetSize) || 0,
        exe: item.Name.toLowerCase().replace(/\.exe$/, ''), command: typeof item.CommandLine === 'string' ? item.CommandLine : '',
        ...(startedAt ? { startedAt } : {}),
      }];
    });
  } catch { return []; }
}

/** CIM dates are not JSON dates. Emit UTC ISO-8601, which Date.parse accepts. */
const WINDOWS_TABLE = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; WorkingSetSize=[int64]$_.WorkingSetSize; Name=$_.Name; CommandLine=$_.CommandLine; CreationDate=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString("o")}) } } | ConvertTo-Json -Compress -Depth 3';

/** PowerShell 5 emits `\/Date(ms)\/` unless the query formats the date itself. */
function windowsStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const wrapped = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (wrapped) {
    const parsed = new Date(Number(wrapped[1]));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export async function readProcessTable(platform: NodeJS.Platform = process.platform): Promise<TableEntry[]> {
  try {
    const command = platform === 'win32' ? 'powershell.exe' : 'ps';
    const args = platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE]
      : ['-axo', 'pid=,ppid=,rss=,ucomm=,args='];
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', timeout: platform === 'win32' ? 15_000 : 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return platform === 'win32' ? parseWindowsProcesses(stdout) : parsePs(stdout);
  } catch { return []; }
}

/** Each live worker's commands, sized by resident memory: a command is a shell
 * the worker's agent started, with every process below it. */
export function tableInventory(entries: readonly TableEntry[]): Inventory {
  const children = new Map<number, TableEntry[]>();
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  for (const entry of entries) {
    const parent = byPid.get(entry.ppid);
    // Windows can reuse a PID while a child still points at the old parent.
    // CreationDate makes that ambiguous relationship safe to exclude.
    if (parent?.startedAt && entry.startedAt && Date.parse(entry.startedAt) < Date.parse(parent.startedAt)) continue;
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  }
  const bytesOf = new Map(entries.map((entry) => [entry.pid, entry.bytes]));
  const units: Unit[] = [];
  const workers: number[] = [];
  for (const worker of entries.filter((entry) => isWorker(entry.command))) {
    workers.push(worker.pid);
    const tree: TableEntry[] = [];
    const stack = [...(children.get(worker.pid) ?? [])];
    while (stack.length) { const next = stack.pop()!; tree.push(next); stack.push(...(children.get(next.pid) ?? [])); }
    for (const command of findCommands(tree)) {
      units.push({
        kind: 'command', target: { pids: command.pids, root: command.root.pid, command: command.root.command,
          ...(entries.find((entry) => entry.pid === command.root.pid)?.startedAt
            ? { startedAt: entries.find((entry) => entry.pid === command.root.pid)!.startedAt } : {}) }, owner: worker.pid,
        label: commandLabel(command.root.command), freeable: command.pids.reduce((sum, pid) => sum + (bytesOf.get(pid) ?? 0), 0),
      });
    }
  }
  return { units, workers };
}

/** macOS: percent of memory still available, and whether the kernel calls pressure critical (4). */
export function parseVmStat(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/i.exec(output)?.[1]);
  if (!pageSize) return undefined;
  const pages = (name: string): number => Number(new RegExp(`^Pages ${name}:\\s*([\\d.]+)`, 'm').exec(output)?.[1]?.replace(/\./g, '') ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

async function macPressure(): Promise<{ availableBytes?: number; critical: boolean }> {
  let level = NaN, pressure = NaN;
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 5_000 });
    [level, pressure] = stdout.trim().split(/\s+/).map(Number);
  } catch { /* older macOS: use vm_stat below */ }
  if (Number.isFinite(level) && level >= 0 && level <= 100) return { availableBytes: totalmem() * level / 100, critical: pressure === 4 };
  try {
    const { stdout } = await execFileAsync('vm_stat', [], { encoding: 'utf8', timeout: 5_000 });
    const availableBytes = parseVmStat(stdout);
    return { ...(availableBytes === undefined ? {} : { availableBytes }), critical: pressure === 4 };
  } catch { return { critical: pressure === 4 }; }
}

export function processProbe(platform: NodeJS.Platform = process.platform, options: {
  readTable?: () => TableEntry[] | Promise<TableEntry[]>;
  readMemory?: () => MemorySample | undefined | Promise<MemorySample | undefined>;
  stopTree?: (target: Extract<StopTarget, { pids: number[] }>) => boolean | Promise<boolean>;
} = {}): Probe {
  const readTable = options.readTable ?? (() => readProcessTable(platform));
  return {
    sample: options.readMemory ?? (async () => {
      const total = totalmem();
      // macOS's free pages omit reclaimable inactive and purgeable pages.
      const mac = platform === 'darwin' ? await macPressure() : undefined;
      if (platform === 'darwin' && mac?.availableBytes === undefined) return undefined;
      const available = mac?.availableBytes ?? freemem();
      return { total, available, used: total - available, critical: mac?.critical ?? false };
    }),
    inventory: async () => tableInventory(await readTable()),
    stop: async (target) => {
      if (!('pids' in target)) return false;
      // The table is a snapshot. Recheck the root and its child IDs before
      // signalling, so a reused PID or a finished command is never stopped.
      const current = tableInventory(await readTable());
      const stillThere = current.units.find((unit) => 'pids' in unit.target
        && unit.target.root === target.root
        && unit.target.command === target.command
        && unit.target.startedAt === target.startedAt
        && unit.target.pids.length === target.pids.length
        && unit.target.pids.every((pid) => target.pids.includes(pid)));
      if (!stillThere) return false;
      if (options.stopTree) return options.stopTree(target);
      if (platform === 'win32') {
        try { await execFileAsync('taskkill', ['/PID', String(target.root), '/T', '/F'], { timeout: 10_000, windowsHide: true }); return true; } catch { return false; }
      }
      let stopped = false;
      for (const pid of target.pids) { try { process.kill(pid, 'SIGKILL'); stopped = true; } catch { /* fail-open-ok: it already exited */ } }
      return stopped;
    },
  };
}
