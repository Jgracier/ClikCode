/** Tells an agent when a service it started has been sitting idle for a long
 * time, holding memory nobody is using.
 *
 * MEASURED 2026-10-14: a `next dev` an agent started with `systemd-run --user`
 * ran 28 hours after its task ended, no connection to it, no file changed
 * beside it, holding 6.6 GB of the agents' 48 GB budget. The memory guard
 * (resource-guard.ts) deals with commands that are too large or run too long;
 * a service started on purpose to outlive its command is neither, until its
 * task is over and nobody stops it.
 *
 * Nothing is stopped here. A service looks abandoned from the outside but may
 * be wanted, so the agent that started it hears of it once, with the command
 * to stop it, and decides. Only services this worker's own agent started are
 * reported (the `systemd-run` shim stamps them with the worker's pid,
 * own-scope.ts), so one conversation never speaks about another's. Linux with
 * a delegated cgroup slice only; elsewhere there is nothing to look at. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { WORKER_PID_ENV } from './own-scope.js';

const GIB = 2 ** 30;
const HOUR_MS = 60 * 60 * 1000;
const MIN_AGE_MS = 12 * HOUR_MS;
/** How long the CPU is watched before a service can be called idle. */
const WATCH_MS = 30 * 60 * 1000;
/** Mean CPU, as a share of one core, under which a service is idle. */
const IDLE_CPU = 0.01;
/** Not worth a note below this. */
const MIN_HELD = 256 * 2 ** 20;
const CHECK_MS = 10 * 60 * 1000;
const CLOCK_TICKS = 100;

export interface ServiceReading { unit: string; owner: number | undefined; ageMs: number; held: number; cpuUsec: number }

export interface Watched { cpuUsec: number; at: number }

/** Idle: old enough, big enough, and used almost no CPU over the whole watch. */
export function isIdle(reading: ServiceReading, since: Watched | undefined, now: number): boolean {
  if (reading.ageMs < MIN_AGE_MS || reading.held < MIN_HELD || !since || now - since.at < WATCH_MS) return false;
  const used = (reading.cpuUsec - since.cpuUsec) / 1000;
  return used / (now - since.at) < IDLE_CPU;
}

export function idleServiceNote(reading: ServiceReading): string {
  const hours = Math.floor(reading.ageMs / HOUR_MS);
  return `The service ${reading.unit} that you started ${hours} hours ago has used almost no CPU for the last half hour and holds ${(reading.held / GIB).toFixed(1)} GB of the memory agents share. If your task is done with it, stop it: \`systemctl --user stop ${reading.unit}\`. If it is still needed, ignore this; you will not be told again.`;
}

const fileText = (path: string): string | undefined => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

function ownerOf(pids: readonly string[]): number | undefined {
  for (const pid of pids) {
    const env = fileText(`/proc/${pid}/environ`);
    const found = env?.split('\0').find((entry) => entry.startsWith(`${WORKER_PID_ENV}=`));
    if (found) return Number(found.slice(WORKER_PID_ENV.length + 1)) || undefined;
  }
  return undefined;
}

function ageOf(pid: string, now: number): number | undefined {
  const stat = fileText(`/proc/${pid}/stat`);
  const boot = /^btime (\d+)/m.exec(fileText('/proc/stat') ?? '');
  if (!stat || !boot) return undefined;
  const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  return Number.isFinite(start) ? now - (Number(boot[1]) * 1000 + (start / CLOCK_TICKS) * 1000) : undefined;
}

function readServices(sliceDir: string, now: number): ServiceReading[] {
  const readings: ServiceReading[] = [];
  let names: string[];
  try { names = readdirSync(sliceDir).filter((name) => name.endsWith('.service')); } catch { return readings; }
  for (const unit of names) {
    const dir = join(sliceDir, unit);
    const pids = (fileText(join(dir, 'cgroup.procs')) ?? '').split('\n').filter(Boolean);
    if (!pids.length) continue;
    const ageMs = ageOf(pids[0]!, now);
    const held = Number(fileText(join(dir, 'memory.current')));
    const cpu = /^usage_usec (\d+)/m.exec(fileText(join(dir, 'cpu.stat')) ?? '');
    if (ageMs === undefined || !Number.isFinite(held) || !cpu) continue;
    readings.push({ unit, owner: ownerOf(pids), ageMs, held, cpuUsec: Number(cpu[1]) });
  }
  return readings;
}

interface IdleServicesOptions {
  sessionId: string;
  sliceDir: string;
  deliver: (note: string) => void;
  read?: (sliceDir: string, now: number) => ServiceReading[];
  now?: () => number;
  intervalMs?: number;
}

export function startIdleServices(options: IdleServicesOptions): () => void {
  const read = options.read ?? readServices;
  const clock = options.now ?? Date.now;
  const watched = new Map<string, Watched>();
  const told = new Set<string>();
  const tick = (): void => {
    const now = clock();
    const live = new Set<string>();
    for (const reading of read(options.sliceDir, now)) {
      live.add(reading.unit);
      if (reading.owner !== process.pid) continue;
      const since = watched.get(reading.unit);
      if (!since) { watched.set(reading.unit, { cpuUsec: reading.cpuUsec, at: now }); continue; }
      if (!told.has(reading.unit) && isIdle(reading, since, now)) {
        told.add(reading.unit);
        lifecycle('service.idle', { session: options.sessionId, unit: reading.unit, held: reading.held, ageMs: reading.ageMs });
        options.deliver(idleServiceNote(reading));
      }
      // Busy again: start the watch over, so only a continuous quiet counts.
      if (now - since.at >= WATCH_MS) watched.set(reading.unit, { cpuUsec: reading.cpuUsec, at: now });
    }
    for (const unit of [...watched.keys()]) if (!live.has(unit)) { watched.delete(unit); told.delete(unit); }
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
