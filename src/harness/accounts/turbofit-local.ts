/** Running a TurboFit local model for a Hermes session: everything between
 * "the user picked a TurboFit model" and "Hermes can talk to it".
 *
 * TurboFit's own code does the work -- its selector, its downloader (SHA-256
 * pinned Hugging Face files), its native-runtime builder, its controller and
 * gateway. ClikCode supplies what TurboFit assumes is already there (a
 * Python with its few dependencies, cmake), shows progress, and owns the
 * processes for exactly as long as a session uses them. Nothing here is
 * specific to one operating system: the processes are ordinary children of a
 * small supervisor, not systemd, launchd or Windows services. */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { nodeHttp } from '../../runtime/lazy-node.js';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { binaryOnPath } from '../transport/native/binary.js';
import {
  discoverHermesTurboFitRecommendations, hermesInstallDirectory, selectHermesTurboFitRecommendation, turboFitPluginRoot,
} from './hermes-discovery.js';
import {
  TURBOFIT_CPU_LANES_SCRIPT, TURBOFIT_CPU_LANE_SELECT_SCRIPT, TURBOFIT_CPU_TUNE_SCRIPT, TURBOFIT_PLAN_SCRIPT, TURBOFIT_SUPERVISOR_SCRIPT,
} from './turbofit-scripts.js';

/** Hermes model ids that run on TurboFit's local gateway. */
export function isTurboFitModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(?:custom:)?turbofit:/.test(model));
}

type Progress = (message: string) => void;
type Environment = Readonly<Record<string, string>>;

const WINDOWS = process.platform === 'win32';
const GATEWAY = { host: '127.0.0.1', port: 8091 };

// TurboFit keeps all of its state under the user's home on every platform
// (Path.home()), so ClikCode's additions sit beside it.
function turboFitHome(environment: Environment): string { return environment.HOME || process.env.HOME || homedir(); }
function stateDir(environment: Environment): string { return join(turboFitHome(environment), '.local', 'state', 'turbofit'); }
function toolsDir(environment: Environment): string { return join(turboFitHome(environment), '.local', 'share', 'turbofit', 'clikcode-tools'); }
function venvBin(venv: string): string { return join(venv, WINDOWS ? 'Scripts' : 'bin'); }
function venvPython(venv: string): string { return join(venvBin(venv), WINDOWS ? 'python.exe' : 'python'); }

interface RunResult { code: number; output: string }

/** Run a command, reporting each output line as it arrives. */
function run(
  command: string, args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let partial = '';
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output = (output + text).slice(-64 * 1024);
      partial += text;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) options.onLine?.(line);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    child.once('error', (error) => { if (timer) clearTimeout(timer); resolve({ code: 1, output: `${output}${error.message}` }); });
    child.once('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

function tail(output: string, lines = 8): string {
  return output.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join('\n');
}

async function hermesInstall(harness: AiLocalHarnessDefinition, environment: Environment): Promise<string> {
  const install = hermesInstallDirectory(await captureNativeHarnessOutput(harness, ['--version'], environment, 30_000));
  if (!install) throw new Error('Could not locate the Hermes Python environment');
  return install;
}

async function hermesPython(harness: AiLocalHarnessDefinition, environment: Environment): Promise<string> {
  return join(await hermesInstall(harness, environment), 'venv', WINDOWS ? 'Scripts/python.exe' : 'bin/python');
}

/** Packages TurboFit's runtime scripts import beyond the standard library
 * (huggingface_hub, PyYAML), plus the build tools its native runtime needs.
 * Hermes' own environment has neither and no pip, so TurboFit's setup could
 * not download a model from inside Hermes; this environment is made from
 * Hermes' Python, which exists wherever Hermes does. */
const TOOLS_REQUIREMENTS = ['huggingface_hub>=0.24,<2', 'PyYAML>=6,<7', 'cmake>=3.28,<5', 'ninja>=1.11,<2'];
const TOOLS_STAMP = TOOLS_REQUIREMENTS.join(' ');

async function ensureTools(harness: AiLocalHarnessDefinition, environment: Environment, progress: Progress): Promise<string> {
  const venv = toolsDir(environment);
  const python = venvPython(venv);
  const stampFile = join(venv, 'clikcode-requirements.txt');
  if (existsSync(python) && await readFile(stampFile, 'utf8').catch(() => '') === TOOLS_STAMP) return python;
  progress('preparing TurboFit tools…');
  if (!existsSync(python)) {
    const created = await run(await hermesPython(harness, environment), ['-m', 'venv', venv], { timeoutMs: 300_000 });
    if (created.code !== 0) throw new Error(`Could not create TurboFit's tools environment.\n${tail(created.output)}`);
  }
  const installed = await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...TOOLS_REQUIREMENTS], { timeoutMs: 900_000 });
  if (installed.code !== 0) throw new Error(`Could not install TurboFit's Python dependencies.\n${tail(installed.output)}`);
  await writeFile(stampFile, TOOLS_STAMP);
  return python;
}

