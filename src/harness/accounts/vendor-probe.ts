/** Asking a vendor CLI something in the background -- its usage, its plan --
 * with nothing it can hang on and nothing it can open.
 *
 * Every probe used to spawn and fetch on its own, and none had a deadline:
 * one vendor that never answered held that account's usage pending for the
 * life of the process, and an explicit `/usage` waited forever. A signed-out
 * profile asked `agy models` or `cursor status` could start the vendor's own
 * sign-in. Here every probe has a deadline that ends its whole process group,
 * reads no stdin (a prompt reads EOF), and finds a browser opener that does
 * nothing; every fetch carries a timeout. */

import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stateDirectory } from '../../session/store/paths.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import { killProcessTreePortable, spawnPortable } from '../transport/spawn.js';
import { JsonRpcPeer, type JsonRpcPeerOptions } from '../transport/jsonrpc-peer.js';
import { authEvidencePresent, hasAuthEvidence } from './auth-files.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { BROWSER_OPENERS } from '../../gateway/login/link-info.js';

type Environment = Readonly<Record<string, string>>;

/** The longest one vendor process may take to answer a probe. Claude's
 * `/usage` takes ~4s; Kimi's web server ~2s to start. */
export const PROBE_DEADLINE_MS = 30_000;
/** The longest one HTTP call of a probe may take. */
const PROBE_FETCH_MS = 15_000;


/** A directory of browser openers that do nothing, made once. */
function noBrowserDirectory(): string | undefined {
  const directory = join(stateDirectory(), 'tools', 'probe-no-browser');
  try {
    for (const name of BROWSER_OPENERS) {
      const file = join(directory, name);
      if (existsSync(file)) continue;
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    return directory;
  } catch { return undefined; } // fail-open-ok: without the stand-ins the deadline still ends the probe
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

/** `fetch` that gives up after PROBE_FETCH_MS (or on `init.signal`). */
export function probeFetch(url: string, init: RequestInit = {}, timeoutMs = PROBE_FETCH_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

/** Whether a command that signs in when signed out may be run for this
 * profile: only with a credential on disk or a key in its environment. A
 * vendor with nothing declared to look for is never asked such a command. */
export async function mayRunSignInCapable(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles' | 'authEnv'>, environment: Environment,
): Promise<boolean> {
  return hasAuthEvidence(harness) && await authEvidencePresent(harness, environment);
}

interface VendorProbeSpec {
  binary: string;
  argv: readonly string[];
  environment: Environment;
  /** Required: when the process group is ended and the probe answers nothing. */
  deadlineMs: number;
  /** 'pipe' for a JSON-RPC server, which reads requests from stdin. Default
   * 'ignore': a question the vendor asks reads EOF. */
  stdin?: 'ignore' | 'pipe';
}

/** Runs one vendor process for `use`, then ends its process group. Undefined
 * when the binary is missing, it fails to start, `use` throws, or the
 * deadline passes first; `signal` aborts at the deadline. */
export async function probeVendor<T>(
  spec: VendorProbeSpec, use: (child: ChildProcess, signal: AbortSignal) => Promise<T | undefined>,
): Promise<T | undefined> {
  const executable = await resolveBinaryPath(spec.binary);
  if (!executable) return undefined;
  const detached = process.platform !== 'win32';
  const child = spawnPortable(executable, [...spec.argv], {
    stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...probeEnvironment(spec.environment) }, detached,
  });
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  // Read, or a full pipe stalls a vendor that writes to it.
  child.stderr?.resume();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined); }, spec.deadlineMs);
  });
  const failed = new Promise<undefined>((resolve) => { child.once('error', () => resolve(undefined)); });
  try {
    return await Promise.race([use(child, controller.signal).catch(quiet('harness/accounts/vendor-probe')), deadline, failed]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    stop(child, detached);
  }
}

/** SIGTERM to the group, SIGKILL to whatever is left a moment later. */
function stop(child: ChildProcess, detached: boolean): void {
  killProcessTreePortable(child, 'SIGTERM', detached);
  const pid = child.pid;
  if (!detached || !pid) return;
  const kill = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* fail-open-ok: gone */ } }, 2_000);
  kill.unref();
}

/** A probe command's stdout, when it exits 0 before the deadline. */
export function probeCommand(binary: string, argv: readonly string[], environment: Environment, deadlineMs = PROBE_DEADLINE_MS): Promise<string | undefined> {
  return probeVendor({ binary, argv, environment, deadlineMs }, (child) => new Promise<string | undefined>((resolve) => {
    let stdout = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
    child.once('close', (code) => resolve(code === 0 ? stdout : undefined));
  }));
}

/** A JSON-RPC server a probe asks a few questions of (Codex's app-server,
 * Copilot's SDK server), then lets go: queryAcp's shape, any framing. */
export function queryJsonRpc<T>(
  spec: Omit<VendorProbeSpec, 'stdin'> & Pick<JsonRpcPeerOptions, 'label' | 'jsonrpcVersion' | 'framing'>,
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
