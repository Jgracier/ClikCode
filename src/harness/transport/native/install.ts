/**
 * Installing a harness the moment it is chosen or needed.
 *
 * One entry point, ensureHarnessInstalled, for every path that selects or
 * runs a harness: choosing it (/provider, /<harness>, the pickers, `sessions
 * set`, `send --harness`, the editor bridge) and, as a guard, every turn,
 * sign-in and vendor command before the binary is spawned -- on every
 * transport, the persistent ones included.
 *
 * What gets run is only ever what the catalog declares: the vendor's npm
 * package, or the vendor's own installer script from an https URL written in
 * the catalog. Nothing is derived from user input.
 *
 * - npm: `npm install --global`, unless npm's global prefix is not writable
 *   (system Node, a non-root container), in which case ClikCode's own prefix
 *   under its state directory -- no sudo. That prefix's bin directory is on
 *   PATH for every harness spawn (install-locations.ts).
 * - installer script: fetched, then run with no terminal: bash on Linux and
 *   macOS, PowerShell on Windows. Its binary is then looked for on PATH and in
 *   the directories the catalog says the script writes to.
 * - uv tool: the vendor's documented `uv tool install`, bootstrapping uv with
 *   Astral's official installer when it is missing.
 *
 * Two ClikCode processes choosing the same missing harness do not both
 * install it: a lock file under ClikCode's state directory makes the second
 * wait for the first, then find the binary already there.
 */

