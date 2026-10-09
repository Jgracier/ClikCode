/** Build and manage the agents of the connected Gateway account: your own, and
 * for the platform's super admin, the platform agents too. Every setting an
 * agent has is a flag here; the server decides who may change what. */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import { emitResult } from '../cli/structured-output.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { gatewayErrorMessage } from '../gateway/error-message.js';

export const AGENT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const PERMISSION_MODES = ['ask', 'auto', 'bypass'] as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A refusal from the server, with its code (`step-up-required` names the factors it needs). */
export class GatewayAgentError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly needs: string[] = []) {
    super(message);
  }
}

/** The authenticator code and super-admin password a platform-agent change may need. */
export interface StepUp { totp?: string; password?: string }

async function request(config: Conf, path: string, method: Method, body?: unknown, stepUp: StepUp = {}): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = gatewayConnection(config);
  const response = await fetch(`${baseUrl}/v1/agents${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT,
      ...(stepUp.totp ? { 'x-totp-code': stepUp.totp } : {}),
      ...(stepUp.password ? { 'x-superadmin-password': stepUp.password } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new GatewayAgentError(
      gatewayErrorMessage(result) ?? `Gateway agent request failed (${response.status})`,
      response.status, typeof result.code === 'string' ? result.code : undefined,
      Array.isArray(result.needs) ? result.needs.filter((need): need is string => typeof need === 'string') : [],
    );
  }
  return result;
}

async function ask(question: string, hidden = false): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Echo the question, never the password typed after it.
  if (hidden) Object.assign(reader, { _writeToOutput: (text: string) => { if (text.includes(question)) process.stderr.write(text); } });
  try { return (await reader.question(question)).trim(); } finally {
    reader.close();
    if (hidden) process.stderr.write('\n');
  }
}

/**
 * A change, retried once with the step-up when the server asks for it: the
 * authenticator code from `--totp` or a prompt, and the super-admin password
 * from a prompt when the server says it needs one. Without a terminal to ask
 * on, the refusal stands.
 */
export async function withStepUp(
  config: Conf, path: string, method: Method, body: unknown, totp: string | undefined,
  prompt: (question: string, hidden: boolean) => Promise<string> = ask, interactive = Boolean(process.stdin.isTTY),
): Promise<Record<string, unknown>> {
  try {
    return await request(config, path, method, body, { totp });
  } catch (error) {
    if (!(error instanceof GatewayAgentError) || error.code !== 'step-up-required') throw error;
    const needsPassword = error.needs.includes('password');
    if (!interactive) throw totp || needsPassword ? error : new GatewayAgentError(`${error.message} Pass --totp <code>.`, error.status, error.code, error.needs);
    // A code given with --totp is kept when only the password was missing; refused alone, it was wrong.
    const code = totp && needsPassword ? totp : await prompt('Authenticator code: ', false);
    const password = needsPassword ? await prompt('Super-admin password: ', true) : undefined;
    return request(config, path, method, body, { totp: code, password });
  }
}

// ── AGENTS ─────────────────────────────────────────────────────────────────

export interface AgentSummary { id: string; handle: string; name: string; toolsets: string[]; capabilities: string[] }

async function agents(config: Conf): Promise<AgentSummary[]> {
  return ((await request(config, '', 'GET')).data ?? []) as AgentSummary[];
}

/** An agent by its id, handle or name (any case). */
export function findAgent(roster: readonly AgentSummary[], ref: string): AgentSummary {
  const byKey = roster.find((agent) => agent.id === ref || agent.handle === ref.replace(/^@/, ''));
  if (byKey) return byKey;
  const named = roster.filter((agent) => agent.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`More than one agent is named ${ref}; use its id.`);
  throw new Error(`No agent ${ref}. See \`clikcode gateway agents list\`.`);
}

const resolve = async (config: Conf, ref: string) => findAgent(await agents(config), ref);
const agentPath = (agent: AgentSummary, rest = '') => `/${encodeURIComponent(agent.id)}${rest}`;

export async function gatewayAgentList(config: Conf): Promise<void> {
  emitResult({ agents: await agents(config) });
}