/** Two fixes to TurboFit's reviewed commit, each applied only where the
 * exact original line is found, so a newer TurboFit is left as it is.
 *
 * - Its loader rejects its own bundled data: the 48 GB profile's auxiliary
 *   roles share the main model's server and say so with expected_vram_mb 0,
 *   which the loader refuses, and every turbofit-runtime command then fails.
 *   Zero is the honest value, so the check is relaxed to match it.
 * - On a CPU or unified-memory machine its pressure probe reads free memory
 *   as SC_AVPHYS_PAGES, which is MemFree: it leaves out reclaimable cache, is
 *   small on any Linux machine that has been up a while, and drops further
 *   once a model is memory-mapped. The controller then reads the model it
 *   just loaded as a memory emergency and unloads it -- seen here: loaded,
 *   answered, and dropped by the next tick. TurboFit's own benchmark code
 *   already reads the right figure (MemAvailable, or vm_stat's free,
 *   inactive, speculative and purgeable pages on macOS); the probe uses it.
 *   Where neither exists (Windows has no os.sysconf) it falls back to the
 *   machine's usable memory instead of raising. */
const TURBOFIT_PATCHES: readonly { file: string; from: string; to: string }[] = [
  {
    file: 'src/turbofit_runtime/routes.py',
    from: 'if isinstance(expected, bool) or not isinstance(expected, int) or expected <= 0:',
    to: 'if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:',
  },
  {
    file: 'src/turbofit_runtime/pressure_probe.py',
    from: [
      '        try:',
      '            available = (',
      '                int(system_available_mb)',
      '                if system_available_mb is not None',
      '                else int(os.sysconf("SC_AVPHYS_PAGES"))',
      '                * int(os.sysconf("SC_PAGE_SIZE")) // 1048576',
      '            )',
      '        except (OSError, ValueError):',
    ].join('\n'),
    to: [
      '        try:',
      '            if system_available_mb is not None:',
      '                available = int(system_available_mb)',
      '            else:',
      '                # ClikCode: reclaimable memory (MemAvailable, vm_stat), not MemFree.',
      '                from .benchmark_stage import _meminfo',
      '                meminfo = _meminfo()',
      '                available = (',
      '                    meminfo["MemAvailable"] // 1024 if "MemAvailable" in meminfo',
      '                    else int(os.sysconf("SC_AVPHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE")) // 1048576',
      '                )',
      '        except (OSError, ValueError, AttributeError):',
    ].join('\n'),
  },
];

/** A manual profile TurboFit wrote on a machine with no GPU carries an
 * empty GPU index that its own loader refuses -- and one such file stops
 * every TurboFit command from reading its state. Repaired in place, whoever
 * wrote it (see TURBOFIT_CPU_LANE_SELECT_SCRIPT). */
