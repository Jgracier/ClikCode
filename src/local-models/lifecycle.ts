/** Who keeps a model server alive, and for how long.
 *
 * A server runs under a small detached supervisor (a Node process started
 * from this one's own executable with an inline script, so it needs no file
 * of its own and survives bundling). The supervisor starts llama-server and
 * stops it when either
 *  - no lease names a live ClikCode process, or
 *  - no request has arrived for the idle period.
 * Leases are files, one per ClikCode process and session, so no two
 * writers share one. A lease whose process is gone -- a closed terminal, a
 * crash, kill -9 -- is dropped by the supervisor, which is what makes "the
 * model stops when ClikCode does" hold even when ClikCode never got to say
 * so. SIGTERM, SIGINT and SIGHUP to the supervisor stop the server on the
 * way out. If the supervisor itself is killed outright its server is
 * orphaned; the next start for that model finds it by its record and stops
 * it (sweepOrphan). */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeName, serversDir } from './paths.js';
import { pidIsAlive, tryLease, type Lease } from '../session/store/locks.js';
import { sleep } from '../runtime/sleep.js';

/** The command line of a process, to tell a live llama-server from a
 * recycled pid before stopping it. */
function commandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      readFile(`/proc/${pid}/cmdline`).then((buffer) => resolve(buffer.toString().replace(/\0/g, ' ')), () => resolve(''));
      return;
    }
    const [command, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
      : ['ps', ['-o', 'command=', '-p', String(pid)]];
    execFile(command, args as string[], { timeout: 10_000, windowsHide: true }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

export function serverDir(modelId: string): string { return join(serversDir(), safeName(modelId)); }
function leasesDir(modelId: string): string { return join(serverDir(modelId), 'leases'); }

/** Lease files, one per process and session: `<pid>-<session>.json` in a
 * directory of their holder's choosing (a model's server). A turn's own is
 * `<pid>-turn-<session>.json`: the process RUNNING a turn holds the server for
 * that turn and not a moment longer, apart from whoever shows the chat. */
function leaseFile(directory: string, sessionId: string, turn = false): string {
  return join(directory, `${process.pid}-${turn ? 'turn-' : ''}${safeName(sessionId)}.json`);
}

/** A lease taken for one running turn (see leaseFile). */
const isTurnLease = (name: string): boolean => /^\d+-turn-/.test(name);

async function writeLeaseFile(directory: string, sessionId: string, turn = false): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(leaseFile(directory, sessionId, turn), JSON.stringify({ pid: process.pid, session: sessionId, ...(turn ? { turn: true } : {}), at: new Date().toISOString() }));
}

/** Whether a live process holds a lease in `directory` -- for this session
 * only, when one is named; other than this process, when `elsewhere`. Asked
 * about a session, a turn's lease does not count: it says the turn is using
 * the server, not that anyone is showing the chat. */
async function leaseHeld(directory: string, options: { sessionId?: string; elsewhere?: boolean } = {}): Promise<boolean> {
  const suffix = options.sessionId === undefined ? '' : `-${safeName(options.sessionId)}.json`;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.endsWith(suffix)) continue;
    if (options.sessionId !== undefined && isTurnLease(name)) continue;
    const pid = Number(name.slice(0, name.indexOf('-')));
    if (!(options.elsewhere && pid === process.pid) && pidIsAlive(pid)) return true;
  }
  return false;
}

/** This process's leases in one directory, removed synchronously -- for an
 * exit handler, where nothing asynchronous runs. */
function removeOwnLeasesSync(directory: string): void {
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) if (name.startsWith(`${process.pid}-`)) rmSync(join(directory, name), { force: true });
}

/** This process's hold on a model's server for one session. */
export async function writeLease(modelId: string, sessionId: string): Promise<void> {
  await writeLeaseFile(leasesDir(modelId), sessionId);
}

/** This process's hold on a model's server for one running turn. The worker
 * that runs a turn takes it itself and gives it back when the turn ends: the
 * window that sent the turn holds the model only for the chat it shows, so
 * a window leaving the chat mid-turn used to take the server out from under
 * the request (found live 2026-10-28: left a chat during a 27B turn, and the
 * supervisor stopped the model 22 s later, "no live ClikCode process holds a
 * lease"). */
export async function writeTurnLease(modelId: string, sessionId: string): Promise<void> {
  await writeLeaseFile(leasesDir(modelId), sessionId, true);
}

/** Whether a live process other than this one holds this session's lease on
 * a model. The interactive terminal takes the lease before handing a turn to
 * its worker; the worker, which outlives the terminal, then joins without
 * one, so the model stops when the terminal does and not when the worker
 * eventually exits. */
