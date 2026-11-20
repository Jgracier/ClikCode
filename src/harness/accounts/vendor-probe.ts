/** Every vendor process ClikCode starts on its own -- session listings,
 * model catalogs, slash-command probes, usage probes, identity reads,
 * version checks, warm-ups -- runs here, and nothing it runs can sign in.
 *
 * The rule: a harness opens a sign-in only when the user is adding an
 * account. A background run therefore
 * - is refused, as `signed-out`, unless the profile it runs under has a
 *   credential on disk or a key in its environment (the catalog's
 *   `authFiles`/`authEnv`; `signInOptional` vendors need none). Kiro CLI's
 *   `chat --list-sessions`, run signed out, opened app.kiro.dev/signin in
 *   Firefox and waited 20 minutes for it.
 * - has a deadline that ends its whole process group (SIGTERM, then SIGKILL);
 * - is detached from the terminal and reads no stdin (a prompt reads EOF);
 * - finds a browser opener that does nothing, on PATH and in BROWSER, and no
 *   DISPLAY, WAYLAND_DISPLAY or D-Bus session (`keyringAuth` vendors keep
 *   D-Bus: their token is in the keyring), so no window, keyring unlock
 *   prompt or desktop-portal browser can appear.
 * Every fetch a probe makes carries a timeout too. */

import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stateDirectory } from '../../session/store/paths.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import { killProcessTreePortable, spawnPortable } from '../transport/spawn.js';
import { JsonRpcPeer, type JsonRpcPeerOptions } from '../transport/jsonrpc-peer.js';
import { failureText } from '../protocol/stderr-line.js';
import { authEvidencePresent, hasAuthEvidence } from './auth-files.js';
import { BROWSER_OPENERS } from '../../gateway/login/link-info.js';

type Environment = Readonly<Record<string, string>>;

/** The longest one vendor process may take to answer a probe. Claude's
 * `/usage` takes ~4s; Kimi's web server ~2s to start. */
export const PROBE_DEADLINE_MS = 30_000;
/** The longest a vendor may take to import or export one thread (OpenCode's
 * `import`, OpenClaw's `doctor ... import`): a database write, not a turn. */
export const VENDOR_IMPORT_DEADLINE_MS = 60_000;
/** A `--version` or `--help`: printed at once, or the binary is broken. */
export const INERT_DEADLINE_MS = 10_000;
/** A helper reading the OS keyring (and at most one HTTP call with it). */
export const KEYRING_DEADLINE_MS = 20_000;
/** The longest one HTTP call of a probe may take. */
const PROBE_FETCH_MS = 15_000;
/** Between SIGTERM to the group and SIGKILL to what is left of it. */
const KILL_GRACE_MS = 2_000;
/** A runaway guard on what one background command may print, not a size
 * budget: OpenClaw's `plugins list --json` is ~105 KiB. */
const CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const STDERR_KEEP = 256 * 1024;

/** What a harness's catalog entry says about signing in: all the gate reads. */
export type GateHarness = Pick<AiLocalHarnessDefinition, 'command' | 'binary' | 'authFiles' | 'authEnv' | 'authKeychain' | 'profileEnv' | 'signInOptional' | 'keyringAuth'>;
/** Who may run: a harness, behind its credential check, or a command that
 * cannot sign in whatever the profile holds (`--version`, `--help`, a
 * keyring read by a helper that is not the vendor), with the reason. */
export type VendorGate = GateHarness | { inert: string; keyring?: boolean };

/** What a background vendor run came to. */
export type VendorOutcome<T> =
  | { status: 'ok'; value: T }
  /** Refused before anything was started: no credential evidence. */
  | { status: 'signed-out' }
  /** The binary is not installed. */
  | { status: 'missing' }
  | { status: 'failed'; reason: 'timeout' | 'spawn' | 'error' | 'cancelled'; detail?: string };