import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiHarnessInstallStep } from '../../definition.js';
import { stateDirectory } from '../../../session/store/paths.js';
import { TERMINAL } from '../../../tui/active-terminal.js';
import type { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import { installFailureTail, startSpinner } from '../../install-progress.js';
import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { resolveBinaryPath } from './binary.js';
import { addToProcessPath, expandInstallDir, managedNpmPrefix, npmPrefixBinDir } from './install-locations.js';
import { harnessInstallRoute, manualInstallCommand, type HarnessInstallRoute, type InstallSpec } from './install-route.js';

/** Who is shown an install happening. `start` when it begins (or begins
 * waiting on another process's install), `done` when the harness is there,
 * `failed` before the error is thrown to the caller, which reports it. */
export interface HarnessInstallReporter {
  start(label: string): void;
  done(message: string): void;
  failed(message: string): void;
}

let processReporter: HarnessInstallReporter | undefined;

/** For a process whose surface is not a terminal: the editor bridge shows
 * installs as its busy line and a notice. */
export function setHarnessInstallReporter(reporter: HarnessInstallReporter | undefined): void {
  processReporter = reporter;
}

/** The interactive terminal's waiting line when there is one; otherwise one
 * line on stderr, so `--json` output on stdout stays parseable. */
function defaultReporter(): HarnessInstallReporter {
  if (processReporter) return processReporter;
  const terminal = TERMINAL.active;
  if (terminal) return terminalInstallReporter(terminal);
  let spinner: ReturnType<typeof startSpinner> | undefined;
  const write = (text: string): void => { process.stderr.write(text); };
  return {
    start: (label) => { spinner?.stop(); spinner = startSpinner(label, write, process.stderr.isTTY); },
    done: (message) => { spinner?.stop(message); spinner = undefined; },
    failed: () => { spinner?.stop(); spinner = undefined; },
  };
}

/** An install on the terminal's waiting band. The wait starts once: a
 * second `start` (the wait for another process's install giving way to
 * this one's) only moves the label, which a fresh start set back to 0s; a
 * band already up -- the turn's -- is borrowed and given back. The outcome
 * is a notice, as the editor shows it. */
export function terminalInstallReporter(
  terminal: Pick<TerminalHarnessPrompter, 'startWaiting' | 'stopWaiting' | 'updateWaitingLabel' | 'waitingLabel' | 'notice'>,
): HarnessInstallReporter {
  let started = false;
  let borrowed: string | undefined;
  const end = (): void => {
    if (!started) return;
    started = false;
    if (borrowed !== undefined) terminal.updateWaitingLabel(borrowed);
    else terminal.stopWaiting();
  };
  return {
    start: (label) => {
      if (!started) {
        started = true;
        borrowed = terminal.waitingLabel();
        if (borrowed === undefined) { terminal.startWaiting(label); return; }
      }
      terminal.updateWaitingLabel(label);
    },
    done: (message) => { end(); terminal.notice(message); },
    failed: end,
  };
}

/** The binaries a harness needs: its CLI, and its ACP binary where that is a
 * separate executable (Mistral Vibe's `vibe-acp`). */
function requiredBinaries(spec: InstallSpec): string[] {
  return [...new Set([spec.binary, ...(spec.acp?.binary ? [spec.acp.binary] : [])])];
}

async function missingBinaries(spec: InstallSpec): Promise<string[]> {
  const missing: string[] = [];
  for (const binary of requiredBinaries(spec)) if (!await resolveBinaryPath(binary)) missing.push(binary);
  return missing;
}

/** Installs in flight in this process, so two turns asking at once share one. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Make sure a harness's binary is here, installing it if not. Resolves true
 * when it installed it just now, false when it was already installed; throws
 * with the reason (and a command to run by hand) when it cannot.
 */
export async function ensureHarnessInstalled(spec: InstallSpec, options: { reporter?: HarnessInstallReporter } = {}): Promise<boolean> {
  const route = harnessInstallRoute(spec);
  if (!(await missingBinaries(spec)).length) return false;
  if (route.kind === 'none') throw new Error(installFailureMessage(spec, route, new Error(route.reason)));
  const running = inFlight.get(spec.command);
  if (running) return running;
  const work = installOnce(spec, route, options.reporter ?? defaultReporter());
  inFlight.set(spec.command, work);
  try { return await work; } finally { inFlight.delete(spec.command); }
}

async function installOnce(spec: InstallSpec, route: Exclude<HarnessInstallRoute, { kind: 'none' }>, reporter: HarnessInstallReporter): Promise<boolean> {
  const label = `installing ${spec.displayName}…`;
  let shown = false;
  const show = (text: string): void => { shown = true; reporter.start(text); };
  try {
    const installed = await withInstallLock(spec.command, async () => {
      // Another process may have installed it while this one waited.
      if (!(await missingBinaries(spec)).length) return false;
      show(label);
      const missingBefore = await missingBinaries(spec);
      try {
        if (missingBefore.includes(spec.binary) || !spec.acp?.npmPackage) await runRoute(spec, route);
        if (spec.acp?.binary && spec.acp.npmPackage && missingBefore.includes(spec.acp.binary)) {
          await installNpmPackage(spec.acp.npmPackage);
        }
      } catch (error) {
        // Some official installers launch an optional sign-in immediately
        // after putting the binary in place. Cancelling that sign-in exits the
        // script nonzero, but the installation itself is complete.
        if (route.kind !== 'script' || (await missingBinaries(spec)).length) throw error;
      }
      const missing = await missingBinaries(spec);
      if (missing.length) {
        throw new Error(`the installer finished, but \`${missing.join('`, `')}\` is not on PATH or in ${searchedDirs(route).join(', ') || 'any directory it declares'}`);
      }
      return true;
    }, () => show(`waiting for another ClikCode to finish installing ${spec.displayName}…`));
    if (installed) reporter.done(`Installed ${spec.displayName}.`);
    else if (shown) reporter.done(`${spec.displayName} is installed.`);
    return installed;
  } catch (error) {
    const message = installFailureMessage(spec, route, error);
    if (shown) reporter.failed(message);
    throw new Error(message, { cause: error });
  }
}

function installFailureMessage(spec: InstallSpec, route: HarnessInstallRoute, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (route.kind === 'none') return `${reason} Then retry /${spec.command}.`;
  const manual = manualInstallCommand(route);
  const source = route.kind === 'npm' ? '' : ` (from ${spec.installer?.docs ?? 'the vendor'})`;
  return `Could not install ${spec.displayName} automatically: ${reason}`
    + (manual ? `\n\nTo install it yourself${source}:\n\n    ${manual}\n\nThen retry /${spec.command}.` : '');
}

function searchedDirs(route: HarnessInstallRoute): string[] {
  if (route.kind === 'script' || route.kind === 'uv-tool') {
    return route.step.binDirs.map((dir) => expandInstallDir(dir)).filter((dir): dir is string => Boolean(dir));
  }
  return [];
}

async function runRoute(spec: InstallSpec, route: Exclude<HarnessInstallRoute, { kind: 'none' }>): Promise<void> {
  if (route.kind === 'npm') return installNpmPackage(route.package);
  // The declared directories are already on PATH from startup; this also
  // covers one whose variable appeared since (a Windows %LOCALAPPDATA%).
  addToProcessPath(searchedDirs(route));
  if (route.kind === 'script') return runInstallerScript(route.step);
  return installUvTool(route.step);
}

// ---------------------------------------------------------------------------
// npm

interface Captured { code: number | null; output: string }

/** Run a command with no terminal, output captured, bounded in time. On
 * POSIX the child leads its own session, so an installer that opens
 * /dev/tty to ask a question gets no terminal instead of the user's keyboard
 * under ClikCode's screen. */
export function runInstallCommand(
  command: string, args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 256_000) output = output.slice(-128_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      output += `\n${command} did not finish within ${Math.round((options.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60_000)} minutes and was stopped.`;
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { terminatePortable(child, 'SIGKILL'); } }
      else terminatePortable(child, 'SIGKILL');
    }, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

