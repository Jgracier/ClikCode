/** Asking an agent's ACP server a few questions, then letting it go.
 *
 * Some vendors publish their lists only over ACP: Goose's providers and which
 * are signed in (`_goose/unstable/providers/*`), Cline's models (the
 * `session/new` result). One short-lived child answers them; nothing is
 * prompted, so no turn is spent. */

import { resolveBinaryPath } from '../transport/native/binary.js';
import { JsonRpcPeer } from '../transport/jsonrpc-peer.js';
import { spawnPortable } from '../transport/spawn.js';

type Json = Record<string, any>;

/** Runs `ask` against an initialized ACP peer and always shuts it down.
 * Undefined when the binary is missing or the server never initializes. */
export async function queryAcp<T>(
  binary: string, argv: readonly string[], environment: Readonly<Record<string, string>>,
  ask: (request: (method: string, params?: Json) => Promise<Json>) => Promise<T>,
  timeoutMs = 20_000,
): Promise<T | undefined> {
  const executable = await resolveBinaryPath(binary);
  if (!executable) return undefined;
  const detached = process.platform !== 'win32';
  const child = spawnPortable(executable, [...argv], {
    env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'], detached,
  });
  const peer = new JsonRpcPeer(child, { label: `${binary} ACP`, detached, forwardParentSignals: false });
  const request = (method: string, params: Json = {}): Promise<Json> => peer.request(method, params, { timeoutMs });
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return await ask(request);
  } catch {
    return undefined;
  } finally {
    await peer.shutdown({ graceMs: 500, killMs: 1000 }).catch(() => undefined);
  }
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
  return { models, labels, ...(current ? { current } : {}) };
}
