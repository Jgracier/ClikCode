/** Every ClikCode cgroup on this machine, read from the cgroup tree: worker scopes (session, memory, tasks, cpu, age, who
 * owns them), the browser host's unit, and the command groups inside. Flags a command past its lifetime, a hot one past it, and a
 * scope whose worker no longer lives. Behind `clikcode doctor scopes`, which can end only what is flagged (--reap).
 *
 * Why it exists: 2026-10-31 a worker scope of an older generation held 16.6 GB and 3,217 tasks and a 38 h `awk` loop sat in its
 * `cmd-` group, and nothing listed or supervised either. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cgroupFacts, isKept, killCgroup, realReaders, type CgroupFacts, type CgroupReaders } from './cgroup-inspect.js';
import { COMMAND_GROUP } from './command-groups.js';
import { commandMaxMs, hours } from './command-lifetime.js';

export type ScopeKind = 'worker' | 'browser-host' | 'other';

export interface CommandRow {
  group: string;
  dir: string;
  facts: CgroupFacts;
  cpuPercent?: number;
  /** Why it is flagged, or undefined. */
  flag?: 'over its lifetime' | 'hot past its lifetime';
}

export interface ScopeRow {
  unit: string;
  dir: string;
  kind: ScopeKind;
  sessionId?: string;
  workerPid?: number;
  /** The chat's name, when known. */
  owner?: string;
  facts: CgroupFacts;
  cpuPercent?: number;
  workerAlive?: boolean;
  /** No live worker owns it, yet it holds processes. */
  orphaned: boolean;
  commands: CommandRow[];
}

export function parseScopeName(unit: string): { kind: ScopeKind; sessionId?: string; workerPid?: number } {
  const worker = /^clikcode-worker-(.+)-(\d+)\.scope$/.exec(unit);
  if (worker) return { kind: 'worker', sessionId: worker[1]!, workerPid: Number(worker[2]) };
  if (/^clikcode-browser-host[^/]*\.(?:scope|service)$/.test(unit)) return { kind: 'browser-host' };
  return { kind: 'other' };
}

/** Every pid in `dir` and below it. */
export function treePids(dir: string, read: CgroupReaders, list: (dir: string) => string[] = listDirectories): number[] {
  return [...read.pids(dir), ...list(dir).flatMap((child) => treePids(join(dir, child), read, list))];
}

export function listDirectories(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
}

export interface ScanOptions {
  now?: number;
  maxMs?: number;
  read?: CgroupReaders;
  list?: (dir: string) => string[];
  /** Waits between the two cpu samples. */
  pause?: () => Promise<void>;
  /** A chat's name by session id. */
  names?: ReadonlyMap<string, string>;
  /** A command group counts as hot above this share of one core. */
  hotPercent?: number;
}

function withTree(dir: string, read: CgroupReaders, list: (dir: string) => string[], now: number): CgroupFacts {
  const own = cgroupFacts(dir, now, read);
  // A scope's own processes are few; its age and size are those of everything below it too.
  const pids = treePids(dir, read, list);
  const starts = pids.map((pid) => read.startedAt(pid)).filter((value): value is number => value !== undefined);
  const keep = pids.some((pid) => isKept(read.commandLine(pid)));
  return { ...own, pids: pids.length, keep, ...(starts.length ? { ageMs: now - Math.min(...starts) } : {}) };
}