const INSTALL_TIMEOUT_MS = 20 * 60_000;

function commandFailure(what: string, result: Captured): Error {
  const tail = installFailureTail(result.output);
  return new Error(`${what} exited ${result.code ?? 'abnormally'}${tail ? `\n${tail}` : ''}`);
}

/** Where `npm install --global` writes, or undefined when npm cannot say. */
async function npmGlobalPrefix(): Promise<string | undefined> {
  try {
    const result = await runInstallCommand('npm', ['prefix', '--global'], { timeoutMs: 60_000 });
    const prefix = result.output.trim().split(/\r?\n/).pop()?.trim();
    return result.code === 0 && prefix ? prefix : undefined;
  } catch { return undefined; }
}

/** Whether this user can write where a global install goes: the prefix's
 * package directory and its bin directory (or, where one does not exist yet,
 * the nearest directory that does). */
export async function npmPrefixWritable(prefix: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const targets = platform === 'win32' ? [join(prefix, 'node_modules'), prefix] : [join(prefix, 'lib', 'node_modules'), join(prefix, 'bin')];
  for (const target of targets) {
    let candidate = target;
    for (;;) {
      try {
        await stat(candidate);
        break;
      } catch {
        const parent = dirname(candidate);
        if (parent === candidate) return false;
        candidate = parent;
      }
    }
    try { await access(candidate, constants.W_OK); } catch { return false; }
  }
  return true;
}

/** An npm failure that means "not allowed to write there", which a private
 * prefix fixes -- as opposed to a bad package or no network, which it does not. */
export function isPermissionFailure(output: string): boolean {
  return /\b(EACCES|EPERM|EROFS)\b|permission denied|read-only file system/i.test(output);
}

async function installNpmPackage(npmPackage: string): Promise<void> {
  const globalPrefix = await npmGlobalPrefix();
  if (globalPrefix && await npmPrefixWritable(globalPrefix)) {
    const result = await runInstallCommand('npm', ['install', '--global', npmPackage]);
    if (result.code === 0) {
      // A global prefix that is writable but not on PATH (a user-level
      // prefix set in .npmrc and never exported) is still where it went.
      addToProcessPath([npmPrefixBinDir(globalPrefix)]);
      return;
    }
    if (!isPermissionFailure(result.output)) throw commandFailure(`npm install --global ${npmPackage}`, result);
  }
  const prefix = managedNpmPrefix();
  await mkdir(prefix, { recursive: true });
  const result = await runInstallCommand('npm', ['install', '--global', '--prefix', prefix, npmPackage]);
  if (result.code !== 0) throw commandFailure(`npm install --global --prefix ${prefix} ${npmPackage}`, result);
  addToProcessPath([npmPrefixBinDir(prefix)]);
}

// ---------------------------------------------------------------------------
// installer scripts

/** Only an https URL is ever fetched and run. */
export function assertInstallerUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`installer URL is not a URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`refusing to run an installer from a non-https URL: ${url}`);
  return parsed;
}

async function downloadInstaller(url: string, destination: string): Promise<void> {
  assertInstallerUrl(url);
  let body: string | undefined;
  let fetchError: unknown;
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    // A redirect that left https is refused just the same.
    assertInstallerUrl(response.url || url);
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    body = await response.text();
  } catch (error) { fetchError = error; }
  // Node's fetch ignores HTTPS_PROXY; curl (on every supported OS, Windows 10
  // and later included) does not, and is what the vendors' own one-liners use.
  if (body === undefined) {
    const result = await runInstallCommand('curl', ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '-o', destination, url], { timeoutMs: 180_000 })
      .catch(() => undefined);
    if (result?.code === 0) return;
    throw new Error(`could not download ${url}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
  }
  if (!body.trim()) throw new Error(`${url} returned an empty installer`);
  await writeFile(destination, body, { mode: 0o700 });
}

async function firstOnPath(names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await resolveBinaryPath(name)) return name;
  return undefined;
}