export async function gatewayAgentShow(config: Conf, ref: string): Promise<void> {
  const agent = await resolve(config, ref);
  emitResult({ agent: (await request(config, agentPath(agent), 'GET')).data });
}

export async function gatewayAgentTools(config: Conf): Promise<void> {
  emitResult((await request(config, '/tools', 'GET')).data);
}

export interface AgentSettingsOptions {
  name?: string;
  description?: string;
  instructions?: string;
  instructionsFile?: string;
  tools?: string[];
  model?: string;
  effort?: string;
  permission?: string;
  spendLimit?: string;
  on?: boolean;
  off?: boolean;
  totp?: string;
}

export interface ToolEdits { set?: string[]; add: string[]; remove: string[] }

/** `--tools add a b remove c`, `--tools set a,b`: a verb, then the names it applies to. */
export function parseToolEdits(tokens: readonly string[]): ToolEdits {
  const edits: ToolEdits = { add: [], remove: [] };
  let verb: 'set' | 'add' | 'remove' | undefined;
  for (const token of tokens.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)) {
    if (token === 'set' || token === 'add' || token === 'remove') {
      verb = token;
      if (verb === 'set') edits.set ??= [];
      continue;
    }
    if (!verb) throw new Error('--tools starts with add, remove or set, then the tool names.');
    if (verb === 'set') { if (token !== 'none') edits.set!.push(token); } else edits[verb].push(token);
  }
  return edits;
}

/** The agent's toolsets and tools after the edits. A name the catalog lists as a toolset is a toolset. */
export function applyToolEdits(
  current: { toolsets: readonly string[]; capabilities: readonly string[] }, edits: ToolEdits, toolsetIds: ReadonlySet<string>,
): { toolsets: string[]; capabilities: string[] } {
  const toolsets = new Set(edits.set ? [] : current.toolsets);
  const capabilities = new Set(edits.set ? [] : current.capabilities);
  for (const name of [...edits.set ?? [], ...edits.add]) (toolsetIds.has(name) ? toolsets : capabilities).add(name);
  for (const name of edits.remove) { toolsets.delete(name); capabilities.delete(name); }
  return { toolsets: [...toolsets], capabilities: [...capabilities] };
}

/** The settings the flags change, as the server names them. Tools are applied separately. */
export async function settingsPatch(options: AgentSettingsOptions): Promise<Record<string, unknown>> {
  if (options.instructions !== undefined && options.instructionsFile) throw new Error('Use --instructions or --instructions-file, not both.');
  if (options.on && options.off) throw new Error('Use --on or --off, not both.');
  const patch: Record<string, unknown> = {};
  if (options.name !== undefined) patch.name = options.name;
  if (options.description !== undefined) patch.description = options.description;
  if (options.instructions !== undefined) patch.instructions = options.instructions;
  if (options.instructionsFile) patch.instructions = await readFile(options.instructionsFile, 'utf8');
  if (options.model !== undefined) patch.model = options.model === 'auto' ? null : options.model;
  if (options.effort !== undefined) {
    if (options.effort !== 'auto' && !(AGENT_EFFORTS as readonly string[]).includes(options.effort)) {
      throw new Error(`--effort is auto or one of ${AGENT_EFFORTS.join(', ')}.`);
    }
    patch.effort = options.effort === 'auto' ? null : options.effort;
  }
  if (options.permission !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(options.permission)) throw new Error('--permission is ask, auto or bypass.');
    patch.permissionMode = options.permission;
  }
  if (options.spendLimit !== undefined) {
    const limit = Number(options.spendLimit);
    if (options.spendLimit !== 'none' && !(options.spendLimit.trim() !== '' && Number.isFinite(limit) && limit >= 0)) {
      throw new Error('--spend-limit is a number of USD per day (0 = subscriptions and free models only) or none.');
    }
    patch.spendLimitUsd = options.spendLimit === 'none' ? null : limit;
  }
  if (options.on || options.off) patch.enabled = Boolean(options.on);
  return patch;
}

async function toolsetIds(config: Conf): Promise<Set<string>> {
  const catalog = (await request(config, '/tools', 'GET')).data as { toolsets?: Array<{ id: string }> } | undefined;
  return new Set((catalog?.toolsets ?? []).map((toolset) => toolset.id));
}

