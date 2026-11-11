/** The supervisor of one local model's llama-server, as its own process:
 * `node dist/local-model-supervisor.cjs <config.json>` (bundled on its own by
 * scripts/build.mjs, started by lifecycle.ts startSupervisor).
 *
 * Idle is judged from llama-server's /slots: each request gets a new task
 * id, so a changed id or a busy slot means work happened since the last
 * look, even between polls.
 *
 * Memory is sampled every few seconds (Linux: /proc; macOS: vm_stat and
 * ps; Windows: the OS's available figure only). Each sample goes through
 * memoryStep, which may restart the server smaller or stop it. Once the
 * server answers, its peak RssAnon and RssFile are recorded per
 * configuration, which is what later fit checks use in place of the
 * estimate. Nothing is judged while the server loads: its memory is still
 * climbing, and the start's own fit check covered it. */
import cp, { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { memoryStep, mergeFootprint, parseMeminfo, parseMemoryPressure, parseProcStatus, parseVmStatMac, parseVmstatSwapOut, type MemorySample, type WatchState } from './memwatch.js';
import type { MemoryEvent, ShrinkStep, SupervisorConfig } from './lifecycle.js';
import { pidIsAlive } from '../session/store/locks.js';

const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as SupervisorConfig;
const memory = config.memory;
const leases = path.join(config.dir, 'leases');
const recordFile = path.join(config.dir, 'supervisor.json');
const WINDOWS = process.platform === 'win32';
const note = (text: string): void => {
  try { fs.appendFileSync(path.join(config.dir, 'supervisor.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* fail-open-ok: the log is the only record there is; the supervisor goes on without it */ }
};
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

function liveLeases(): number {
  let names: string[];
  try { names = fs.readdirSync(leases); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (pidIsAlive(Number(name.split('-')[0]))) count++;
    else { try { fs.rmSync(path.join(leases, name), { force: true }); } catch { /* fail-open-ok: a lease that cannot be removed is looked at again next tick */ } }
  }
  return count;
}

// Lowered before the server starts, so it inherits the priority on POSIX
// and on Windows (a below-normal parent's children are below-normal); set
// on the child as well in case the platform does not pass it on.
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fail-open-ok: a platform that refuses runs it at normal priority */ }

// The server's log and this supervisor's own are kept to LOG_LIMIT each: the
// older half moves to <name>.1 (replacing the one before). llama-server
// holds server.log open, appending, so it is copied aside and truncated in
// place rather than renamed out from under it.
const LOG_LIMIT = 5 * 1024 * 1024;
const serverLog = path.join(config.dir, 'server.log');
const supervisorLog = path.join(config.dir, 'supervisor.log');
function rotateLogs(fd?: number): void {
  try {
    if (fd === undefined) { if (fs.statSync(serverLog).size > LOG_LIMIT) fs.renameSync(serverLog, `${serverLog}.1`); }
    else if (fs.fstatSync(fd).size > LOG_LIMIT) { fs.copyFileSync(serverLog, `${serverLog}.1`); fs.ftruncateSync(fd, 0); }
  } catch { /* fail-open-ok: no log yet, or it cannot be moved; it is tried again next check */ }
  try { if (fs.statSync(supervisorLog).size > LOG_LIMIT) fs.renameSync(supervisorLog, `${supervisorLog}.1`); } catch { /* fail-open-ok: as above */ }
}
rotateLogs();
const log = fs.openSync(serverLog, 'a');
setInterval(() => rotateLogs(log), config.logCheckMs || 60_000).unref();

const record: {
  supervisorPid: number; serverPid: number; port: number; modelId: string; alias: string; context: number; startedAt: string;
  restarting?: boolean; memoryEvent?: MemoryEvent;
} = {
  supervisorPid: process.pid, serverPid: 0, port: config.port, modelId: config.modelId,
  alias: config.alias, context: config.context, startedAt: new Date().toISOString(),
};
const writeRecord = (): void => fs.writeFileSync(recordFile, JSON.stringify(record));
let child: ChildProcess | undefined;
let stopping = false;
let restartArgs: string[] | null = null;

function launch(args: string[]): void {
  const self = cp.spawn(config.command, args, {
    cwd: config.dir, env: { ...process.env, ...config.env }, stdio: ['ignore', log, log], windowsHide: true,
  });
  child = self;
  try { if (self.pid !== undefined) os.setPriority(self.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fail-open-ok: it may have inherited the priority already */ }
  record.serverPid = self.pid ?? 0;
  delete record.restarting;
  writeRecord();
  note(`started llama-server pid ${self.pid} on port ${config.port} at ${Math.round(record.context / 1024)}K context`);
  self.on('exit', (code, signal) => {
    if (self !== child || stopping) return;
    if (restartArgs) { const next = restartArgs; restartArgs = null; launch(next); return; }
    stopping = true;
    finish(`llama-server exited (${code !== null ? code : signal})`);
  });
  self.on('error', (error) => {
    if (self !== child || stopping) return;
    stopping = true;
    finish(`llama-server could not start: ${error.message}`);
  });
}

function killChild(target: ChildProcess): void {
  if (WINDOWS) cp.spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true });
  else { try { target.kill('SIGTERM'); } catch { /* fail-open-ok: already gone */ } }
}

function finish(reason: string): never {
  writeFootprint();
  note(`stopped: ${reason}`);
  try {
    const current = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as { supervisorPid?: number };
    if (current.supervisorPid === process.pid) fs.rmSync(recordFile, { force: true });
  } catch { /* fail-open-ok: no record, or another supervisor's: nothing of this one's to remove */ }
  process.exit(0);
}

function stop(reason: string): void {
  if (stopping) return;
  stopping = true;
  const running = child!;
  if (running.exitCode !== null || running.signalCode !== null) finish(reason);
  killChild(running);
  const deadline = Date.now() + 10_000;
  const wait = setInterval(() => {
    if (running.exitCode !== null || running.signalCode !== null || !pidIsAlive(running.pid ?? 0)) { clearInterval(wait); finish(reason); }
    else if (Date.now() > deadline) { try { running.kill('SIGKILL'); } catch { /* fail-open-ok: gone between the check and the kill */ } }
  }, 200);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  try { process.on(signal, () => stop(`signal ${signal}`)); } catch { /* fail-open-ok: a platform without the signal cannot send it either */ }
}

type Slot = { id?: number; id_task?: number; is_processing?: boolean };
function slots(): Promise<Slot[] | undefined> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: config.port, path: '/slots', timeout: 5000 }, (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => { text += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(text) as Slot[]); } catch { resolve(undefined); } });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
  });
}

