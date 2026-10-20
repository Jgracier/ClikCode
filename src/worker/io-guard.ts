/** React to sustained disk I/O stalls caused by a command this worker owns.
 * Linux cgroup I/O counters identify the issuer; pressure alone identifies
 * victims too, so it must never be used as the reason to kill a process. */
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { safeRecordFileName, stateDirectory } from '../session/store/paths.js';
import { COMMAND_GROUP } from './command-groups.js';

const MIB = 2 ** 20;
const TICK_MS = 5_000;
const WARN_PRESSURE = 5;
const STOP_PRESSURE = 15;
const CLEAR_PRESSURE = 2;
const MIN_BYTES_PER_SECOND = 16 * MIB;
const MIN_IOPS = 1_000;
const MIN_MACHINE_SHARE = 0.5;
const STOP_AFTER_MS = 20_000;
const STOP_COOLDOWN_MS = 60_000;
const SETTLE_MS = 30_000;
const GLOBAL_WARN_COOLDOWN_MS = 60 * 60_000;
const OWNED_WARN_COOLDOWN_MS = 30 * 60_000;

export type IoCounters = Map<string, { bytes: number; operations: number }>;
export function parseIoStat(value: string): IoCounters {
  const result: IoCounters = new Map();
  for (const line of value.split('\n')) {
    const [device, ...fields] = line.trim().split(/\s+/);
    if (!/^\d+:\d+$/.test(device ?? '')) continue;
    const numbers = new Map(fields.map((field) => field.split('=') as [string, string]));
    const number = (key: string): number => Number(numbers.get(key) ?? 0);
    const bytes = number('rbytes') + number('wbytes');
    const operations = number('rios') + number('wios');
    if (Number.isFinite(bytes) && Number.isFinite(operations)) result.set(device!, { bytes, operations });
  }
  return result;
}

export function ioDelta(before: IoCounters, after: IoCounters): IoCounters {
  const result: IoCounters = new Map();
  for (const [device, current] of after) {
    const previous = before.get(device);
    if (!previous || current.bytes < previous.bytes || current.operations < previous.operations) continue;
    result.set(device, { bytes: current.bytes - previous.bytes, operations: current.operations - previous.operations });
  }
  return result;
}

export function ioPressure(text: string): number | undefined {
  const value = Number(/^full\s+avg10=([\d.]+)/m.exec(text)?.[1]);
  return Number.isFinite(value) ? value : undefined;
}
export function ioSomePressure(text: string): number | undefined {
  const value = Number(/^some\s+avg10=([\d.]+)/m.exec(text)?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

export interface CommandReading { path: string; label: string; identity: string; counters: IoCounters; stalled: number }
export interface Reading { pressure: number; machine: IoCounters; commands: CommandReading[]; at: number }
export interface Candidate { command: CommandReading; device: string; bytesPerSecond: number; operationsPerSecond: number; machineShare: number }

/** Require an owned command to account for most physical I/O on its device.
 * This prevents killing a command that is only waiting on an external Docker
 * build. New groups need two samples before they can be selected. */
export function ioCandidate(previous: Reading, current: Reading): Candidate | undefined {
  const seconds = (current.at - previous.at) / 1_000;
  if (seconds < 1 || seconds > 30) return undefined;
  const machine = ioDelta(previous.machine, current.machine);
  let best: Candidate | undefined;
  for (const command of current.commands) {
    if (command.stalled < WARN_PRESSURE) continue;
    const old = previous.commands.find((entry) => entry.path === command.path && entry.identity === command.identity);
    if (!old) continue;
    for (const [device, activity] of ioDelta(old.counters, command.counters)) {
      const total = machine.get(device);
      if (!total || total.bytes <= 0 || activity.bytes > total.bytes) continue;
      const candidate = {
        command, device,
        bytesPerSecond: activity.bytes / seconds,
        operationsPerSecond: activity.operations / seconds,
        machineShare: activity.bytes / total.bytes,
      };
      if ((candidate.bytesPerSecond >= MIN_BYTES_PER_SECOND || candidate.operationsPerSecond >= MIN_IOPS)
        && candidate.machineShare >= MIN_MACHINE_SHARE
        && (!best || candidate.bytesPerSecond > best.bytesPerSecond)) best = candidate;
    }
  }
  return best;
}

const physicalDevices = new Map<string, boolean>();
function isPhysicalDevice(device: string): boolean {
  const cached = physicalDevices.get(device);
  if (cached !== undefined) return cached;
  let physical = false;
  try { physical = !realpathSync(join('/sys/dev/block', device)).includes('/virtual/'); } catch { /* missing device */ }
  physicalDevices.set(device, physical);
  return physical;
}

function readCounters(path: string): IoCounters | undefined {
  try {
    const counters = parseIoStat(readFileSync(path, 'utf8'));
    for (const device of counters.keys()) {
      // zram and loop devices are not the physical drive whose stalled I/O
      // can freeze the desktop. zram belongs to memory pressure instead.
      if (!isPhysicalDevice(device)) counters.delete(device);
    }
    return counters;
  } catch { return undefined; }
}

/** Whole-device sectors, including Docker and every other cgroup. */
export function parseDiskstats(text: string): IoCounters {
  const result: IoCounters = new Map();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^\d+$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[1] ?? '')) continue;
    const bytes = (Number(fields[5]) + Number(fields[9])) * 512;
    const operations = Number(fields[3]) + Number(fields[7]);
    if (Number.isFinite(bytes) && Number.isFinite(operations)) result.set(`${fields[0]}:${fields[1]}`, { bytes, operations });
  }
  return result;
}