async function repairManualResolutions(environment: Environment): Promise<void> {
  const file = join(turboFitHome(environment), '.config', 'turbofit', 'manual-runtime-resolutions.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return; }
  const parsed = JSON.parse(text) as { profiles?: Record<string, Record<string, Record<string, { gpu?: unknown }>>> };
  let changed = false;
  for (const rungs of Object.values(parsed.profiles ?? {})) {
    for (const roles of Object.values(rungs)) {
      for (const role of Object.values(roles)) if (role && role.gpu === '') { role.gpu = '0'; changed = true; }
    }
  }
  if (changed) await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function patchTurboFit(root: string): Promise<void> {
  for (const patch of TURBOFIT_PATCHES) {
    const file = join(root, patch.file);
    const text = await readFile(file, 'utf8');
    if (text.includes(patch.from)) await writeFile(file, text.replace(patch.from, patch.to));
  }
}

interface Plan {
  selected: string | null;
  backend?: string;
  modelRoot?: string;
  runtimes?: { binary: string; runtime: string | null; present: boolean }[];
  files?: { destination: string; family: string | null; repo: string; path: string; size: number; present: boolean }[];
  unknown?: string[];
}

function toolsEnv(python: string, root: string, environment: Environment, backend?: string): NodeJS.ProcessEnv {
  return {
    ...process.env, ...environment,
    PATH: [join(python, '..'), process.env.PATH ?? ''].join(delimiter),
    PYTHONPATH: join(root, 'src'),
    PYTHONHOME: '',
    ...(backend ? { TURBOFIT_ACCELERATOR_BACKEND: backend } : {}),
  };
}

async function readPlan(python: string, root: string, environment: Environment, backend?: string): Promise<Plan> {
  const result = await run(python, ['-c', TURBOFIT_PLAN_SCRIPT, root], { cwd: root, env: toolsEnv(python, root, environment, backend), timeoutMs: 120_000 });
  const marker = result.output.lastIndexOf('\x00TURBOFIT_PLAN');
  if (marker < 0) throw new Error(`TurboFit could not resolve its selected model.\n${tail(result.output)}`);
  return JSON.parse(result.output.slice(marker + '\x00TURBOFIT_PLAN'.length).split('\n')[0]!) as Plan;
}

/** The compiler each native backend's build needs. A backend whose toolkit
 * is missing is built for the CPU instead -- TurboFit picks Vulkan the moment
 * `vulkaninfo` exists, and that alone does not mean the Vulkan SDK does. */
async function buildableBackend(backend: string): Promise<string> {
  const needs: Record<string, string> = { cuda: 'nvcc', rocm: 'hipcc', vulkan: 'glslc' };
  const tool = needs[backend];
  return tool && !await binaryOnPath(tool) ? 'cpu' : backend;
}

async function checkCompiler(): Promise<void> {
  if (!await binaryOnPath('git')) throw new Error('Building TurboFit\'s runtime needs git. Install git, then choose the model again.');
  if (process.platform === 'darwin') {
    const found = await run('xcrun', ['--find', 'clang++'], { timeoutMs: 30_000 });
    if (found.code !== 0) throw new Error('Building TurboFit\'s runtime needs Apple\'s command line tools. Run `xcode-select --install`, then choose the model again.');
    return;
  }
  if (WINDOWS) {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const found = existsSync(vswhere) ? await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { timeoutMs: 30_000 }) : undefined;
    if (!found?.output.trim()) throw new Error('Building TurboFit\'s runtime needs the Visual Studio C++ build tools. Run `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`, then choose the model again.');
    return;
  }
  for (const compiler of ['c++', 'g++', 'clang++']) if (await binaryOnPath(compiler)) return;
  throw new Error('Building TurboFit\'s runtime needs a C++ compiler. Install one (Debian/Ubuntu: `sudo apt install build-essential`; Fedora: `sudo dnf install gcc-c++`), then choose the model again.');
}

async function buildRuntime(python: string, root: string, environment: Environment, runtime: string, backend: string, progress: Progress): Promise<void> {
  await checkCompiler();
  progress(`building TurboFit's ${backend.toUpperCase()} runtime…`);
  const result = await run(python, [join(root, 'scripts', 'install-native-runtimes'), '--runtime', runtime, '--backend', backend], {
    cwd: root, env: toolsEnv(python, root, environment, backend), timeoutMs: 3 * 60 * 60_000,
    onLine: (line) => {
      const percent = /^\[\s*(\d+)%\]/.exec(line.trim())?.[1];
      if (percent) progress(`building TurboFit's ${backend.toUpperCase()} runtime… ${percent}%`);
      else if (/^Cloning|git (?:clone|fetch)/i.test(line)) progress(`downloading TurboFit's ${backend.toUpperCase()} runtime source…`);
    },
  });
  if (result.code !== 0) throw new Error(`Could not build TurboFit's runtime.\n${tail(result.output)}`);
}

/** A model is gigabytes; failing at 90% for want of space wastes the wait.
 * The download lands in the Hugging Face cache and is hard-linked into the
 * model root, so one copy's worth, plus room to spare. */
async function checkDiskSpace(directory: string, bytes: number): Promise<void> {
  let target = directory;
  while (!existsSync(target) && join(target, '..') !== target) target = join(target, '..');
  const disk = await statfs(target).catch(() => undefined);
  if (!disk) return;
  const free = disk.bavail * disk.bsize;
  const needed = bytes + 2e9;
  if (free < needed) throw new Error(`The model needs ${formatBytes(needed)} free and ${formatBytes(free)} is available on the disk holding ${directory}.`);
}

function hubCache(environment: Environment): string {
  const merged = { ...process.env, ...environment };
  if (merged.HF_HUB_CACHE) return merged.HF_HUB_CACHE;
  return join(merged.HF_HOME || join(turboFitHome(environment), '.cache', 'huggingface'), 'hub');
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Downloads one file with TurboFit's downloader, which verifies it against
 * the pinned SHA-256. Progress is the size of the partial file Hugging Face
 * writes into its cache, so it needs nothing from the downloader itself. */
async function downloadFile(
  python: string, root: string, environment: Environment,
  file: NonNullable<Plan['files']>[number], index: number, count: number, progress: Progress,
): Promise<void> {
  const label = count > 1 ? `downloading model file ${index + 1} of ${count}` : 'downloading model';
  const blobs = join(hubCache(environment), `models--${file.repo.replace('/', '--')}`, 'blobs');
  progress(`${label} (${formatBytes(file.size)})…`);
  const poll = setInterval(() => {
    void (async () => {
      let partial = 0;
      for (const name of await readdir(blobs).catch(() => [] as string[])) {
        if (!name.endsWith('.incomplete')) continue;
        partial = Math.max(partial, (await stat(join(blobs, name)).catch(() => undefined))?.size ?? 0);
      }
      if (partial > 0) progress(`${label}… ${Math.min(99, Math.floor((partial / file.size) * 100))}% of ${formatBytes(file.size)}`);
    })();
  }, 1000);
  try {
    const args = [join(root, 'scripts', 'download-artifacts'), '--destination', file.destination, ...(file.family ? ['--family', file.family] : [])];
    const result = await run(python, args, { cwd: root, env: { ...toolsEnv(python, root, environment), HF_HUB_DISABLE_PROGRESS_BARS: '1' } });
    if (result.code !== 0) throw new Error(`Could not download ${file.path}.\n${tail(result.output)}`);
  } finally {
    clearInterval(poll);
  }
}

function gatewayRequest(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = nodeHttp().request({
      ...GATEWAY, method, path, timeout: timeoutMs,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), authorization: 'Bearer not-needed' },
    }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, text: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function supervisorRunning(environment: Environment): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(join(stateDir(environment), 'clikcode-supervisor.json'), 'utf8')) as { pid?: number };
    return processAlive(Number(record.pid));
  } catch { return false; }
}