export type VendorRefusal = Exclude<VendorOutcome<unknown>, { status: 'ok' }>;

/** A background run that did not answer, carrying why. */
export class BackgroundVendorError extends Error {
  constructor(readonly outcome: VendorRefusal, binary: string) {
    super(outcome.status === 'failed' ? (outcome.detail ?? `${binary} ${outcome.reason}`) : `${binary}: ${outcome.status}`);
    this.name = 'BackgroundVendorError';
  }
}

/** Whether `error` is a background run refused for want of a sign-in. */
export function isSignedOutRefusal(error: unknown): boolean {
  return error instanceof BackgroundVendorError && error.outcome.status === 'signed-out';
}

/** Everything a stand-in browser opener answers to. */
const NO_OP_OPENERS = [...new Set<string>([
  ...BROWSER_OPENERS, 'gvfs-open', 'gnome-open', 'kde-open', 'kde-open5', 'kfmclient', 'wslview', 'exo-open',
  'firefox', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge',
  'lynx', 'w3m', 'links', 'elinks',
])];

/** A directory of browser openers that do nothing, made once. */
function noBrowserDirectory(): string | undefined {
  const directory = join(stateDirectory(), 'tools', 'probe-no-browser');
  try {
    for (const name of NO_OP_OPENERS) {
      const file = join(directory, name);
      if (existsSync(file)) continue;
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    return directory;
  } catch { return undefined; } // fail-open-ok: without the stand-ins the deadline still ends the run, and no display reaches it
}

/** `environment` with every browser opener a no-op (POSIX only: Windows
 * opens through the shell, which a variable does not redirect). */
export function probeEnvironment(environment: Environment): Record<string, string> {
  if (process.platform === 'win32') return { ...environment };
  const directory = noBrowserDirectory();
  if (!directory) return { ...environment };
  return {
    ...environment,
    BROWSER: join(directory, 'xdg-open'),
    PATH: [directory, environment.PATH ?? process.env.PATH].filter(Boolean).join(delimiter),
  };
}

/** The whole environment a background vendor process gets: the process's
 * own under `environment`'s overrides, with no way to a display, a desktop
 * session bus (unless `keyring`), or a browser. */
export function backgroundEnvironment(environment: Environment, options: { keyring?: boolean } = {}): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, ...environment })) if (value !== undefined) merged[name] = value;
  delete merged.DISPLAY;
  delete merged.WAYLAND_DISPLAY;
  delete merged.XAUTHORITY;
  // Pointed nowhere rather than deleted: with no address, libdbus and sd-bus
  // fall back to $XDG_RUNTIME_DIR/bus, the user's own session bus.
  if (!options.keyring) merged.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
  return probeEnvironment(merged);
}

function gateKeyring(gate: VendorGate): boolean {
  return 'inert' in gate ? Boolean(gate.keyring) : Boolean(gate.keyringAuth);
}