// ---- memory ----------------------------------------------------------------
let current: Omit<ShrinkStep, 'args'> | null = memory ? memory.current : null;
let shrinks: ShrinkStep[] = memory ? memory.shrinks : [];
let watch: WatchState = {};
let healthy = false, busy = false;
let baseline: number | null = null;
let lastLog = '', lastStatusAt = 0;
let peak = { anon: 0, file: 0 }, written = 0;
const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

function sampleMemory(pid: number): MemorySample | undefined {
  const at = Date.now();
  if (process.platform === 'linux') {
    const mem = parseMeminfo(read('/proc/meminfo'));
    if (!mem.totalBytes || mem.availableBytes === undefined) return undefined;
    const own = parseProcStatus(read(`/proc/${pid}/status`));
    const swapOutPages = parseVmstatSwapOut(read('/proc/vmstat'));
    const pressureSomeAvg10 = parseMemoryPressure(read('/proc/pressure/memory'));
    return {
      at, totalBytes: mem.totalBytes, availableBytes: mem.availableBytes, ourAnonBytes: own.anonBytes, ourFileBytes: memory!.mmap ? own.fileBytes : 0,
      ...(swapOutPages === undefined ? {} : { swapOutPages }), ...(pressureSomeAvg10 === undefined ? {} : { pressureSomeAvg10 }),
    };
  }
  if (process.platform === 'darwin') {
    let vm: ReturnType<typeof parseVmStatMac> = {};
    let rss = 0;
    try { vm = parseVmStatMac(cp.execFileSync('vm_stat', { encoding: 'utf8', timeout: 3000 })); } catch { /* fail-open-ok: no reading this time; the sample is skipped below */ }
    try { rss = Number(cp.execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim()) * 1024 || 0; } catch { /* fail-open-ok: the server's own use reads as 0 this sample */ }
    if (vm.availableBytes === undefined) return undefined;
    // Metal keeps the weights in allocations, not a file mapping, so RSS
    // is all the model's own and none of it is page cache.
    return {
      at, totalBytes: os.totalmem(), availableBytes: vm.availableBytes, ourAnonBytes: rss, ourFileBytes: 0,
      ...(vm.swapOutPages === undefined ? {} : { swapOutPages: vm.swapOutPages }),
    };
  }
  // Windows: os.freemem() is the available figure (free plus standby);
  // the server's own use is not sampled, so no footprint is recorded.
  return { at, totalBytes: os.totalmem(), availableBytes: os.freemem(), ourAnonBytes: 0, ourFileBytes: 0 };
}