export async function gatewayAgentCreate(config: Conf, options: AgentSettingsOptions): Promise<void> {
  const patch = await settingsPatch(options);
  if (!patch.name || !patch.instructions) throw new Error('--name and --instructions (or --instructions-file) are required.');
  const tools = options.tools?.length
    ? applyToolEdits({ toolsets: [], capabilities: [] }, parseToolEdits(options.tools), await toolsetIds(config))
    : {};
  emitResult({ agent: (await request(config, '', 'POST', { ...patch, ...tools })).data });
}

export async function gatewayAgentSet(config: Conf, ref: string, options: AgentSettingsOptions): Promise<void> {
  const agent = await resolve(config, ref);
  const patch = await settingsPatch(options);
  if (options.tools?.length) Object.assign(patch, applyToolEdits(agent, parseToolEdits(options.tools), await toolsetIds(config)));
  if (!Object.keys(patch).length) throw new Error('Give at least one setting to change.');
  emitResult({ agent: (await withStepUp(config, agentPath(agent), 'PATCH', patch, options.totp)).data });
}

export async function gatewayAgentDelete(config: Conf, ref: string, options: { totp?: string }): Promise<void> {
  const agent = await resolve(config, ref);
  await withStepUp(config, agentPath(agent), 'DELETE', undefined, options.totp);
  emitResult({ deleted: agent.id });
}

// ── WHEN IT RUNS ───────────────────────────────────────────────────────────

type TriggerKind = 'schedule' | 'event';

export async function gatewayAgentTriggers(config: Conf, ref: string, kind: TriggerKind): Promise<void> {
  const agent = await resolve(config, ref);
  const result = await request(config, agentPath(agent, '/triggers'), 'GET');
  const triggers = ((result.data ?? []) as Array<{ kind: string }>).filter((trigger) => trigger.kind === kind);
  emitResult(kind === 'schedule' ? { schedules: triggers, presets: result.presets } : { events: triggers, available: result.events });
}

export interface ScheduleOptions { cron?: string; preset?: string; at?: string; instruction?: string; off?: boolean; totp?: string }

/** The trigger a `schedules add` describes: exactly one of a cron, a preset or a one-time `at`. */
export function scheduleBody(options: ScheduleOptions): Record<string, unknown> {
  const given = [options.cron, options.preset, options.at].filter((value) => value !== undefined);
  if (given.length !== 1) throw new Error('Give one of --cron <expression>, --preset <name> or --at <time>.');
  return {
    ...(options.cron !== undefined ? { cron: options.cron } : {}),
    ...(options.preset !== undefined ? { preset: options.preset } : {}),
    ...(options.at !== undefined ? { at: new Date(options.at).toISOString() } : {}),
    ...(options.instruction ? { instruction: options.instruction } : {}),
    ...(options.off ? { enabled: false } : {}),
  };
}

export async function gatewayAgentScheduleAdd(config: Conf, ref: string, options: ScheduleOptions): Promise<void> {
  if (options.at !== undefined && Number.isNaN(new Date(options.at).getTime())) throw new Error('--at is a date and time, e.g. 2026-10-07T09:00:00Z.');
  const body = scheduleBody(options);
  const agent = await resolve(config, ref);
  emitResult({ schedule: (await withStepUp(config, agentPath(agent, '/triggers'), 'POST', body, options.totp)).data });
}

export async function gatewayAgentEventAdd(
  config: Conf, ref: string, event: string, options: { instruction?: string; off?: boolean; totp?: string },
): Promise<void> {
  const agent = await resolve(config, ref);
  const body = { event, ...(options.instruction ? { instruction: options.instruction } : {}), ...(options.off ? { enabled: false } : {}) };
  emitResult({ event: (await withStepUp(config, agentPath(agent, '/triggers'), 'POST', body, options.totp)).data });
}

export async function gatewayAgentTriggerRemove(config: Conf, ref: string, triggerId: string, options: { totp?: string }): Promise<void> {
  const agent = await resolve(config, ref);
  await withStepUp(config, agentPath(agent, `/triggers/${encodeURIComponent(triggerId)}`), 'DELETE', undefined, options.totp);
  emitResult({ removed: triggerId });
}