/** `fetch` that gives up after PROBE_FETCH_MS (or on `init.signal`). */
export function probeFetch(url: string, init: RequestInit = {}, timeoutMs = PROBE_FETCH_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

/** Whether a command that signs in when signed out may be run for this
 * profile: only with a credential on disk or a key in its environment. A
 * vendor with nothing declared to look for is never asked such a command. */
export async function mayRunSignInCapable(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles' | 'authEnv'> & Partial<Pick<AiLocalHarnessDefinition, 'authKeychain' | 'profileEnv'>>, environment: Environment,
): Promise<boolean> {
  return hasAuthEvidence(harness) && await authEvidencePresent(harness, environment);
}

/** The gate: whether a background run of `gate` may start under
 * `environment` (the profile's overrides; the process's own beneath). */
export async function mayRunInBackground(gate: VendorGate, environment: Environment): Promise<boolean> {
  if ('inert' in gate) return true;
  if (gate.signInOptional) return true;
  return mayRunSignInCapable(gate, environment);
}

export interface VendorProcessSpec {
  /** Required: who is run, and so whether it may be. */
  gate: VendorGate;
  /** Default: the gate harness's own binary. */
  binary?: string;
  argv: readonly string[];
  /** The profile's overrides; the process's environment is beneath them. */
  environment: Environment;
  /** Required: when the process group is ended and the run answers nothing. */
  deadlineMs: number;
  /** 'pipe' for a JSON-RPC server, which reads requests from stdin. Default
   * 'ignore': a question the vendor asks reads EOF. */
  stdin?: 'ignore' | 'pipe';
  cwd?: string;
  /** Ends the run early (the user's cancel). */
  signal?: AbortSignal;
}

function gateBinary(spec: Pick<VendorProcessSpec, 'gate' | 'binary'>): string {
  const binary = spec.binary ?? ('inert' in spec.gate ? undefined : spec.gate.binary);
  if (!binary) throw new Error('A background vendor run needs a binary');
  return binary;
}

/** Runs one vendor process for `use`, behind the gate, then ends its
 * process group. `use`'s signal aborts at the deadline. */
export async function runVendorProcess<T>(
  spec: VendorProcessSpec, use: (child: ChildProcess, signal: AbortSignal) => Promise<T>,
): Promise<VendorOutcome<T>> {
  if (spec.signal?.aborted) return { status: 'failed', reason: 'cancelled' };
  if (!await mayRunInBackground(spec.gate, spec.environment)) return { status: 'signed-out' };
  const binary = gateBinary(spec);
  const executable = await resolveBinaryPath(binary);
  if (!executable) return { status: 'missing' };
  const detached = process.platform !== 'win32';
  let child: ChildProcess;
  try {
    child = spawnPortable(executable, [...spec.argv], {
      stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe'],
      env: backgroundEnvironment(spec.environment, { keyring: gateKeyring(spec.gate) }),
      detached, windowsHide: true,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    });
  } catch (error) {
    return { status: 'failed', reason: 'spawn', detail: error instanceof Error ? error.message : String(error) };
  }
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  type Settled = VendorOutcome<T>;
  const deadline = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'failed', reason: 'timeout', detail: `${binary} did not answer within ${spec.deadlineMs} ms` });
    }, spec.deadlineMs);
  });
  const onCancel = (): void => controller.abort();
  const cancelled = new Promise<Settled>((resolve) => {
    spec.signal?.addEventListener('abort', () => { onCancel(); resolve({ status: 'failed', reason: 'cancelled' }); }, { once: true });
  });
  const failed = new Promise<Settled>((resolve) => {
    child.once('error', (error) => resolve({ status: 'failed', reason: 'spawn', detail: error.message }));
  });
  const answered = use(child, controller.signal).then(
    (value): Settled => ({ status: 'ok', value }),
    (error: unknown): Settled => ({ status: 'failed', reason: 'error', detail: error instanceof Error ? error.message : String(error) }),
  );
  try {
    return await Promise.race([answered, deadline, cancelled, failed]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    stopGroup(child, detached);
  }
}

/** Runs one vendor process for `use`, then ends its process group. Undefined
 * when it was refused (no sign-in), the binary is missing, it fails to
 * start, `use` throws or answers nothing, or the deadline passes first. */
export async function probeVendor<T>(
  spec: VendorProcessSpec, use: (child: ChildProcess, signal: AbortSignal) => Promise<T | undefined>,
): Promise<T | undefined> {
  const outcome = await runVendorProcess(spec, (child, signal) => {
    // Read, or a full pipe stalls a vendor that writes to it.
    child.stderr?.resume();
    return use(child, signal);
  });
  return outcome.status === 'ok' ? outcome.value : undefined;
}

/** SIGTERM to the group, SIGKILL to whatever is left a moment later. */
function stopGroup(child: ChildProcess, detached: boolean): void {
  killProcessTreePortable(child, 'SIGTERM', detached);
  const pid = child.pid;
  if (!detached || !pid) return;
  const kill = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* fail-open-ok: gone */ } }, KILL_GRACE_MS);
  kill.unref();
}