function readReading(scopeDir: string, labels: ReadonlyMap<string, string>, now: number): Reading | undefined {
  try {
    const pressure = ioPressure(readFileSync('/proc/pressure/io', 'utf8'));
    const machine = parseDiskstats(readFileSync('/proc/diskstats', 'utf8'));
    if (pressure === undefined || !machine) return undefined;
    const commands: CommandReading[] = [];
    for (const name of readdirSync(scopeDir).filter((name) => COMMAND_GROUP.test(name))) {
      const path = join(scopeDir, name);
      try {
        const counters = readCounters(join(path, 'io.stat'));
        if (!counters) continue;
        const stalled = ioSomePressure(readFileSync(join(path, 'io.pressure'), 'utf8'));
        if (stalled === undefined) continue;
        const stat = statSync(path);
        commands.push({ path, label: labels.get(name) || name, identity: `${stat.dev}:${stat.ino}`, counters, stalled });
      } catch { /* a command exited during the sweep */ }
    }
    return { pressure, machine, commands, at: now };
  } catch { return undefined; }
}

const gbps = (bytesPerSecond: number): string => `${(bytesPerSecond / MIB).toFixed(0)} MiB/s`;
export function ioNudge(candidate: Candidate, pressure: number): string {
  return `Disk I/O is stalling the machine (${pressure.toFixed(0)}% full stall time). Your \`${candidate.command.label}\` is issuing about ${gbps(candidate.bytesPerSecond)} on the busy device. Continue the task with less disk I/O: reduce this command's parallel jobs, narrow its targets, or reuse existing build output where appropriate. Suggest the specific change you can make; do not pause solely because of this warning.`;
}
export function ioGlobalNudge(pressure: number): string {
  return `Disk I/O is stalling the machine (${pressure.toFixed(0)}% full stall time). ClikCode has not identified a command in this conversation as the cause. This is informational: continue the user's task. If your next step would add substantial disk I/O, choose a narrower run or fewer parallel jobs when practical. Suggest a concrete change only if it fits your work; do not pause or stop solely because of this warning.`;
}
export function ioStopNote(candidate: Candidate, pressure: number): string {
  return `ClikCode stopped \`${candidate.command.label}\` and its child processes after sustained disk I/O stalls (${pressure.toFixed(0)}% full stall time). It was issuing about ${gbps(candidate.bytesPerSecond)} and over half of the device's I/O. Use fewer parallel jobs or a smaller run; do not rerun the same command unchanged.`;
}

interface IoGuardOptions {
  sessionId: string;
  scopeDir: string;
  labels: ReadonlyMap<string, string>;
  deliver: (note: string) => void;
  read?: (now: number) => Reading | undefined;
  stop?: (path: string) => boolean;
  now?: () => number;
  intervalMs?: number;
}

function lastStopPath(): string { return join(stateDirectory(), 'io-guard.last-stop'); }
function ineffectivePath(): string { return join(stateDirectory(), 'io-guard.ineffective'); }
function warningPath(sessionId: string, kind: 'global' | 'owned'): string {
  return join(stateDirectory(), 'io-guard-warnings', `${safeRecordFileName(sessionId)}.${kind}`);
}
function fileTime(path: string): number { try { return Number(readFileSync(path, 'utf8')) || 0; } catch { return 0; } }
function warningDue(sessionId: string, kind: 'global' | 'owned', at: number): boolean {
  const path = warningPath(sessionId, kind);
  const last = fileTime(path);
  const cooldown = kind === 'global' ? GLOBAL_WARN_COOLDOWN_MS : OWNED_WARN_COOLDOWN_MS;
  if (last > 0 && at >= last && at - last < cooldown) return false;
  try { mkdirSync(join(stateDirectory(), 'io-guard-warnings'), { recursive: true, mode: 0o700 }); writeFileSync(path, String(at), { mode: 0o600 }); } catch { /* fail-open-ok */ }
  return true;
}