export async function sessionHeldElsewhere(modelId: string, sessionId: string): Promise<boolean> {
  return leaseHeld(leasesDir(modelId), { sessionId, elsewhere: true });
}

/** Whether any live process holds a lease on a model. A server nobody
 * holds is only outliving its last lease (LEASE_GRACE_MS) and will stop. */
export async function heldByLiveProcess(modelId: string): Promise<boolean> {
  return leaseHeld(leasesDir(modelId));
}

/** Drop this process's leases for a session, on every model, except the
 * one named in `keep` (a session that moved to another model keeps only
 * its new one). */
export async function removeLeases(sessionId: string, keep?: string): Promise<void> {
  for (const model of await readdir(serversDir()).catch(() => [] as string[])) {
    if (model === (keep && safeName(keep))) continue;
    await rm(leaseFile(join(serversDir(), model, 'leases'), sessionId), { force: true });
  }
}

/** This process's turn leases for a session, on every model but `keep`. */
export async function removeTurnLeases(sessionId: string, keep?: string): Promise<void> {
  for (const model of await readdir(serversDir()).catch(() => [] as string[])) {
    if (model === (keep && safeName(keep))) continue;
    await rm(leaseFile(join(serversDir(), model, 'leases'), sessionId, true), { force: true });
  }
}

/** Every lease this process holds, removed synchronously -- for an exit
 * handler, where nothing asynchronous runs. */
export function removeAllOwnLeasesSync(): void {
  let models: string[] = [];
  try { models = readdirSync(serversDir()); } catch { return; }
  for (const model of models) removeOwnLeasesSync(join(serversDir(), model, 'leases'));
}

export interface ServerRecord {
  supervisorPid: number;
  serverPid: number;
  port: number;
  modelId: string;
  alias: string;
  context: number;
  startedAt: string;
  /** The supervisor is restarting the server (serverPid is the old one). */
  restarting?: boolean;
  /** The last time it gave memory back by restarting smaller. */
  memoryEvent?: MemoryEvent;
}

export async function readServerRecord(modelId: string): Promise<ServerRecord | undefined> {
  try { return JSON.parse(await readFile(join(serverDir(modelId), 'supervisor.json'), 'utf8')) as ServerRecord; } catch { return undefined; }
}

/** A server whose supervisor is gone (killed outright) but which is still
 * running: stopped, if it still is a llama-server, so a recycled pid is
 * left alone. */
export async function sweepOrphan(modelId: string): Promise<void> {
  const record = await readServerRecord(modelId);
  if (!record || pidIsAlive(record.supervisorPid)) return;
  if (pidIsAlive(record.serverPid) && /llama-server/.test(await commandLine(record.serverPid))) {
    await killTree(record.serverPid);
  }
  await rm(join(serverDir(modelId), 'supervisor.json'), { force: true });
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let waited = 0; waited < 10_000 && pidIsAlive(pid); waited += 250) await sleep(250);
  if (pidIsAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* fail-open-ok: Already gone. */ } }
}

/** Holds `lock` (a lease, locks.ts) while `work` runs, waiting for it while another holder has it. The lease is created with its
 * owner already in it and kept fresh while held, so a holder killed at any moment leaves a lock judged stale (its pid gone, or no
 * longer refreshed) rather than an empty file, and two waiters never both break the same stale lock. */
async function withModelLock<T>(lock: string, work: () => Promise<T>, waiting: { timeoutMs?: number; timedOut?: string; signal?: AbortSignal }): Promise<T> {
  const started = Date.now();
  let lease: Lease | undefined;
  for (;;) {
    if (waiting.signal?.aborted) throw new Error('The download was cancelled.');
    lease = await tryLease(lock);
    if (lease) break;
    if (waiting.timeoutMs !== undefined && Date.now() - started > waiting.timeoutMs) throw new Error(waiting.timedOut ?? 'Timed out waiting for a lock.');
    await sleep(500);
  }
  try { return await work(); } finally { await lease.release(); }
}

/** One start at a time per model, across processes: two sessions asking
 * for the same model at once would otherwise start two servers. A holder
 * that is gone loses it; a waiter gives up after the longest a start takes. */
export async function withStartLock<T>(modelId: string, work: () => Promise<T>, timeoutMs = 20 * 60_000): Promise<T> {
  await mkdir(serverDir(modelId), { recursive: true });
  return withModelLock(join(serverDir(modelId), 'start.lock'), work, { timeoutMs, timedOut: `Timed out waiting for another ClikCode process to start ${modelId}.` });
}

