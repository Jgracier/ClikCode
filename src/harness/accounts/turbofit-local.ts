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
import { request } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { binaryOnPath } from '../transport/native/binary.js';
import {
  discoverHermesTurboFitRecommendations, hermesInstallDirectory, selectHermesTurboFitRecommendation, turboFitPluginRoot,
} from './hermes-discovery.js';
import { TURBOFIT_PLAN_SCRIPT, TURBOFIT_SUPERVISOR_SCRIPT } from './turbofit-scripts.js';

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
    const req = request({
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

interface ModelCheck { toolCalls: boolean; promptPerSecond?: number }

/** What an agent needs from a model beyond fitting in memory: it calls
 * tools, and it reads a prompt fast enough to answer. Tool calling is what
 * lets Hermes act at all; prompt speed decides whether a turn takes seconds
 * or an hour (a 27B model on a laptop CPU reads ~5 tokens a second: over an
 * hour before Hermes' first reply). Both are measured once per selected
 * profile, from one request -- llama.cpp reports its own prompt speed -- and
 * reported, not refused: TurboFit chose the model for this machine. */
async function checkModel(route: string, environment: Environment, profile: string): Promise<string | undefined> {
  const cache = join(stateDir(environment), 'clikcode-model-check.json');
  const known = JSON.parse(await readFile(cache, 'utf8').catch(() => '{}')) as Record<string, ModelCheck>;
  let check = known[profile];
  if (!check) {
    const reply = await gatewayRequest('POST', '/v1/chat/completions', completionFor(route, {
      max_tokens: 256,
      messages: [{ role: 'user', content: 'What time is it? Use the get_time tool.' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
    }), 600_000);
    check = { toolCalls: false };
    try {
      const parsed = JSON.parse(reply.text) as {
        choices?: { message?: { tool_calls?: unknown[] } }[];
        timings?: { prompt_per_second?: number };
      };
      check.toolCalls = Boolean(parsed.choices?.[0]?.message?.tool_calls?.length);
      const speed = parsed.timings?.prompt_per_second;
      if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) check.promptPerSecond = speed;
    } catch { /* No parseable reply is not a tool call. */ }
    await writeFile(cache, JSON.stringify({ ...known, [profile]: check }));
  }
  const notes: string[] = [];
  if (!check.toolCalls) notes.push(`TurboFit's ${profile} did not make a tool call when asked, so Hermes tools may not work with it.`);
  const minutes = check.promptPerSecond ? HERMES_PROMPT_TOKENS / check.promptPerSecond / 60 : 0;
  if (minutes >= 2) {
    notes.push(`On this machine it reads about ${Math.round(check.promptPerSecond!)} tokens a second, so each Hermes reply starts `
      + `after roughly ${Math.round(minutes)} minutes. A GPU TurboFit can use, or a smaller model, is much faster.`);
  }
  return notes.length ? notes.join(' ') : undefined;
}

export interface TurboFitReady { notice?: string }

/** Get a TurboFit model running for this session: select it, fetch what it
 * needs, start the runtime (or join one already running), and wait until it
 * answers. `profile` is a recommendation the user picked; a mode picked with
 * nothing selected yet uses TurboFit's top recommendation for this machine
 * (TurboFit's own Auto profile lacks runtime entries on some tiers at the
 * reviewed commit, so it is not relied on). */
export async function prepareTurboFitModel(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string,
  model: string, progress: Progress, profile?: string,
): Promise<TurboFitReady> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const root = await turboFitPluginRoot(environment);
  if (!root) throw new Error('TurboFit is not installed in this Hermes home; choose Hermes again to install it.');
  await patchTurboFit(root);
  const python = await ensureTools(harness, environment, progress);

  let plan = await readPlan(python, root, environment);
  const before = plan.selected;
  if (profile) {
    progress('selecting the TurboFit model…');
    await selectHermesTurboFitRecommendation(harness, account, profile);
  } else if (!plan.selected) {
    progress('choosing a model for this machine…');
    const [top] = await discoverHermesTurboFitRecommendations(await hermesInstall(harness, environment), environment);
    if (!top) throw new Error('TurboFit found no local model that fits this machine.');
    await selectHermesTurboFitRecommendation(harness, account, top.id);
  }
  plan = await readPlan(python, root, environment);
  const selected = plan.selected;
  if (!selected) throw new Error('TurboFit has no model selected.');
  const backend = await buildableBackend(plan.backend ?? 'cpu');
  if (backend !== plan.backend) plan = await readPlan(python, root, environment, backend);
  if (plan.unknown?.length) throw new Error(`TurboFit's ${plan.selected} names files it publishes no download for: ${plan.unknown.join(', ')}`);

  for (const runtime of plan.runtimes ?? []) {
    if (runtime.present) continue;
    if (!runtime.runtime) throw new Error(`TurboFit's ${plan.selected} needs ${runtime.binary}, which no pinned runtime builds.`);
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
    // it (and stops the model it was serving) when asked through this file.
    progress('switching TurboFit to the new model…');
    await writeFile(join(stateDir(environment), 'clikcode-restart'), new Date().toISOString());
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
      progress('starting TurboFit…');
      await startSupervisor(python, root, environment, backend);
      owned = true;
    }
  }
  await waitUntilServing(model, environment, owned, progress);
  progress('checking the local model can call tools…');
  const notice = await checkModel(model.replace(/^(?:custom:)?turbofit:/, ''), environment, selected);
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
