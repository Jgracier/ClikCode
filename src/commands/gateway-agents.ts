/** Build and manage agents that belong to the connected Gateway account. */
import { readFile } from 'node:fs/promises';
import type Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import { gatewayAgents } from '../gateway/agents.js';
import { emitResult } from '../cli/structured-output.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

async function agentRequest(config: Conf, path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<unknown> {
  const { baseUrl, apiKey } = gatewayConnection(config);
  const response = await fetch(`${baseUrl}/v1/agents${path}`, {
    method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Gateway agent request failed (${response.status})`);
  return result;
}

export async function gatewayAgentList(config: Conf): Promise<void> {
  emitResult({ agents: await gatewayAgents({ config }) });
}

export async function gatewayAgentTools(config: Conf): Promise<void> {
  emitResult(await agentRequest(config, '/capabilities', 'GET'));
}

export interface GatewayAgentOptions {
  name?: string;
  description?: string;
  instructionsFile?: string;
  capability?: string[];
  model?: string;
  provider?: string;
  clearModel?: boolean;
  clearTools?: boolean;
  enable?: boolean;
  disable?: boolean;
}

function pin(options: GatewayAgentOptions): { modelId?: string | null; modelProvider?: string | null } {
  if (options.clearModel) {
    if (options.model || options.provider) throw new Error('--clear-model cannot be combined with --model or --provider.');
    return { modelId: null, modelProvider: null };
  }
  if (Boolean(options.model) !== Boolean(options.provider)) throw new Error('Set both --model and --provider, or neither.');
  return options.model && options.provider ? { modelId: options.model, modelProvider: options.provider } : {};
}

export async function gatewayAgentCreate(config: Conf, handle: string, options: GatewayAgentOptions): Promise<void> {
  if (!options.name || !options.instructionsFile) throw new Error('--name and --instructions-file are required.');
  const systemPrompt = await readFile(options.instructionsFile, 'utf8');
  emitResult(await agentRequest(config, '', 'POST', {
    handle, name: options.name, blurb: options.description ?? '', systemPrompt,
    capabilities: options.capability ?? [], ...pin(options),
  }));
}

export async function gatewayAgentUpdate(config: Conf, id: string, options: GatewayAgentOptions): Promise<void> {
  if (options.clearTools && options.capability?.length) throw new Error('--clear-tools cannot be combined with --capability.');
  if (options.enable && options.disable) throw new Error('--enable and --disable cannot be combined.');
  const systemPrompt = options.instructionsFile ? await readFile(options.instructionsFile, 'utf8') : undefined;
  const patch = {
    ...(options.name ? { name: options.name } : {}),
    ...(options.description !== undefined ? { blurb: options.description } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(options.clearTools ? { capabilities: [] } : options.capability?.length ? { capabilities: options.capability } : {}),
    ...(options.enable || options.disable ? { enabled: Boolean(options.enable) } : {}),
    ...pin(options),
  };
  if (!Object.keys(patch).length) throw new Error('Give at least one agent setting to change.');
  emitResult(await agentRequest(config, `/${encodeURIComponent(id)}`, 'PATCH', patch));
}

export async function gatewayAgentRemove(config: Conf, id: string): Promise<void> {
  emitResult(await agentRequest(config, `/${encodeURIComponent(id)}`, 'DELETE'));
}