function leaseFile(environment: Environment, sessionId: string): string {
  return join(stateDir(environment), 'clikcode-leases', `${process.pid}-${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

/** This ClikCode process's hold on the runtime for one session. The
 * supervisor stops everything once no live process holds one. */
async function writeLease(environment: Environment, sessionId: string): Promise<void> {
  const file = leaseFile(environment, sessionId);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ pid: process.pid, session: sessionId, at: new Date().toISOString() }));
}

/** Whether a live ClikCode process -- this one or another -- already holds
 * the runtime for this session. The interactive process takes the lease
 * before handing a turn to its worker; the worker, which outlives the
 * terminal, then joins it instead of holding one of its own. */
async function sessionHeld(environment: Environment, sessionId: string): Promise<boolean> {
  const suffix = `-${sessionId.replace(/[^\w.-]/g, '_')}.json`;
  const directory = join(stateDir(environment), 'clikcode-leases');
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.endsWith(suffix)) continue;
    if (processAlive(Number(name.slice(0, name.indexOf('-'))))) return true;
  }
  return false;
}

/** Let go of the runtime for one session (its model moved off TurboFit). */
export async function releaseTurboFitRuntime(account: AiHarnessAccount | undefined, sessionId: string): Promise<void> {
  await rm(leaseFile(nativeProfileEnvironment(account?.nativeProfile), sessionId), { force: true });
}

async function startSupervisor(python: string, root: string, environment: Environment, backend: string): Promise<void> {
  const state = stateDir(environment);
  await mkdir(join(state, 'clikcode-logs'), { recursive: true });
  const child = spawn(python, ['-c', TURBOFIT_SUPERVISOR_SCRIPT, root, state], {
    cwd: root, env: toolsEnv(python, root, environment, backend), detached: true, stdio: 'ignore', windowsHide: true,
  });
  // Detached and unreferenced: it outlives nothing it is not told to, because
  // it watches the lease files, and ClikCode's exit is what ends a lease.
  child.unref();
  for (let waited = 0; waited < 30_000; waited += 250) {
    if (await supervisorRunning(environment)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`TurboFit's runtime did not start. Its logs are in ${join(state, 'clikcode-logs')}.`);
}

function completionFor(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], ...extra };
}

/** The gateway answers before a model is loaded (a 503 while TurboFit is
 * still on its API rung). Ready means a completion came back from the local
 * model; the wait covers TurboFit's promotion dwell and a cold model load,
 * which on a CPU is minutes. */
async function waitUntilServing(model: string, environment: Environment, owned: boolean, progress: Progress): Promise<void> {
  const route = model.replace(/^(?:custom:)?turbofit:/, '');
  const started = Date.now();
  const limit = 30 * 60_000;
  let last = '';
  while (Date.now() - started < limit) {
    const reply = await gatewayRequest('POST', '/v1/chat/completions', completionFor(route), 600_000);
    if (reply.status === 200) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    progress(`starting the local model… ${seconds}s`);
    last = reply.status ? `HTTP ${reply.status}: ${reply.text.slice(0, 200)}` : 'gateway not answering yet';
    // Ours and gone: it stopped for a reason its logs give. Someone else's
    // runtime is waited on for the full limit.
    if (owned && !await supervisorRunning(environment)) break;
    await new Promise((done) => setTimeout(done, 3000));
  }
  const logs = join(stateDir(environment), 'clikcode-logs');
  throw new Error(`TurboFit's local model did not start (${last}). Logs: ${logs} and ${join(stateDir(environment), 'native', 'logs')}.`);
}

/** Hermes' opening prompt -- its instructions and every tool definition --
 * measured at about 25,000 tokens (Hermes v0.20.5, llama.cpp's own count).
 * Every turn processes at least that much before the first word. */
const HERMES_PROMPT_TOKENS = 25_000;

/** What "usable with Hermes" means for a local model. At 50 tokens a second
 * Hermes' opening prompt takes about eight minutes, once: llama.cpp keeps the
 * shared prefix cached, so later turns read only what is new. 8 tokens a
 * second writes a paragraph in a few seconds. The Qwen 27B TurboFit picks for
 * a 48 GB machine reads 5 a second on a laptop CPU -- over an hour. */
const MIN_PROMPT_PER_SECOND = 50;
const MIN_GENERATE_PER_SECOND = 8;

export interface ModelCheck { toolCalls: boolean; promptPerSecond?: number; generatePerSecond?: number }

export function meetsBar(check: ModelCheck | undefined): boolean {
  return Boolean(check?.toolCalls
    && (check.promptPerSecond ?? 0) >= MIN_PROMPT_PER_SECOND && (check.generatePerSecond ?? 0) >= MIN_GENERATE_PER_SECOND);
}

async function readChecks(environment: Environment): Promise<Record<string, ModelCheck>> {
  return JSON.parse(await readFile(join(stateDir(environment), 'clikcode-model-check.json'), 'utf8').catch(() => '{}')) as Record<string, ModelCheck>;
}

async function writeCheck(environment: Environment, profile: string, check: ModelCheck): Promise<void> {
  await mkdir(stateDir(environment), { recursive: true });
  await writeFile(join(stateDir(environment), 'clikcode-model-check.json'), JSON.stringify({ ...await readChecks(environment), [profile]: check }));
}

