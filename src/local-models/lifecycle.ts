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
import { closeSync, openSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeName, serversDir } from './paths.js';

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The command line of a process, to tell a live llama-server from a
 * recycled pid before stopping it. */
export function commandLine(pid: number): Promise<string> {
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
function leaseName(pid: number, sessionId: string): string { return `${pid}-${safeName(sessionId)}.json`; }

/** This process's hold on a model's server for one session. */
export async function writeLease(modelId: string, sessionId: string): Promise<void> {
  await mkdir(leasesDir(modelId), { recursive: true });
  await writeFile(join(leasesDir(modelId), leaseName(process.pid, sessionId)),
    JSON.stringify({ pid: process.pid, session: sessionId, at: new Date().toISOString() }));
}

/** Whether a live process other than this one holds this session's lease on
 * a model. The interactive terminal takes the lease before handing a turn to
 * its worker; the worker, which outlives the terminal, then joins without
 * one, so the model stops when the terminal does and not when the worker
 * eventually exits. */
export async function sessionHeldElsewhere(modelId: string, sessionId: string): Promise<boolean> {
  const suffix = `-${safeName(sessionId)}.json`;
  for (const name of await readdir(leasesDir(modelId)).catch(() => [] as string[])) {
    if (!name.endsWith(suffix)) continue;
    const pid = Number(name.slice(0, name.indexOf('-')));
    if (pid !== process.pid && processAlive(pid)) return true;
  }
  return false;
}

/** Drop this process's leases for a session, on every model, except the
 * one named in `keep` (a session that moved to another model keeps only
 * its new one). */
export async function removeLeases(sessionId: string, keep?: string): Promise<void> {
  const name = leaseName(process.pid, sessionId);
  for (const model of await readdir(serversDir()).catch(() => [] as string[])) {
    if (model === (keep && safeName(keep))) continue;
    await rm(join(serversDir(), model, 'leases', name), { force: true });
  }
}

/** Every lease this process holds, removed synchronously -- for an exit
 * handler, where nothing asynchronous runs. */
export function removeAllOwnLeasesSync(): void {
  let models: string[] = [];
  try { models = readdirSync(serversDir()); } catch { return; }
  for (const model of models) {
    const directory = join(serversDir(), model, 'leases');
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) if (name.startsWith(`${process.pid}-`)) rmSync(join(directory, name), { force: true });
  }
}

export interface ServerRecord {
  supervisorPid: number;
  serverPid: number;
  port: number;
  modelId: string;
  alias: string;
  context: number;
  startedAt: string;
}

export async function readServerRecord(modelId: string): Promise<ServerRecord | undefined> {
  try { return JSON.parse(await readFile(join(serverDir(modelId), 'supervisor.json'), 'utf8')) as ServerRecord; } catch { return undefined; }
}

/** A server whose supervisor is gone (killed outright) but which is still
 * running: stopped, if it still is a llama-server, so a recycled pid is
 * left alone. */