/** One download at a time per model, across processes: two windows fetching the same weights would append to one `.part` file
 * from two places. No time limit -- a download of several GB takes as long as the link does -- so only a holder that is gone
 * loses it. Waiting is cancellable. */
export async function withDownloadLock<T>(modelId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await mkdir(serverDir(modelId), { recursive: true });
  return withModelLock(join(serverDir(modelId), 'download.lock'), work, { ...(signal ? { signal } : {}) });
}

/** A configuration the server can be restarted in to give memory back. */
export interface ShrinkStep {
  context: number;
  /** Estimated KV cache and recurrent state at this context. */
  kvBytes: number;
  cacheRamMib: number;
  args: string[];
  footprintKey: string;
}

interface MemoryWatchConfig {
  /** Spare memory (see memwatch.ts) kept for other programs. */
  bufferBytes: number;
  sampleMs: number;
  /** Where measured footprints go, and under which machine key. */
  footprintsFile: string;
  machine: string;
  cacheType: string;
  parallel: number;
  vision: boolean;
  /** The server maps its weights (see usesMmap): only then are its
   * resident file pages its own. */
  mmap: boolean;
  /** What runs at start. */
  current: Omit<ShrinkStep, 'args'>;
  /** Least drastic first. */
  shrinks: ShrinkStep[];
}

export interface SupervisorConfig {
  modelId: string;
  alias: string;
  context: number;
  port: number;
  command: string;
  args: string[];
  /** Library search path additions for the server. */
  env: Record<string, string>;
  dir: string;
  /** Stop after this long with no request; 0 keeps it while leased. */
  idleMs: number;
  pollMs: number;
  /** How often the logs' size is checked; tests only. */
  logCheckMs?: number;
  /** How long the server outlives its last lease (default 10 s); a test shortens it. */
  leaseGraceMs?: number;
  /** Watch the machine's memory while the model runs. */
  memory?: MemoryWatchConfig;
}

/** Why the supervisor last gave memory back, kept in the server's record
 * (a restart) or beside it (a stop, which removes the record), so the next
 * ensureLocalModel can tell the user. */
export interface MemoryEvent {
  at: string;
  action: 'shrink' | 'stop';
  modelId: string;
  fromContext: number;
  toContext?: number;
  reason: string;
}

export function memoryStopFile(modelId: string): string { return join(serverDir(modelId), 'memory-stop.json'); }

/** The supervisor's own bundle (src/local-models/supervisor.ts, built by
 * scripts/build.mjs): beside this code in dist/, or -- run from source -- the
 * build's. CLIKCODE_SUPERVISOR_ENTRY names another (a test's own build). */
function supervisorEntry(): string {
  const candidates = [
    process.env.CLIKCODE_SUPERVISOR_ENTRY,
    fileURLToPath(new URL('./local-model-supervisor.cjs', import.meta.url)),
    fileURLToPath(new URL('../../dist/local-model-supervisor.cjs', import.meta.url)),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('The local model supervisor is not built (dist/local-model-supervisor.cjs); run the build.');
  return found;
}

/** Start the supervisor for one model, detached so it outlives nothing
 * it is not told to: it watches the leases, and a ClikCode exit is what
 * ends a lease. Resolves once it has recorded the server it started. */
export async function startSupervisor(config: SupervisorConfig): Promise<ServerRecord> {
  await mkdir(config.dir, { recursive: true });
  await rm(join(config.dir, 'supervisor.json'), { force: true });
  const configFile = join(config.dir, 'supervisor-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [supervisorEntry(), configFile], {
    cwd: config.dir, detached: true, stdio: 'ignore', windowsHide: true,
    // Whatever flags started ClikCode (a loader, an inspector) are not the
    // supervisor's.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  child.unref();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const record = await readServerRecord(config.modelId);
    if (record && record.supervisorPid === child.pid) return record;
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`The local model supervisor did not start. See ${join(config.dir, 'supervisor.log')}.`);
}

/** Stop a model's server now, whoever holds it. */
export async function stopServer(modelId: string): Promise<void> {
  const record = await readServerRecord(modelId);
  if (!record) return;
  if (pidIsAlive(record.supervisorPid)) {
    if (process.platform === 'win32') {
      // Windows has no SIGTERM to hand the supervisor, so its server is
      // stopped first and the supervisor then finds it gone.
      await killTree(record.serverPid);
    }
    try { process.kill(record.supervisorPid, 'SIGTERM'); } catch { /* fail-open-ok: Gone already. */ }
    for (let waited = 0; waited < 15_000 && pidIsAlive(record.supervisorPid); waited += 250) await sleep(250);
  }
  await sweepOrphan(modelId);
}