async function runInstallerScript(step: Extract<AiHarnessInstallStep, { kind: 'script' }>): Promise<void> {
  const windows = process.platform === 'win32';
  const directory = await mkdtemp(join(tmpdir(), 'clikcode-install-'));
  try {
    const script = join(directory, windows ? 'install.ps1' : 'install.sh');
    await downloadInstaller(step.url, script);
    const env = { ...process.env, ...(step.env ?? {}) };
    let command: string;
    let args: string[];
    if (windows) {
      command = (await firstOnPath(['pwsh', 'powershell'])) ?? 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(step.args ?? [])];
    } else {
      command = (await firstOnPath(['bash', 'sh'])) ?? 'sh';
      args = [script, ...(step.args ?? [])];
    }
    const result = await runInstallCommand(command, args, { env, cwd: directory });
    if (result.code !== 0) throw commandFailure(`the installer from ${step.url}`, result);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// uv tool

/** Astral's official uv installers, for a vendor whose documented install is
 * `uv tool install` on a machine without uv. */
const UV_INSTALLER = {
  posix: 'https://astral.sh/uv/install.sh',
  windows: 'https://astral.sh/uv/install.ps1',
} as const;

async function installUvTool(step: Extract<AiHarnessInstallStep, { kind: 'uv-tool' }>): Promise<void> {
  // Where Astral's installer puts uv (and uv puts tools) by default.
  addToProcessPath([join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')]);
  if (!await resolveBinaryPath('uv')) {
    await runInstallerScript({
      kind: 'script',
      url: process.platform === 'win32' ? UV_INSTALLER.windows : UV_INSTALLER.posix,
      // ClikCode finds ~/.local/bin itself; the user's shell profile is left alone.
      env: { UV_NO_MODIFY_PATH: '1' },
      binDirs: ['~/.local/bin'],
    });
    if (!await resolveBinaryPath('uv')) throw new Error('uv was installed but cannot be found in ~/.local/bin');
  }
  const installArgv = ['tool', 'install', ...(step.python ? ['--python', step.python] : []), step.package,
    ...(step.with ?? []).flatMap((name) => ['--with', name])];
  const result = await runInstallCommand('uv', installArgv);
  if (result.code !== 0) throw commandFailure(`uv ${installArgv.join(' ')}`, result);
  const bin = await runInstallCommand('uv', ['tool', 'dir', '--bin'], { timeoutMs: 60_000 }).catch(() => undefined);
  const dir = bin?.code === 0 ? bin.output.trim().split(/\r?\n/).pop()?.trim() : undefined;
  if (dir) addToProcessPath([dir]);
}

// ---------------------------------------------------------------------------
// the cross-process lock

const LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 5 * 60_000;
const LOCK_POLL_MS = 250;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Longest a live holder is waited on before the install gives up with a clear error. */
const LOCK_MAX_WAIT_MS = 10 * 60 * 1000;

/** Run `work` holding the per-harness install lock -- a directory, since
 * creating one is atomic everywhere. A holder that died, or has held it past
 * any install's time limit, is taken over. `onWait` is called once, if the
 * lock is busy. */
export async function withInstallLock<T>(
  key: string, work: () => Promise<T>, onWait?: () => void,
  options: { directory?: string; staleMs?: number; pollMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const directory = options.directory ?? join(stateDirectory(), 'tools', 'locks');
  await mkdir(directory, { recursive: true });
  const lock = join(directory, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  const owner = join(lock, 'owner.json');
  let waited = false;
  const waitStarted = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(owner, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: { pid?: number; at?: number } | undefined;
    try { holder = JSON.parse(await readFile(owner, 'utf8')) as { pid?: number; at?: number }; } catch { holder = undefined; }
    const since = holder?.at ?? (await stat(lock).then((info) => info.mtimeMs).catch(() => Date.now()));
    const dead = holder?.pid !== undefined && !processAlive(holder.pid);
    if (dead || Date.now() - since > (options.staleMs ?? LOCK_STALE_MS)) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (!waited) { waited = true; onWait?.(); }
    // A live holder is never taken over (it may still be installing), but it
    // must not block every other install forever either.
    if (Date.now() - waitStarted > (options.maxWaitMs ?? LOCK_MAX_WAIT_MS)) {
      throw new Error(`another ClikCode install of ${key} is still running (pid ${holder?.pid ?? 'unknown'}); try again once it finishes`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? LOCK_POLL_MS));
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }).catch(() => undefined); }
}
