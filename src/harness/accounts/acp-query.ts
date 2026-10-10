/** Asking an agent's ACP server a few questions, then letting it go.
 *
 * Some vendors publish their lists only over ACP: Goose's providers and which
 * are signed in (`_goose/unstable/providers/*`), Cline's models (the
 * `session/new` result). One short-lived child answers them; nothing is
 * prompted, so no turn is spent. */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../../session/store/files.js';
import { stateDirectory } from '../../session/store/paths.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import { JsonRpcPeer } from '../transport/jsonrpc-peer.js';
import { spawnPortable } from '../transport/spawn.js';
import { processesWithEnvironment } from '../transport/process-group.js';
import { vendorMcpServerNames } from '../../agent/mcp/import.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

type Json = Record<string, any>;

/** Runs `ask` against an initialized ACP peer and always shuts it down.
 * Undefined when the binary is missing or the server never initializes. */
export async function queryAcp<T>(
  binary: string, argv: readonly string[], environment: Readonly<Record<string, string>>,
  ask: (request: (method: string, params?: Json) => Promise<Json>, capabilities: Json) => Promise<T>,
  timeoutMs = 20_000,
): Promise<T | undefined> {
  const executable = await resolveBinaryPath(binary);
  if (!executable) return undefined;
  const detached = process.platform !== 'win32';
  // Everything this query starts carries the tag, so what escaped the
  // process group can still be found and stopped (see below).
  const tag = randomBytes(8).toString('hex');
  const child = spawnPortable(executable, [...argv], {
    env: { ...process.env, ...environment, [QUERY_TAG]: tag }, stdio: ['pipe', 'pipe', 'pipe'], detached,
  });
  const peer = new JsonRpcPeer(child, { label: `${binary} ACP`, detached, forwardParentSignals: false });
  const request = (method: string, params: Json = {}): Promise<Json> => peer.request(method, params, { timeoutMs });
  try {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return await ask(request, (initialized.agentCapabilities as Json | undefined) ?? {});
  } catch {
    return undefined;
  } finally {
    await peer.shutdown({ graceMs: 500, killMs: 1000 }).catch(() => undefined);
    await stopEscaped(tag).catch(() => undefined);
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

function discoverySessionsFile(): string {
  return join(stateDirectory(), 'cache', 'acp-discovery-sessions.json');
}

/** The session an agent offers its models on. Most agents store every
 * `session/new` as a chat of the user's, even one never prompted, so asking
 * again on each refresh left a new empty chat each time. The first session is
 * kept and reopened after that; an agent that can neither resume nor load one
 * gets a new session, in the same out-of-the-way folder. */
export async function acpDiscoverySession(
  request: (method: string, params?: Json) => Promise<Json>, capabilities: Json, key: string,
): Promise<Json> {
  const cwd = acpDiscoveryDirectory();
  await mkdir(cwd, { recursive: true });
  const file = discoverySessionsFile();
  const kept: Record<string, string> = await readFile(file, 'utf8').then((text) => JSON.parse(text) as Record<string, string>).catch(() => ({}));
  const previous = kept[key];
  const reopen = capabilities.sessionCapabilities?.resume ? 'session/resume' : capabilities.loadSession ? 'session/load' : undefined;
  if (previous && reopen) {
    // A load or resume answers without the id it was given; it is put back,
    // so a caller can address the reopened session.
    try { return { sessionId: previous, ...await request(reopen, { sessionId: previous, cwd, mcpServers: [] }) }; } catch { /* gone: start another */ }
  }
  const started = await request('session/new', { cwd, mcpServers: [] });
  if (reopen && typeof started.sessionId === 'string' && started.sessionId) {
    await mkdir(join(stateDirectory(), 'cache'), { recursive: true });
    await atomicWriteFile(file, JSON.stringify({ ...kept, [key]: started.sessionId }, null, 2)).catch(() => undefined);
  }
  return started;
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
