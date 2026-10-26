/** Asking an agent's ACP server a few questions, then letting it go.
 *
 * Some vendors publish their lists only over ACP: Goose's providers and which
 * are signed in (`_goose/unstable/providers/*`), Cline's models (the
 * `session/new` result). One short-lived child answers them; nothing is
 * prompted, so no turn is spent. */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoveryCleanup } from './discovery-cleanup.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { stateDirectory } from '../../session/store/paths.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import { JsonRpcPeer } from '../transport/jsonrpc-peer.js';
import { spawnPortable } from '../transport/spawn.js';
import { processesWithEnvironment } from '../transport/process-group.js';
import { vendorMcpServerNames } from '../../agent/mcp/import.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

type Json = Record<string, any>;

/** Runs `ask` against an initialized ACP peer and always shuts it down.
 * Undefined when the binary is missing or the server exits or errors before
 * answering. These are bounded metadata probes, never conversation turns. */
export async function queryAcp<T>(
  binary: string, argv: readonly string[], environment: Readonly<Record<string, string>>,
  ask: (request: (method: string, params?: Json) => Promise<Json>, capabilities: Json) => Promise<T>,
  timeoutMs = 30_000,
  options: { signal?: AbortSignal; onNotification?: (method: string, params: Json) => void; cwd?: string; discovery?: AiLocalHarnessDefinition } = {},
): Promise<T | undefined> {
  if (options.signal?.aborted) return undefined;
  const executable = await resolveBinaryPath(binary);
  if (!executable) return undefined;
  const detached = process.platform !== 'win32';
  // Everything this query starts carries the tag, so what escaped the
  // process group can still be found and stopped (see below).
  const tag = randomBytes(8).toString('hex');
  const child = spawnPortable(executable, [...argv], {
    env: { ...process.env, ...environment, [QUERY_TAG]: tag }, stdio: ['pipe', 'pipe', 'pipe'], detached,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const peer = new JsonRpcPeer(child, { label: `${binary} ACP`, detached, forwardParentSignals: false, onNotification: options.onNotification });
  const signal = options.signal;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= peer.shutdown({ graceMs: 500, killMs: 1000 }).catch(() => undefined);
  const abort = (): void => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, timeoutMs);
  deadline.unref();
  let capabilities: Json = {};
  let remove: ((id: string, cwd: string) => Promise<void>) | undefined;
  const created = new Map<string, string>();
  const request = async (method: string, params: Json = {}): Promise<Json> => {
    if (method === 'session/new') {
      if (!options.discovery) throw new Error('Metadata sessions need an owned cleanup lifecycle');
      if (!capabilities.sessionCapabilities?.delete) {
        remove ??= await discoveryCleanup(options.discovery, environment);
        if (!remove) throw new Error('This vendor cannot clean up a metadata session');
      }
    }
    const result = await peer.request(method, params, { timeoutMs });
    if (method === 'session/new' && typeof result.sessionId === 'string') created.set(result.sessionId, String(params.cwd ?? ''));
    return result;
  };
  try {
    if (signal?.aborted) return undefined;
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    capabilities = (initialized.agentCapabilities as Json | undefined) ?? {};
    return await ask(request, capabilities);
  } catch {
    return undefined;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    if (capabilities.sessionCapabilities?.delete && !peer.closed) {
      for (const id of created.keys()) {
        try { await peer.request('session/delete', { sessionId: id }, { timeoutMs: 1_000 }); created.delete(id); }
        catch { /* local cleanup after shutdown, where supported */ }
      }
    }
    await close();
    await stopEscaped(tag).catch(() => undefined);
    for (const [id, cwd] of created) {
      try {
        if (!remove && options.discovery) remove = await discoveryCleanup(options.discovery, environment);
        if (!remove) throw new Error('No local cleanup after the vendor delete failed');
        await remove(id, cwd);
      }
      catch { lifecycle('vendor.discovery-cleanup-failed', { harness: options.discovery?.command }); }
    }
  }
}

const QUERY_TAG = 'CLIKCODE_ACP_QUERY';

/** What the query started that outlived the group's shutdown: Cline's hub
 * daemon moves to a session of its own and was left running for days. A
 * daemon that was already up (the user's) never carries this query's tag. */
async function stopEscaped(tag: string): Promise<void> {
  const signal = (pids: number[], name: NodeJS.Signals): void => {
    for (const pid of pids) { try { process.kill(pid, name); } catch { /* gone already */ } }
  };
  const escaped = await processesWithEnvironment(QUERY_TAG, tag);
  if (!escaped.length) return;
  signal(escaped, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  signal(await processesWithEnvironment(QUERY_TAG, tag), 'SIGKILL');
}

/** Where the model-list session runs. Not the user's home or any project, so
 * no vendor files it under a folder the user works in, and ClikCode leaves
 * chats from here out of its conversation list. */
export function acpDiscoveryDirectory(): string {
  return join(stateDirectory(), 'model-discovery');
}

/** A temporary metadata session, owned and removed by queryAcp. The model
 * catalog caches the answer; no persistent session cache or cache lock is needed. */
export async function acpDiscoverySession(
  request: (method: string, params?: Json) => Promise<Json>,
): Promise<Json> {
  const cwd = acpDiscoveryDirectory();
  await mkdir(cwd, { recursive: true });
  return request('session/new', { cwd, mcpServers: [] });
}

/** The models an agent's `session/new` offers, with their display names. */
export function acpSessionModels(result: Json | undefined): { models: string[]; labels: Record<string, string>; current?: string } {
  const available: unknown[] = Array.isArray(result?.models?.availableModels) ? result!.models.availableModels : [];
  const models: string[] = [];
  const labels: Record<string, string> = {};
  for (const entry of available) {
    const { modelId, name } = (entry ?? {}) as { modelId?: unknown; name?: unknown };
    if (typeof modelId !== 'string' || !modelId) continue;
    models.push(modelId);
    if (typeof name === 'string' && name && name !== modelId) labels[modelId] = name;
  }
  const current = typeof result?.models?.currentModelId === 'string' ? result.models.currentModelId as string : undefined;
  const modelOption = Array.isArray(result?.configOptions)
    ? result!.configOptions.find((option: Json) => (option?.id ?? option?.configId) === 'model')
    : undefined;
  if (models.length === 0 && Array.isArray(modelOption?.options)) {
    for (const option of modelOption.options) {
      if (typeof option?.value !== 'string' || !option.value) continue;
      models.push(option.value);
      if (typeof option.name === 'string' && option.name && option.name !== option.value) labels[option.value] = option.name;
    }
  }
  const configured = typeof modelOption?.currentValue === 'string' && modelOption.currentValue
    ? modelOption.currentValue
    : undefined;
  return { models, labels, ...((current ?? configured) ? { current: current ?? configured } : {}) };
}

/** The values an agent's session offers for one config option (Goose's
 * `thinking_effort`), flat or grouped as ACP allows. */
export function acpConfigOptionValues(result: Json | undefined, configId: string): string[] {
  const option = Array.isArray(result?.configOptions)
    ? result!.configOptions.find((entry: Json) => (entry?.id ?? entry?.configId) === configId)
    : undefined;
  const values: string[] = [];
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries as Json[]) {
      if (Array.isArray(entry?.options)) visit(entry.options);
      else if (typeof entry?.value === 'string' && entry.value && !values.includes(entry.value)) values.push(entry.value);
    }
  };
  visit(option?.options);
  return values;
}

/** The extra argv for an ACP agent started only to be asked something: its
 * switch that keeps the user's MCP servers from starting. Where the vendor
 * has only a per-server switch (Copilot), every server its config names is
 * switched off one by one. A server left running here is not only a wasted
 * process -- one that needs a sign-in makes Copilot open the browser. */
export async function acpProbeArgv(
  harness: Pick<AiLocalHarnessDefinition, 'command' | 'acp'>, account?: Pick<AiHarnessAccount, 'nativeProfile'>, home: string = homedir(),
): Promise<string[]> {
  const fixed = [...harness.acp?.probeArgv ?? []];
  const prefix = harness.acp?.probeDisableMcpPrefix;
  if (!prefix?.length) return fixed;
  const profile = account?.nativeProfile ? { env: account.nativeProfile.env, path: account.nativeProfile.path } : undefined;
  const { names } = await vendorMcpServerNames(harness.command, home, profile);
  return [...fixed, ...[...names].sort().flatMap((name) => [...prefix, name])];
}