export async function sweepOrphan(modelId: string): Promise<void> {
  const record = await readServerRecord(modelId);
  if (!record || processAlive(record.supervisorPid)) return;
  if (processAlive(record.serverPid) && /llama-server/.test(await commandLine(record.serverPid))) {
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
  for (let waited = 0; waited < 10_000 && processAlive(pid); waited += 250) await new Promise((done) => setTimeout(done, 250));
  if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
}

/** One start at a time per model, across processes: two sessions asking
 * for the same model at once would otherwise start two servers. The lock
 * is a file created exclusively; one left by a dead process, or older than
 * the longest a start takes, is broken. */
export async function withStartLock<T>(modelId: string, work: () => Promise<T>, timeoutMs = 20 * 60_000): Promise<T> {
  const lock = join(serverDir(modelId), 'start.lock');
  await mkdir(serverDir(modelId), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await readFile(lock, 'utf8').then((text) => JSON.parse(text) as { pid?: number; at?: number }, () => undefined);
      const age = Date.now() - ((await stat(lock).catch(() => undefined))?.mtimeMs ?? 0);
      // An empty lock is one being written this instant; give it a moment.
      const stale = holder ? !processAlive(Number(holder.pid)) || age > timeoutMs : age > 5000;
      if (stale) { await rm(lock, { force: true }); continue; }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for another ClikCode process to start ${modelId}.`);
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  try { return await work(); } finally { await rm(lock, { force: true }); }
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
}

/** The supervisor, run as `node -e SUPERVISOR_SCRIPT <config.json>`.
 * Plain CommonJS JavaScript with no imports from ClikCode, so the bundler
 * never has to know about it. Idle is judged from llama-server's /slots:
 * each request gets a new task id, so a changed id or a busy slot means
 * work happened since the last look, even between polls. */
export const SUPERVISOR_SCRIPT = String.raw`
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), cp = require('child_process');
const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const leases = path.join(config.dir, 'leases');
const recordFile = path.join(config.dir, 'supervisor.json');
const WINDOWS = process.platform === 'win32';
const note = (text) => { try { fs.appendFileSync(path.join(config.dir, 'supervisor.log'), new Date().toISOString() + ' ' + text + '\n'); } catch {} };
const alive = (pid) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function liveLeases() {
  let names = [];
  try { names = fs.readdirSync(leases); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (alive(Number(name.split('-')[0]))) count++;
    else { try { fs.rmSync(path.join(leases, name), { force: true }); } catch {} }
  }
  return count;
}
// Lowered before the server starts, so it inherits the priority on POSIX
// and on Windows (a below-normal parent's children are below-normal); set
// on the child as well in case the platform does not pass it on.
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const log = fs.openSync(path.join(config.dir, 'server.log'), 'a');
const child = cp.spawn(config.command, config.args, {
  cwd: config.dir, env: Object.assign({}, process.env, config.env), stdio: ['ignore', log, log], windowsHide: true,
});
try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
fs.writeFileSync(recordFile, JSON.stringify({
  supervisorPid: process.pid, serverPid: child.pid, port: config.port, modelId: config.modelId,
  alias: config.alias, context: config.context, startedAt: new Date().toISOString(),
}));
note('started llama-server pid ' + child.pid + ' on port ' + config.port);
let stopping = false;
function finish(reason) {
  note('stopped: ' + reason);
  try {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (record.supervisorPid === process.pid) fs.rmSync(recordFile, { force: true });
  } catch {}
  process.exit(0);
}
function stop(reason) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode !== null || child.signalCode !== null) return finish(reason);
  if (WINDOWS) cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { child.kill('SIGTERM'); } catch {} }
  const deadline = Date.now() + 10000;
  const wait = setInterval(() => {
    if (child.exitCode !== null || child.signalCode !== null || !alive(child.pid)) { clearInterval(wait); finish(reason); }
    else if (Date.now() > deadline) { try { child.kill('SIGKILL'); } catch {} }
  }, 200);
}
child.on('exit', (code, signal) => { if (!stopping) { stopping = true; finish('llama-server exited (' + (code !== null ? code : signal) + ')'); } });
child.on('error', (error) => { if (!stopping) { stopping = true; finish('llama-server could not start: ' + error.message); } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) { try { process.on(signal, () => stop('signal ' + signal)); } catch {} }
function slots() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: config.port, path: '/slots', timeout: 5000 }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(undefined); } });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
  });
}
let lastActive = Date.now(), lastSignature = '';
async function tick() {
  if (stopping) return;
  if (liveLeases() === 0) return stop('no live ClikCode process holds a lease');
  if (!(config.idleMs > 0)) return;
  const list = await slots();
  if (Array.isArray(list)) {
    const signature = JSON.stringify(list.map((slot) => [slot.id, slot.id_task, slot.is_processing]));
    if (signature !== lastSignature || list.some((slot) => slot.is_processing)) lastActive = Date.now();
    lastSignature = signature;
  } else {
    // Still loading, or busy enough not to answer: not idle.
    lastActive = Date.now();
  }
  if (Date.now() - lastActive > config.idleMs) stop('idle for ' + Math.round(config.idleMs / 1000) + ' s');
}
setInterval(() => { tick().catch((error) => note('tick failed: ' + error.message)); }, config.pollMs);
`;

/** Start the supervisor for one model, detached so it outlives nothing
 * it is not told to: it watches the leases, and a ClikCode exit is what
 * ends a lease. Resolves once it has recorded the server it started. */
export async function startSupervisor(config: SupervisorConfig): Promise<ServerRecord> {
  await mkdir(config.dir, { recursive: true });
  await rm(join(config.dir, 'supervisor.json'), { force: true });
  const configFile = join(config.dir, 'supervisor-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, ['-e', SUPERVISOR_SCRIPT, configFile], {
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
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`The local model supervisor did not start. See ${join(config.dir, 'supervisor.log')}.`);
}

/** Stop a model's server now, whoever holds it. */
export async function stopServer(modelId: string): Promise<void> {
  const record = await readServerRecord(modelId);
  if (!record) return;
  if (processAlive(record.supervisorPid)) {
    if (process.platform === 'win32') {
      // Windows has no SIGTERM to hand the supervisor, so its server is
      // stopped first and the supervisor then finds it gone.
      await killTree(record.serverPid);
    }
    try { process.kill(record.supervisorPid, 'SIGTERM'); } catch { /* Gone already. */ }
    for (let waited = 0; waited < 15_000 && processAlive(record.supervisorPid); waited += 250) await new Promise((done) => setTimeout(done, 250));
  }
  await sweepOrphan(modelId);
}