/** What a background command printed. */
export interface VendorCommandOutput { stdout: string; stderr: string }

export type VendorCommandSpec = Omit<VendorProcessSpec, 'stdin'> & {
  /** Answers a vendor that asks a question (written, then stdin closed). */
  stdinText?: string;
};

/** One background command, its output kept: ok only when it exits 0 before
 * the deadline; otherwise `failed` with what it said on stderr. */
export function runVendorCommand(spec: VendorCommandSpec): Promise<VendorOutcome<VendorCommandOutput>> {
  const binary = gateBinary(spec);
  return runVendorProcess({ ...spec, stdin: spec.stdinText === undefined ? 'ignore' : 'pipe' }, (child) => new Promise<VendorCommandOutput>((resolve, reject) => {
    if (spec.stdinText !== undefined) child.stdin?.end(spec.stdinText);
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > CAPTURE_LIMIT_BYTES && !exceeded) {
        exceeded = true;
        killProcessTreePortable(child, 'SIGKILL', process.platform !== 'win32');
      }
    });
    // The newest output is kept: the cause is where the process stopped.
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
    // `close`, not `exit`: exit can fire before the stdout pipe has drained.
    child.once('close', (code, killedBy) => {
      if (exceeded) return reject(new Error(`${binary} printed more than ${CAPTURE_LIMIT_BYTES / 1024 / 1024} MiB`));
      if (code === 0) return resolve({ stdout, stderr });
      const why = failureText(stderr);
      reject(new Error(`${binary} ${killedBy ? `stopped (${killedBy})` : `exited ${code ?? 1}`}${why ? `: ${why}` : ''}`));
    });
  }));
}

/** A background command's output -- stdout, or stderr when it wrote only
 * that (Codex's `login status`) -- or a BackgroundVendorError saying why
 * there is none. */
export async function vendorCommandText(spec: VendorCommandSpec): Promise<string> {
  const outcome = await runVendorCommand(spec);
  if (outcome.status !== 'ok') throw new BackgroundVendorError(outcome, gateBinary(spec));
  const { stdout, stderr } = outcome.value;
  return stdout.trim() ? stdout : (stderr.trim() ? stderr : stdout);
}

/** A probe command's stdout, when it exits 0 before the deadline. */
export async function probeCommand(gate: GateHarness, argv: readonly string[], environment: Environment, deadlineMs = PROBE_DEADLINE_MS): Promise<string | undefined> {
  const outcome = await runVendorCommand({ gate, argv, environment, deadlineMs });
  return outcome.status === 'ok' ? outcome.value.stdout : undefined;
}

/** A JSON-RPC server a probe asks a few questions of (Codex's app-server,
 * Copilot's SDK server), then lets go: queryAcp's shape, any framing. */
export function queryJsonRpc<T>(
  spec: Omit<VendorProcessSpec, 'stdin'> & Pick<JsonRpcPeerOptions, 'label' | 'jsonrpcVersion' | 'framing'>,
  ask: (peer: JsonRpcPeer, signal: AbortSignal) => Promise<T | undefined>,
): Promise<T | undefined> {
  return probeVendor({ ...spec, stdin: 'pipe' }, async (child, signal) => {
    const peer = new JsonRpcPeer(child, {
      label: spec.label, detached: process.platform !== 'win32', forwardParentSignals: false,
      ...(spec.jsonrpcVersion === undefined ? {} : { jsonrpcVersion: spec.jsonrpcVersion }),
      ...(spec.framing ? { framing: spec.framing } : {}),
    });
    // The deadline ends the process group; this ends what is waiting on it.
    signal.addEventListener('abort', () => peer.rejectPending(new Error(`${spec.label} probe timed out`)), { once: true });
    return ask(peer, signal);
  });
}