/** Measured, not estimated, on the model now serving: a few-hundred-token
 * prompt for reading speed and a short reply for writing speed (llama.cpp
 * reports both), then one request that asks for a tool. A model that cannot
 * make a tool call fits in memory and still cannot do Hermes' work. */
async function measureModel(route: string): Promise<ModelCheck> {
  const numbers = Array.from({ length: 240 }, (_, index) => `${index * 7 + 3}`).join(', ');
  const speed = await gatewayRequest('POST', '/v1/chat/completions', completionFor(route, {
    max_tokens: 48, temperature: 0,
    messages: [{ role: 'user', content: `Here is a list of numbers: ${numbers}.\nIn one sentence, what do they have in common?` }],
  }), 900_000);
  const check: ModelCheck = { toolCalls: false };
  try {
    const timings = (JSON.parse(speed.text) as { timings?: { prompt_per_second?: number; predicted_per_second?: number } }).timings;
    const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    check.promptPerSecond = finite(timings?.prompt_per_second);
    check.generatePerSecond = finite(timings?.predicted_per_second);
  } catch { /* No timings: the speed stays unknown, which fails the bar. */ }
  const tool = await gatewayRequest('POST', '/v1/chat/completions', completionFor(route, {
    max_tokens: 256,
    messages: [{ role: 'user', content: 'What time is it? Use the get_time tool.' }],
    tools: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
  }), 900_000);
  try { check.toolCalls = Boolean((JSON.parse(tool.text) as { choices?: { message?: { tool_calls?: unknown[] } }[] }).choices?.[0]?.message?.tool_calls?.length); }
  catch { /* No parseable reply is not a tool call. */ }
  return check;
}

function describeCheck(profile: string, check: ModelCheck): string | undefined {
  const notes: string[] = [];
  if (!check.toolCalls) notes.push(`TurboFit's ${profile} did not make a tool call when asked, so Hermes tools may not work with it.`);
  const minutes = check.promptPerSecond ? HERMES_PROMPT_TOKENS / check.promptPerSecond / 60 : 0;
  if (minutes >= 2) {
    notes.push(`On this machine it reads about ${Math.round(check.promptPerSecond!)} tokens a second, so a conversation's first Hermes reply `
      + `starts after roughly ${Math.round(minutes)} minutes (later replies reuse what was read).`);
  }
  return notes.length ? notes.join(' ') : undefined;
}

// ---- CPU lanes -------------------------------------------------------------

export interface LaneFile { destination: string; family: string | null; repo: string; path: string; size: number; present: boolean }
export interface CpuLane {
  variant: string; name: string; quant: string; totalB: number; activeB: number;
  mainBytes: number; totalBytes: number; binaries: string[]; files: LaneFile[];
}
export interface CpuLanes { pool: string; usableMb: number; cores: number; lanes: CpuLane[] }

async function readCpuLanes(python: string, root: string, environment: Environment): Promise<CpuLanes> {
  const result = await run(python, ['-c', TURBOFIT_CPU_LANES_SCRIPT, root], { cwd: root, env: toolsEnv(python, root, environment), timeoutMs: 120_000 });
  const marker = result.output.lastIndexOf('\x00TURBOFIT_LANES');
  if (marker < 0) throw new Error(`TurboFit could not list the models for this machine.\n${tail(result.output)}`);
  return JSON.parse(result.output.slice(marker + '\x00TURBOFIT_LANES'.length).split('\n')[0]!) as CpuLanes;
}

/** Prompt tokens a second per billion active parameters, by compression
 * format, measured with llama-bench on an 8-core Zen 4 (Ryzen 7 8745HS):
 * Q4_K 88 t/s at 3B active, Q3_K 5.0 at 27B, IQ3_XXS 2.9 at 27B. Kernels,
 * not size, set these -- IQ3_XXS is the smaller file and the slower read --
 * which is why a GPU figure cannot be scaled to a CPU one. Scaled by core
 * count; formats not measured take a middling value. Only an ordering: what
 * is chosen is measured before it is kept. */
const PROMPT_RATE: readonly [RegExp, number][] = [
  [/IQ[1-3]/i, 79], [/Q3_K/i, 136], [/Q[45]_K|Q4_0|Q4\b/i, 264], [/Q[68]/i, 200], [/[BF]F?16/i, 60],
];
/** Memory bandwidth llama.cpp reaches reading weights on that machine,
 * measured the same way: writing speed times the bytes each token reads
 * (13.2 GB x 3.3 t/s for the dense Qwen, 1.9 GB x 20.4 for Ornith's active
 * share) -- about 40 GB/s, the 46-55 GB/s a STREAM test shows less overhead. */
const WEIGHT_BANDWIDTH = 40e9;

export function estimateLane(lane: CpuLane, cores: number): { promptPerSecond: number; generatePerSecond: number } {
  const rate = PROMPT_RATE.find(([pattern]) => pattern.test(lane.quant))?.[1] ?? 150;
  const activeShare = lane.totalB > 0 ? lane.activeB / lane.totalB : 1;
  return {
    promptPerSecond: (rate * cores / 8) / Math.max(0.1, lane.activeB),
    generatePerSecond: WEIGHT_BANDWIDTH / Math.max(1, lane.mainBytes * activeShare),
  };
}

function laneProfile(variant: string): string { return `manual-cpu-${variant}-64k`; }

