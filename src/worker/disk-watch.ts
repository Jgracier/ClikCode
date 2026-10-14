/** Tells an agent, in its own context, when the disk it works on is getting
 * full -- the way the memory guard (resource-guard.ts) tells it memory is.
 *
 * MEASURED 2026-10-14: this computer went from 841 to 856 GB used of 915 while
 * one conversation's build loop leaked Docker volumes; nobody, agent or
 * person, heard of it before the disk was 99% full and every agent's writes
 * were about to fail.
 *
 * Nothing here stops or removes anything: a full disk cannot be fixed by
 * killing a process the way memory can, and what fills it (volumes, caches,
 * build output) is not ClikCode's to delete. The agent is told, once per
 * crossing, how much is left and what is usually safe for it to free. The note
 * rides the same private channel as the memory notes (turn/resource-notes.ts):
 * steered into the running turn, or held for the next, never shown as the
 * user's message. Each worker watches independently and tells its own agent;
 * the disk cannot be attributed to one conversation, and once per crossing
 * keeps that from being noise.
 *
 * Works on every platform (fs.statfs). Watches the drive holding ClikCode's
 * state and the one holding the conversation's workspace -- often the same. */
import { existsSync, statfsSync, statSync } from 'node:fs';
import { lifecycle } from '../runtime/lifecycle-log.js';

const GIB = 2 ** 30;
const CHECK_MS = 30_000;
/** Back below a line only once this far clear of it, so a disk hovering at the line is not told twice. */
const CLEAR_MARGIN = 1.25;

export interface DiskReading { path: string; device: string; total: number; free: number }
export type DiskLevel = 'ok' | 'tight' | 'critical';

/** Free space under which the disk is "getting tight": 10% of it, never under 20 GB. */
export const tightBelow = (total: number): number => Math.max(20 * GIB, total * 0.1);
/** Free space under which it is nearly full: 3% of it, never under 5 GB. */
export const criticalBelow = (total: number): number => Math.max(5 * GIB, total * 0.03);

const severity: Record<DiskLevel, number> = { ok: 0, tight: 1, critical: 2 };

export function nextLevel(previous: DiskLevel, reading: DiskReading): DiskLevel {
  const critical = reading.free < criticalBelow(reading.total);
  const tight = reading.free < tightBelow(reading.total);
  let level: DiskLevel = critical ? 'critical' : tight ? 'tight' : 'ok';
  if (previous === 'critical' && level !== 'critical' && reading.free < criticalBelow(reading.total) * CLEAR_MARGIN) level = 'critical';
  if (previous !== 'ok' && level === 'ok' && reading.free < tightBelow(reading.total) * CLEAR_MARGIN) level = 'tight';
  return level;
}

const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

export function diskNote(level: 'tight' | 'critical', reading: DiskReading, hasDocker: boolean): string {
  const used = Math.round((1 - reading.free / reading.total) * 100);
  const where = `${gb(reading.free)} free of ${gb(reading.total)} (${used}% used) on the drive holding ${reading.path}`;
  const docker = hasDocker ? ' and remove containers you started with `docker rm -fv` so their volumes go too' : '';
  return level === 'critical'
    ? `Disk is almost full: ${where}. Stop writing large files now and free space first -- build output, caches and temp files you created${docker}. Writes will start failing, for every agent on this machine.`
    : `Disk is getting tight: ${where}. Before starting more large builds, downloads or image pulls, free space: delete build output, caches and temp files you created${docker}.`;
}

export function readDisk(path: string): DiskReading | undefined {
  try {
    const stat = statfsSync(path);
    const size = Number(stat.bsize);
    return { path, device: String(statSync(path).dev), total: size * Number(stat.blocks), free: size * Number(stat.bavail) };
  } catch { return undefined; }
}

export interface DiskWatchOptions {
  sessionId: string;
  paths: readonly (string | undefined)[];
  deliver: (note: string) => void;
  read?: (path: string) => DiskReading | undefined;
  hasDocker?: boolean;
  intervalMs?: number;
}

export function startDiskWatch(options: DiskWatchOptions): () => void {
  const read = options.read ?? readDisk;
  const hasDocker = options.hasDocker ?? (process.platform !== 'win32' && existsSync('/var/run/docker.sock'));
  const paths = [...new Set(options.paths.filter((path): path is string => !!path))];
  const levels = new Map<string, DiskLevel>();
  const tick = (): void => {
    const seen = new Set<string>();
    for (const path of paths) {
      const reading = read(path);
      if (!reading || seen.has(reading.device) || reading.total <= 0) continue;
      seen.add(reading.device);
      const previous = levels.get(reading.device) ?? 'ok';
      const level = nextLevel(previous, reading);
      levels.set(reading.device, level);
      if (severity[level] <= severity[previous] || level === 'ok') continue;
      lifecycle('disk.nudge', { session: options.sessionId, level, path: reading.path, free: reading.free, total: reading.total });
      options.deliver(diskNote(level, reading, hasDocker));
    }
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