/** Reads the slice twice, `pause` apart, for cpu. */
export async function scanSlice(sliceDir: string, options: ScanOptions = {}): Promise<ScopeRow[]> {
  const read = options.read ?? realReaders;
  const list = options.list ?? listDirectories;
  const maxMs = options.maxMs ?? commandMaxMs();
  const hot = options.hotPercent ?? 50;
  const take = (now: number): ScopeRow[] => list(sliceDir).filter((name) => /\.(?:scope|service)$/.test(name)).map((unit): ScopeRow => {
    const dir = join(sliceDir, unit);
    const parsed = parseScopeName(unit);
    const facts = withTree(dir, read, list, now);
    const workerAlive = parsed.workerPid !== undefined ? (read.commandLine(parsed.workerPid) ?? '').includes('session-worker') : undefined;
    const commands = list(dir).filter((name) => COMMAND_GROUP.test(name)).map((group): CommandRow => {
      const groupDir = join(dir, group);
      return { group, dir: groupDir, facts: withTree(groupDir, read, list, now) };
    });
    return {
      unit, dir, ...parsed, facts, commands,
      ...(parsed.sessionId && options.names?.get(parsed.sessionId) ? { owner: options.names.get(parsed.sessionId)! } : {}),
      ...(workerAlive !== undefined ? { workerAlive } : {}),
      orphaned: parsed.kind === 'worker' && workerAlive === false && facts.pids > 0,
    };
  });
  const startedAt = options.now ?? Date.now();
  const first = take(startedAt);
  await (options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000))))();
  const endedAt = options.now !== undefined ? options.now + 1_000 : Date.now();
  const second = take(endedAt);
  const percent = (before: CgroupFacts, after: CgroupFacts): number | undefined =>
    before.cpuUsec !== undefined && after.cpuUsec !== undefined && endedAt > startedAt ? Math.max(0, ((after.cpuUsec - before.cpuUsec) / 1_000) / (endedAt - startedAt) * 100) : undefined;
  return second.map((row) => {
    const before = first.find((item) => item.unit === row.unit);
    const cpuPercent = before ? percent(before.facts, row.facts) : undefined;
    return {
      ...row, ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      commands: row.commands.map((command) => {
        const earlier = before?.commands.find((item) => item.group === command.group);
        const cpu = earlier ? percent(earlier.facts, command.facts) : undefined;
        const over = !command.facts.keep && command.facts.ageMs !== undefined && command.facts.ageMs >= maxMs;
        const flag = over ? ((cpu ?? 0) > hot ? 'hot past its lifetime' as const : 'over its lifetime' as const) : undefined;
        return { ...command, ...(cpu !== undefined ? { cpuPercent: cpu } : {}), ...(flag ? { flag } : {}) };
      }),
    };
  });
}

const gb = (bytes: number | undefined): string => (bytes === undefined ? '-' : bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}G` : `${Math.round(bytes / 2 ** 20)}M`);
const cpu = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value)}%`);

/** The cgroups `--reap` would end: flagged commands, and a whole scope whose worker has ended and whose oldest process is past
 * the lifetime (a younger orphan may be background work left running on purpose; it is listed, not ended). Never what is kept. */
export function reapTargets(rows: readonly ScopeRow[], maxMs: number = commandMaxMs()): { dir: string; why: string; label: string }[] {
  const targets: { dir: string; why: string; label: string }[] = [];
  for (const row of rows) {
    if (row.orphaned && !row.facts.keep && (row.facts.ageMs ?? 0) >= maxMs) { targets.push({ dir: row.dir, why: 'its worker ended and it has run past the lifetime', label: row.unit }); continue; }
    for (const command of row.commands) if (command.flag) targets.push({ dir: command.dir, why: command.flag, label: `${row.unit}/${command.group}` });
  }
  return targets;
}

export function renderScopeReport(rows: readonly ScopeRow[], maxMs: number = commandMaxMs()): string {
  if (!rows.length) return 'No ClikCode scope is running.';
  const lines: string[] = [];
  for (const row of [...rows].sort((a, b) => (b.facts.memoryBytes ?? 0) - (a.facts.memoryBytes ?? 0))) {
    const who = row.kind === 'worker' ? `session ${row.sessionId!.slice(0, 8)}${row.owner ? ` "${row.owner}"` : ''}, worker ${row.workerPid} ${row.workerAlive ? 'alive' : 'GONE'}` : row.kind === 'browser-host' ? 'browser host' : '';
    lines.push(`${row.unit}${row.orphaned ? '  [ORPHANED: no live worker]' : ''}`);
    lines.push(`  ${who ? `${who} · ` : ''}mem ${gb(row.facts.memoryBytes)} · tasks ${row.facts.tasks ?? row.facts.pids} · cpu ${cpu(row.cpuPercent)} · age ${row.facts.ageMs !== undefined ? hours(row.facts.ageMs) : '-'}`);
    for (const command of [...row.commands].sort((a, b) => (b.facts.ageMs ?? 0) - (a.facts.ageMs ?? 0)).slice(0, 8)) {
      const text = (command.facts.command ?? '').replace(/\s+/g, ' ').slice(0, 70);
      lines.push(`  ${command.flag ? '! ' : '  '}${command.group} · age ${command.facts.ageMs !== undefined ? hours(command.facts.ageMs) : '-'} · cpu ${cpu(command.cpuPercent)} · mem ${gb(command.facts.memoryBytes)} · ${command.facts.keep ? 'keep · ' : ''}${text}${command.flag ? `  [${command.flag}, limit ${hours(maxMs)}]` : ''}`);
    }
    if (row.commands.length > 8) lines.push(`    ... and ${row.commands.length - 8} more commands`);
  }
  return lines.join('\n');
}

/** Ends the targets by cgroup.kill, after the caller printed them. Returns those that were ended. */
export function reap(targets: readonly { dir: string; label: string }[], kill: (dir: string) => boolean = killCgroup): string[] {
  return targets.filter((target) => kill(target.dir)).map((target) => target.label);
}