/** The order CPU lanes are tried in: those expected to meet the bar first,
 * largest model first among them (TurboFit publishes no quality score for
 * most of these; parameters are the plain proxy); then the rest, fastest
 * first. A lane measured before is ranked by its measurement. */
export function rankLanes(lanes: CpuLanes, checks: Record<string, ModelCheck>): { lane: CpuLane; passes: boolean; measured?: ModelCheck }[] {
  return lanes.lanes.map((lane) => {
    const measured = checks[laneProfile(lane.variant)];
    const estimate = estimateLane(lane, lanes.cores);
    const passes = measured ? meetsBar(measured)
      : estimate.promptPerSecond >= MIN_PROMPT_PER_SECOND && estimate.generatePerSecond >= MIN_GENERATE_PER_SECOND;
    return { lane, passes, measured, speed: measured?.promptPerSecond ?? estimate.promptPerSecond };
  }).sort((left, right) => Number(right.passes) - Number(left.passes)
    || (left.passes ? right.lane.totalB - left.lane.totalB : right.speed - left.speed))
    .map(({ lane, passes, measured }) => ({ lane, passes, ...(measured ? { measured } : {}) }));
}

/** CPU lanes as /model rows, for a machine TurboFit sees no GPU in. */
export async function turboFitCpuLaneRows(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined,
): Promise<{ id: string; label: string; detail: string }[]> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const root = await turboFitPluginRoot(environment);
  const python = venvPython(toolsDir(environment));
  if (!root || !existsSync(python)) return [];
  const lanes = await readCpuLanes(python, root, environment).catch(() => undefined);
  if (!lanes || lanes.pool !== 'cpu') return [];
  const checks = await readChecks(environment);
  return rankLanes(lanes, checks).map(({ lane, measured }) => {
    const speed = measured
      ? `measured ${Math.round(measured.promptPerSecond ?? 0)} tok/s reading, ${Math.round(measured.generatePerSecond ?? 0)} writing${measured.toolCalls ? '' : ', no tool calls'}`
      : `about ${Math.round(estimateLane(lane, lanes.cores).promptPerSecond)} tok/s reading (estimate)`;
    const download = lane.files.filter((file) => !file.present).reduce((sum, file) => sum + file.size, 0);
    return {
      id: `cpu-lane:${lane.variant}`,
      label: lane.name,
      detail: `CPU · ${speed}${download ? ` · ${formatBytes(download)} download` : ''}`,
    };
  });
}

/** Apply this machine's CPU launch settings to one lane (see
 * TURBOFIT_CPU_TUNE_SCRIPT). A changed launch drops the lane's measurement,
 * which was taken with the old settings. Returns whether it changed. */
async function tuneCpuLane(python: string, root: string, environment: Environment, variant: string): Promise<boolean> {
  const result = await run(python, ['-c', TURBOFIT_CPU_TUNE_SCRIPT, root, variant], { cwd: root, env: toolsEnv(python, root, environment), timeoutMs: 60_000 });
  const marker = result.output.lastIndexOf('\x00TURBOFIT_TUNED');
  if (marker < 0) throw new Error(`Could not tune TurboFit for this CPU.\n${tail(result.output)}`);
  const { changed } = JSON.parse(result.output.slice(marker + '\x00TURBOFIT_TUNED'.length).split('\n')[0]!) as { changed: boolean };
  if (changed) {
    const checks = await readChecks(environment);
    delete checks[laneProfile(variant)];
    await mkdir(stateDir(environment), { recursive: true });
    await writeFile(join(stateDir(environment), 'clikcode-model-check.json'), JSON.stringify(checks));
  }
  return changed;
}

async function selectCpuLane(python: string, root: string, environment: Environment, lane: CpuLane): Promise<string> {
  await tuneCpuLane(python, root, environment, lane.variant);
  // What it will hold: weights, a 64K context, llama.cpp's buffers. Only an
  // input to TurboFit's fit check; llama-server's --fit sizes the real thing.
  const residentMb = Math.round(lane.totalBytes / 1048576 * 1.25 + 1024);
  const result = await run(python, ['-c', TURBOFIT_CPU_LANE_SELECT_SCRIPT, root, lane.variant, String(residentMb)], {
    cwd: root, env: toolsEnv(python, root, environment), timeoutMs: 240_000,
  });
  const marker = result.output.lastIndexOf('\x00TURBOFIT_SELECTION');
  const payload = marker < 0 ? undefined : JSON.parse(result.output.slice(marker + '\x00TURBOFIT_SELECTION'.length).split('\n')[0]!) as { error?: string; profile_id?: string };
  if (!payload || payload.error) throw new Error(`TurboFit could not select ${lane.name}: ${payload?.error ?? tail(result.output)}`);
  return payload.profile_id ?? laneProfile(lane.variant);
}

/** The user's own pick in /model is kept, however it measures. */
async function readUserChoice(environment: Environment): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(join(stateDir(environment), 'clikcode-user-choice.json'), 'utf8')) as { profile?: string }).profile; }
  catch { return undefined; }
}

async function writeUserChoice(environment: Environment, profile: string | undefined): Promise<void> {
  const file = join(stateDir(environment), 'clikcode-user-choice.json');
  if (!profile) { await rm(file, { force: true }); return; }
  await mkdir(stateDir(environment), { recursive: true });
  await writeFile(file, JSON.stringify({ profile, at: new Date().toISOString() }));
}