function writeFootprint(): void {
  if (!memory || !current || !(peak.anon > 0)) return;
  if (peak.anon + peak.file <= written) return;
  try {
    let store: Record<string, Record<string, Parameters<typeof mergeFootprint>[1]>> = {};
    try { store = JSON.parse(fs.readFileSync(memory.footprintsFile, 'utf8')) as typeof store; } catch { /* fail-open-ok: the first footprint on this machine */ }
    const machine = store[memory.machine] ?? (store[memory.machine] = {});
    machine[current.footprintKey] = mergeFootprint(machine[current.footprintKey], {
      context: current.context, cacheType: memory.cacheType, parallel: memory.parallel, vision: memory.vision,
      anonBytes: peak.anon, fileBytes: peak.file, mmap: Boolean(memory.mmap), at: new Date().toISOString(),
    });
    // Synchronous: finish() writes this on its way to process.exit.
    const temporary = `${memory.footprintsFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, memory.footprintsFile);
    written = peak.anon + peak.file;
  } catch (error) { note(`footprint not recorded: ${(error as Error).message}`); }
}

function shrinkTo(option: ShrinkStep, reason: string | undefined): void {
  writeFootprint();
  const event: MemoryEvent = { at: new Date().toISOString(), action: 'shrink', modelId: config.modelId, fromContext: record.context, toContext: option.context, reason: reason! };
  current = option;
  healthy = false; baseline = null; peak = { anon: 0, file: 0 }; written = 0;
  restartArgs = option.args;
  record.context = option.context;
  record.restarting = true;
  record.memoryEvent = event;
  writeRecord();
  note(`restarting llama-server at ${Math.round(option.context / 1024)}K context, prompt cache ${option.cacheRamMib} MiB`);
  const target = child!;
  killChild(target);
  setTimeout(() => { if (target === child && pidIsAlive(target.pid ?? 0)) { try { target.kill('SIGKILL'); } catch { /* fail-open-ok: gone between the check and the kill */ } } }, 10_000);
}

function memoryTick(): void {
  if (stopping || restartArgs || !memory || !child || !current) return;
  const sample = sampleMemory(child.pid ?? 0);
  if (!sample) return;
  if (!healthy) return;
  if (baseline === null) baseline = sample.ourAnonBytes;
  peak = { anon: Math.max(peak.anon, sample.ourAnonBytes), file: Math.max(peak.file, sample.ourFileBytes) };
  // Rewritten when the peak has grown by 64 MiB: small enough to track a
  // prompt cache filling, large enough not to write every sample.
  if (peak.anon + peak.file > written + 64 * 1024 * 1024) writeFootprint();
  const growth = Math.max(0, sample.ourAnonBytes - baseline);
  const now = current;
  const options = shrinks.map((option) => ({
    context: option.context,
    freesBytes: Math.max(0, now.kvBytes - option.kvBytes) + (now.cacheRamMib > option.cacheRamMib ? growth : 0),
  }));
  const decision = memoryStep({ sample, state: watch, bufferBytes: memory.bufferBytes, busy, shrinks: options });
  watch = decision.state;
  const summary = `memory ${decision.level}: ${gb(decision.spareBytes)} spare (buffer ${gb(memory.bufferBytes)}), others hold `
    + `${gb(decision.othersBytes)}, model ${gb(sample.ourAnonBytes)}${memory.mmap ? ` own + ${gb(sample.ourFileBytes)} mapped weights` : ''}`
    + (sample.pressureSomeAvg10 ? `, memory stalls ${sample.pressureSomeAvg10.toFixed(1)}%` : '')
    + (decision.swapOutPerSecond ? `, swapping out ${Math.round(decision.swapOutPerSecond)} pages/s` : '');
  const key = `${decision.level} ${decision.action}`;
  if (key !== lastLog || decision.action === 'shrink' || decision.action === 'stop' || sample.at - lastStatusAt > 300_000) {
    note(summary + (decision.action !== 'none' ? ` -> ${decision.action}${decision.reason ? `: ${decision.reason}` : ''}` : ''));
    lastLog = key; lastStatusAt = sample.at;
  }
  if (decision.action === 'shrink') {
    const option = shrinks[decision.shrinkIndex!]!;
    shrinks = shrinks.slice(decision.shrinkIndex! + 1);
    shrinkTo(option, decision.reason);
  } else if (decision.action === 'stop') {
    const event: MemoryEvent = { at: new Date().toISOString(), action: 'stop', modelId: config.modelId, fromContext: record.context, reason: decision.reason! };
    try { fs.writeFileSync(path.join(config.dir, 'memory-stop.json'), JSON.stringify(event)); } catch (error) { note(`memory stop not recorded: ${(error as Error).message}`); }
    stop(`to leave memory for other programs: ${decision.reason}`);
  }
}

// How long the server outlives its last lease: a ClikCode run that starts
// right after another one joins it, instead of loading the model again
// beside a copy that is still shutting down.
const LEASE_GRACE_MS = config.leaseGraceMs || 10_000;
let lastActive = Date.now(), lastSignature = '';
let leaselessSince: number | undefined;
async function tick(): Promise<void> {
  if (stopping) return;
  if (liveLeases() === 0) {
    leaselessSince ??= Date.now();
    if (Date.now() - leaselessSince >= LEASE_GRACE_MS) { stop('no live ClikCode process holds a lease'); return; }
  } else leaselessSince = undefined;
  if (restartArgs) { lastActive = Date.now(); return; }
  const list = await slots();
  if (Array.isArray(list)) {
    if (!healthy) {
      healthy = true;
      // A restart is judged from when its server answers, not from when it
      // was decided: loading takes seconds to a minute.
      if (watch.lastActionAt !== undefined) watch.lastActionAt = Date.now();
    }
    busy = list.some((slot) => slot.is_processing);
    const signature = JSON.stringify(list.map((slot) => [slot.id, slot.id_task, slot.is_processing]));
    if (signature !== lastSignature || busy) lastActive = Date.now();
    lastSignature = signature;
  } else {
    // Still loading, or busy enough not to answer: not idle.
    lastActive = Date.now();
  }
  if (config.idleMs > 0 && Date.now() - lastActive > config.idleMs) stop(`idle for ${Math.round(config.idleMs / 1000)} s`);
}

launch(config.args);
setInterval(() => { tick().catch((error: Error) => note(`tick failed: ${error.message}`)); }, config.pollMs);
if (memory) setInterval(() => { try { memoryTick(); } catch (error) { note(`memory check failed: ${(error as Error).message}`); } }, memory.sampleMs);