export function startIoGuard(options: IoGuardOptions): () => void {
  const now = options.now ?? Date.now;
  const read = options.read ?? ((at: number) => readReading(options.scopeDir, options.labels, at));
  const stop = options.stop ?? ((path: string) => { try { writeFileSync(join(path, 'cgroup.kill'), '1'); return true; } catch { return false; } });
  let previous: Reading | undefined;
  let highSince: number | undefined;
  let candidateSince: number | undefined;
  let candidatePath: string | undefined;
  let pending: { pressure: number; at: number } | undefined;
  const tick = (): void => {
    const current = read(now());
    if (!current) { previous = undefined; highSince = undefined; candidateSince = undefined; candidatePath = undefined; return; }
    if (pending && current.at - pending.at >= SETTLE_MS) {
      const improved = current.pressure < CLEAR_PRESSURE || current.pressure <= pending.pressure / 2;
      lifecycle('io.effect', { session: options.sessionId, before: pending.pressure, after: current.pressure, improved });
      if (!improved) { try { mkdirSync(stateDirectory(), { recursive: true }); writeFileSync(ineffectivePath(), String(current.at)); } catch { /* fail-open-ok */ } }
      pending = undefined;
    }
    if (current.pressure < CLEAR_PRESSURE) {
      highSince = undefined;
      try { rmSync(ineffectivePath(), { force: true }); } catch { /* fail-open-ok */ }
    }
    if (current.pressure >= STOP_PRESSURE) highSince ??= current.at;
    else highSince = undefined;
    const hadBaseline = !!previous;
    const candidate = previous ? ioCandidate(previous, current) : undefined;
    previous = current;
    if (!hadBaseline) return;
    if (candidate && candidate.command.path === candidatePath) candidateSince ??= current.at;
    else { candidatePath = candidate?.command.path; candidateSince = candidate ? current.at : undefined; }
    if (current.pressure < WARN_PRESSURE) return;
    if (candidate && warningDue(options.sessionId, 'owned', current.at)) {
      lifecycle('io.nudge', { session: options.sessionId, label: candidate.command.label, pressure: current.pressure, bytesPerSecond: candidate.bytesPerSecond });
      options.deliver(ioNudge(candidate, current.pressure));
    } else if (!candidate && warningDue(options.sessionId, 'global', current.at)) {
      lifecycle('io.nudge', { session: options.sessionId, pressure: current.pressure });
      options.deliver(ioGlobalNudge(current.pressure));
    }
    if (!candidate) return;
    const lastStop = fileTime(lastStopPath());
    if (highSince === undefined || current.at - highSince < STOP_AFTER_MS
      || candidateSince === undefined || current.at - candidateSince < STOP_AFTER_MS || pending
      || (lastStop > 0 && current.at - lastStop < STOP_COOLDOWN_MS) || fileTime(ineffectivePath())) return;
    // A group can disappear or be replaced between readings. Its identity
    // must still match before the kernel receives cgroup.kill.
    let identity: string;
    try {
      const stat = statSync(candidate.command.path);
      identity = `${stat.dev}:${stat.ino}`;
      if (!readFileSync(join(candidate.command.path, 'cgroup.procs'), 'utf8').trim()) return;
    } catch { return; }
    if (identity !== candidate.command.identity || !stop(candidate.command.path)) return;
    try { mkdirSync(stateDirectory(), { recursive: true }); writeFileSync(lastStopPath(), String(current.at)); } catch { /* fail-open-ok */ }
    pending = { pressure: current.pressure, at: current.at };
    lifecycle('io.stop', { session: options.sessionId, label: candidate.command.label, pressure: current.pressure, bytesPerSecond: candidate.bytesPerSecond, machineShare: candidate.machineShare });
    options.deliver(ioStopNote(candidate, current.pressure));
  };
  const timer = setInterval(() => { try { tick(); } catch (error) { lifecycle('io.error', { session: options.sessionId, message: error instanceof Error ? error.message : String(error) }); } }, options.intervalMs ?? TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