export interface TurboFitReady { notice?: string }

interface Prepared { python: string; root: string; environment: Environment }

/** Get a TurboFit model running for this session. `profile` is a /model
 * pick -- a TurboFit recommendation, or `cpu-lane:<variant>` -- and is kept
 * as picked. Otherwise, on a machine TurboFit sees no GPU in, ClikCode
 * chooses: TurboFit's own recommendations are GPU-measured (its one pick for
 * a 48 GB machine reads 5 tokens a second on a laptop CPU), so the CPU lanes
 * are tried in rankLanes order and the first that measures usable is kept.
 * With a GPU, TurboFit's recommendation stands. */
export async function prepareTurboFitModel(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string,
  model: string, progress: Progress, profile?: string,
): Promise<TurboFitReady> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const root = await turboFitPluginRoot(environment);
  if (!root) throw new Error('TurboFit is not installed in this Hermes home; choose Hermes again to install it.');
  await patchTurboFit(root);
  await repairManualResolutions(environment);
  const python = await ensureTools(harness, environment, progress);
  const prepared: Prepared = { python, root, environment };

  const before = (await readPlan(python, root, environment)).selected;
  if (profile) {
    progress('selecting the TurboFit model…');
    const lanes = profile.startsWith('cpu-lane:') ? await readCpuLanes(python, root, environment) : undefined;
    const lane = lanes?.lanes.find((item) => `cpu-lane:${item.variant}` === profile);
    if (lanes && !lane) throw new Error(`${profile.slice('cpu-lane:'.length)} is not a model this machine can run.`);
    const selected = lane ? await selectCpuLane(python, root, environment, lane) : (await selectHermesTurboFitRecommendation(harness, account, profile), undefined);
    await writeUserChoice(environment, selected ?? (await readPlan(python, root, environment)).selected ?? profile);
    return runSelected(prepared, sessionId, model, before, progress);
  }

  // A CPU lane chosen before these launch settings existed gets them now;
  // its runtime then restarts with the new launch, and it is re-measured.
  const selectedLane = before?.match(/^manual-cpu-(.+)-64k$/)?.[1];
  const retuned = selectedLane ? await tuneCpuLane(python, root, environment, selectedLane) : false;
  const checks = await readChecks(environment);
  const userChoice = await readUserChoice(environment);
  if (!(before && before === userChoice)) {
    const lanes = await readCpuLanes(python, root, environment);
    if (lanes.pool === 'cpu' && !(before && meetsBar(checks[before]))) {
      return chooseCpuLane(prepared, lanes, checks, sessionId, model, retuned ? null : before, progress);
    }
  }
  if (!before) {
    progress('choosing a model for this machine…');
    const [top] = await discoverHermesTurboFitRecommendations(await hermesInstall(harness, environment), environment);
    if (!top) throw new Error('TurboFit found no local model that fits this machine.');
    await selectHermesTurboFitRecommendation(harness, account, top.id);
  }
  return runSelected(prepared, sessionId, model, retuned ? null : before, progress);
}

/** Try CPU lanes until one measures usable; at most three are fetched, so a
 * machine too slow for all of them does not download the whole catalog.
 * None usable: the fastest one measured is kept, and the notice says so. */
async function chooseCpuLane(
  prepared: Prepared, lanes: CpuLanes, checks: Record<string, ModelCheck>,
  sessionId: string, model: string, before: string | null, progress: Progress,
): Promise<TurboFitReady> {
  const ranked = rankLanes(lanes, checks);
  if (!ranked.length) throw new Error('TurboFit has no model that fits this machine\'s memory.');
  let current = before;
  let best: { lane: CpuLane; check: ModelCheck } | undefined;
  let tried = 0;
  for (const { lane, measured } of ranked) {
    if (measured && !meetsBar(measured)) {
      if (!best || (measured.promptPerSecond ?? 0) > (best.check.promptPerSecond ?? 0)) best = { lane, check: measured };
      continue;
    }
    if (tried++ >= 3) break;
    progress(`trying ${lane.name} on this CPU…`);
    const profile = await selectCpuLane(prepared.python, prepared.root, prepared.environment, lane);
    const ready = await runSelected(prepared, sessionId, model, current, progress);
    current = profile;
    const check = (await readChecks(prepared.environment))[profile];
    if (meetsBar(check)) return ready;
    if (check && (!best || (check.promptPerSecond ?? 0) > (best.check.promptPerSecond ?? 0))) best = { lane, check };
  }
  if (!best) throw new Error('No TurboFit model could be measured on this machine.');
  const profile = laneProfile(best.lane.variant);
  if (profile !== current) {
    await selectCpuLane(prepared.python, prepared.root, prepared.environment, best.lane);
    await runSelected(prepared, sessionId, model, current, progress);
  }
  const why = describeCheck(best.lane.name, best.check);
  return { notice: `No TurboFit model reached ${MIN_PROMPT_PER_SECOND} tokens a second reading on this CPU; ${best.lane.name} was the fastest.${why ? ` ${why}` : ''}` };
}

/** Everything after a selection: the runtime it needs, its files, the
 * lease, the processes, the wait until it answers, and its measurement. */
async function runSelected(
  { python, root, environment }: Prepared, sessionId: string, model: string, before: string | null | undefined, progress: Progress,
): Promise<TurboFitReady> {
  let plan = await readPlan(python, root, environment);
  const selected = plan.selected;
  if (!selected) throw new Error('TurboFit has no model selected.');
  const backend = await buildableBackend(plan.backend ?? 'cpu');
  if (backend !== plan.backend) plan = await readPlan(python, root, environment, backend);
  if (plan.unknown?.length) throw new Error(`TurboFit's ${selected} names files it publishes no download for: ${plan.unknown.join(', ')}`);

  for (const runtime of plan.runtimes ?? []) {
    if (runtime.present) continue;
    if (!runtime.runtime) throw new Error(`TurboFit's ${selected} needs ${runtime.binary}, which no pinned runtime builds.`);
    await buildRuntime(python, root, environment, runtime.runtime, backend, progress);
  }
  const missing = (plan.files ?? []).filter((file) => !file.present);
  if (missing.length) await checkDiskSpace(plan.modelRoot ?? turboFitHome(environment), missing.reduce((sum, file) => sum + file.size, 0));
  for (const [index, file] of missing.entries()) await downloadFile(python, root, environment, file, index, missing.length, progress);

  const leased = !await sessionHeld(environment, sessionId);
  if (leased) await writeLease(environment, sessionId);
  try {
    return await startAndCheck(python, root, environment, backend, model, selected, selected !== before, progress);
  } catch (error) {
    // Not running for this session after all: nothing may stay up on its account.
    if (leased) await rm(leaseFile(environment, sessionId), { force: true });
    throw error;
  }
}

async function startAndCheck(
  python: string, root: string, environment: Environment, backend: string,
  model: string, selected: string, changed: boolean, progress: Progress,
): Promise<TurboFitReady> {
  let owned = await supervisorRunning(environment);
  if (owned && changed) {
    // TurboFit's controller reads its profile catalog once, at start; a newly
    // selected model is a profile it has not loaded. The supervisor restarts
    // it (and stops the model it was serving) when asked through this file --
    // and until it has, the old model would answer the readiness check.
    progress('switching TurboFit to the new model…');
    const request = join(stateDir(environment), 'clikcode-restart');
    await writeFile(request, new Date().toISOString());
    for (let waited = 0; existsSync(request) && waited < 60_000; waited += 500) await new Promise((done) => setTimeout(done, 500));
  }
  if (!owned) {
    // Something already on TurboFit's port: joined only if it is TurboFit
    // (the user's own service, say), which lists TurboFit's routes.
    const listing = await gatewayRequest('GET', '/v1/models', undefined, 3000);
    const external = listing.status === 200 && listing.text.includes('active:main');
    if (!external && listing.status !== 0) {
      throw new Error(`Another program is using port ${GATEWAY.port}, which TurboFit's gateway needs. Stop it, then choose the model again.`);
    }
    if (!external) {
      // A different model since TurboFit last ran: the controller's saved
      // state names a profile TurboFit no longer has (it keeps one manual
      // profile) and it would refuse to start. Nothing is running to lose.
      // Decided by the state's own profile, not only by this call's change:
      // an earlier attempt may have selected the new model and failed.
      // Unchanged, the state stays -- it is what makes a restart take seconds.
      const saved = await readFile(join(stateDir(environment), 'controller.json'), 'utf8')
        .then((text) => (JSON.parse(text) as { profile_id?: string }).profile_id, () => undefined);
      if (changed || (saved && saved !== selected)) {
        for (const name of ['controller.json', 'runtime-state.json']) await rm(join(stateDir(environment), name), { force: true });
      }
      progress('starting TurboFit…');
      await startSupervisor(python, root, environment, backend);
      owned = true;
    }
  }
  await waitUntilServing(model, environment, owned, progress);
  const route = model.replace(/^(?:custom:)?turbofit:/, '');
  let check = (await readChecks(environment))[selected];
  if (!check) {
    progress('measuring the local model…');
    check = await measureModel(route);
    await writeCheck(environment, selected, check);
  }
  const notice = describeCheck(selected, check);
  return notice ? { notice } : {};
}

/** Before a turn on a TurboFit model: the runtime is up, or brought up. A
 * session reopened after ClikCode restarted holds no lease and has no
 * runtime running, and its turn would otherwise meet a refused connection. */
export async function ensureTurboFitServing(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string, model: string, progress: Progress,
): Promise<TurboFitReady> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  // Held and answering: nothing to do. Anything else goes through the full
  // path, which skips every step already done (no download, no build).
  if (await sessionHeld(environment, sessionId) && (await gatewayRequest('GET', '/v1/models', undefined, 3000)).status === 200) return {};
  return prepareTurboFitModel(harness, account, sessionId, model, progress);
}

/** Every lease this process holds, dropped as it exits -- the supervisor
 * would notice the dead process anyway; this just makes it immediate. */
export function releaseTurboFitLeasesOnExit(): void {
  const drop = (): void => {
    const directory = join(stateDir({}), 'clikcode-leases');
    try {
      for (const name of readdirSync(directory)) if (name.startsWith(`${process.pid}-`)) rmSync(join(directory, name), { force: true });
    } catch { /* No leases. */ }
  };
  process.once('exit', drop);
}
