/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import type Conf from 'conf';
import { ApiClient } from '../api/client.js';
import { emitJson } from '../utils/structured-output.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { launchNativeHarness, loginNativeHarness } from './native-harness.js';

const HARNESS_STATE_VERSION = 1;
const LOCAL_HARNESS_PROTOCOL = 1;

type AiHarnessRoute = 'local' | 'gateway';
type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';
interface AiHarnessAccount {
  id: string;
  provider: string;
  label: string;
  authKind: AiHarnessAuthKind;
  models: string[];
  status: 'ready' | 'needs_login' | 'offline';
  quotaState?: 'available' | 'exhausted';
  quotaRetryAt?: string;
  credentialRef: string;
}
interface AiLocalHarnessDefinition {
  command: string;
  provider: string;
  displayName: string;
  localAuth: readonly AiHarnessAuthKind[];
  binary: string;
  npmPackage?: string;
  loginArgv?: readonly string[];
}
interface AiRouterRuntime {
  streamAiChatTurn(input: Record<string, unknown>): Promise<any>;
  AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[];
  localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined;
  localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined;
}

const require = createRequire(import.meta.url);
let routerRuntime: AiRouterRuntime | undefined;
function localRouter(): AiRouterRuntime {
  routerRuntime ??= require('../ai-router-runtime.cjs') as AiRouterRuntime;
  return routerRuntime;
}
function localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined {
  return localRouter().localHarnessForCommand(command);
}
function localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined {
  return localRouter().localHarnessForProvider(provider);
}
function streamLocalAiTurn(input: Record<string, unknown>): Promise<any> {
  return localRouter().streamAiChatTurn(input);
}

interface HarnessSession {
  id: string;
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  effort: string;
  accountFailover: 'never' | 'on-quota-exhausted';
  createdAt: string;
  updatedAt: string;
  /** A closed chat is retained for history but is never reopened implicitly. */
  status: 'active' | 'closed';
  closedAt?: string;
  /** Native agent identity, owned by the selected vendor CLI and never sent to Gateway. */
  nativeHarness?: string;
  nativeSessionId?: string;
  workspace?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface HarnessState {
  version: number;
  installationId: string;
  /** Bearer secret for the loopback protocol; never rendered by CLI commands or HTTP responses. */
  localApiToken: string;
  /** Device-authentication keypair, never a provider credential. Private half stays local. */
  devicePrivateKeyPem: string;
  devicePublicKey: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: HarnessSession[];
  invocations: Array<{ id: string; accountId: string; provider: string; model: string; at: string; inputTokens?: number; outputTokens?: number; latencyMs: number }>;
}

function newDeviceSigningIdentity(): Pick<HarnessState, 'devicePrivateKeyPem' | 'devicePublicKey'> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    devicePrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    devicePublicKey: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  };
}

function harnessStatePath(): string {
  // The caller may relocate non-secret state for testing or portable installs.
  // Provider tokens never live in this file; only opaque local credential refs do.
  const clikCode = process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode');
  const base = process.env.CLIKCODE_HOME?.trim()
    || process.env.CLIKDEPLOY_AI_HOME?.trim()
    || (clikCode ? join(homedir(), '.clikcode') : join(homedir(), '.clikdeploy', 'ai'));
  return join(base, 'harness-state.json');
}

function harnessCommand(): string {
  return process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode')
    ? 'clikcode'
    : 'clikdeploy ai';
}

/** Keep automation structured while making the foreground harness feel like a CLI, not an API dump. */
function emitHarnessOutput(payload: Record<string, unknown>): void {
  if (isJsonDefaultMode()) return emitJson(payload);
  if (payload.status === 'ready') {
    const session = payload.session as HarnessSession;
    const agent = [session.provider, session.model].filter(Boolean).join(' · ') || 'agent not selected';
    output.write(`\nClikCode · ${agent}\nType a prompt, or use /claude, /codex, /accounts, /settings, or /exit.\n\n`);
    return;
  }
  if (typeof payload.text === 'string') {
    output.write(`\n${payload.text}\n\n`);
    return;
  }
  if (typeof payload.panel === 'string') {
    const controls = Array.isArray(payload.controls) ? payload.controls.join(', ') : '';
    output.write(`\n${payload.panel}${controls ? `: ${controls}` : ''}\n\n`);
    return;
  }
  emitJson(payload);
}

async function readState(): Promise<HarnessState> {
  const path = harnessStatePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HarnessState>;
    if (parsed.version !== HARNESS_STATE_VERSION || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
      throw new Error('unsupported local AI harness state');
    }
    // State written by the metadata-only preview gets a secret lazily on its
    // first secure start, preserving account aliases without exposing a window
    // where they are served unauthenticated.
    if (!parsed.localApiToken || !parsed.devicePrivateKeyPem || !parsed.devicePublicKey) {
      const upgraded = {
        ...parsed,
        ...(parsed.localApiToken ? {} : { localApiToken: randomBytes(32).toString('base64url') }),
        ...(!parsed.devicePrivateKeyPem || !parsed.devicePublicKey ? newDeviceSigningIdentity() : {}),
      } as HarnessState;
      await writeState(upgraded);
      return upgraded;
    }
    // Older previews did not include a failover preference. Migrate those
    // sessions to the safe default so a local account does not remain stuck
    // after its known quota window is exhausted.
    const sessions: HarnessSession[] = (parsed.sessions as HarnessSession[]).map((session) => ({
      ...session,
      accountFailover: (session.accountFailover === 'never' ? 'never' : 'on-quota-exhausted') as HarnessSession['accountFailover'],
      // Sessions created before lifecycle state existed were still open at the
      // time of upgrade, so preserve their resumability once.
      status: session.status === 'closed' ? 'closed' : 'active',
    }));
    const now = Date.now();
    const accounts = (parsed.accounts as AiHarnessAccount[]).map((account) => (
      account.quotaState === 'exhausted' && account.quotaRetryAt && Date.parse(account.quotaRetryAt) <= now
        ? { ...account, quotaState: 'available' as const, quotaRetryAt: undefined }
        : account
    ));
    const normalized = { ...(parsed as HarnessState), accounts, sessions, invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [] };
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await writeState(normalized);
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const fresh: HarnessState = {
      version: HARNESS_STATE_VERSION,
      installationId: randomUUID(),
      localApiToken: randomBytes(32).toString('base64url'),
      ...newDeviceSigningIdentity(),
      accounts: [],
      sessions: [],
      invocations: [],
    };
    // The device identity and its loopback bearer must survive the first
    // process exit; otherwise a gateway registration could be valid only for
    // the process that happened to create it.
    await writeState(fresh);
    return fresh;
  }
}

async function writeState(state: HarnessState): Promise<void> {
  const path = harnessStatePath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function accountView(account: AiHarnessAccount): Omit<AiHarnessAccount, 'credentialRef'> {
  const { credentialRef: _credentialRef, ...safe } = account;
  return safe;
}

function deviceManifest(state: HarnessState) {
  return {
    protocol: LOCAL_HARNESS_PROTOCOL,
    installationId: state.installationId,
    devicePublicKey: state.devicePublicKey,
    credentialBoundary: 'local-only' as const,
    capabilities: { chat: true, usage: true, sessions: true, gatewayJobs: false },
    accounts: state.accounts.map(accountView),
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id, provider: account.provider, model, status: account.status,
    }))),
  };
}

function requireAuthKind(value: string): AiHarnessAuthKind {
  if (value === 'oauth' || value === 'api-key' || value === 'vendor-cli') return value;
  throw new Error('auth kind must be oauth, api-key, or vendor-cli');
}

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function methodAndPath(request: IncomingMessage): `${string} ${string}` {
  return `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice('Bearer '.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

function localApiKey(account: AiHarnessAccount): string {
  if (account.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) {
    throw new Error('this account needs a supported local API-key resolver (env:NAME)');
  }
  const name = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid local environment credential reference');
  const value = process.env[name];
  if (!value) throw new Error(`local credential ${name} is not available in this harness process`);
  return value;
}

function isUsageExhaustion(error: unknown): boolean {
  const status = (error as { statusCode?: unknown; response?: { status?: unknown } } | null)?.statusCode
    ?? (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (status === 402 || status === 429) return true;
  return /(?:quota exceeded|quota exhausted|usage limit|rate limit|too many requests|credits? exhausted)/i.test(error instanceof Error ? error.message : String(error));
}

/** Starts an intentionally loopback-only harness service. It exposes no provider tokens. */
export async function aiStart(_config: Conf, options: { port?: string }): Promise<void> {
  // The control API is optional. When no port is requested, defer entirely to
  // the OS so ClikCode never competes with ClikDeploy or another local tool.
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const state = await readState();
  const server = createServer(async (request, response) => {
    try {
      const route = methodAndPath(request);
      if (route === 'GET /v1/health') {
        sendJson(response, 200, { status: 'ok', installationId: state.installationId, runtime: harnessCommand(), credentialBoundary: 'local-only' });
      } else if (!authorized(request, state.localApiToken)) {
        sendJson(response, 401, { error: 'unauthorized' });
      } else if (route === 'GET /v1/accounts') {
        sendJson(response, 200, { accounts: state.accounts.map(accountView) });
      } else if (route === 'GET /v1/device') {
        sendJson(response, 200, { device: deviceManifest(state) });
      } else if (route === 'GET /v1/models') {
        sendJson(response, 200, {
          models: state.accounts.flatMap((account) => account.models.map((model) => ({ accountId: account.id, provider: account.provider, model }))),
        });
      } else if (route === 'GET /v1/sessions') {
        sendJson(response, 200, { sessions: state.sessions });
      } else if (route === 'GET /v1/usage') {
        sendJson(response, 200, { invocations: state.invocations });
      } else if (route === 'POST /v1/chat') {
        const body = await readJson(request) as { accountId?: unknown; messages?: unknown; effort?: unknown };
        const account = state.accounts.find((item) => item.id === body.accountId);
        if (!account) throw new Error('local account not found');
        if (!Array.isArray(body.messages) || !body.messages.every((m) => typeof m === 'object' && m !== null && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string')) {
          throw new Error('messages must be user/assistant text messages');
        }
        const model = account.models[0];
        if (!model) throw new Error('local account has no configured model');
        const startedAt = Date.now();
        const turn = await streamLocalAiTurn({ provider: account.provider, model, apiKey: localApiKey(account), credentialSource: 'env', messages: body.messages as Array<{ role: 'user' | 'assistant'; content: string }>, ...(typeof body.effort === 'string' ? { reasoningEffort: body.effort as never } : {}) });
        const invocation = { id: randomUUID(), accountId: account.id, provider: account.provider, model, at: new Date().toISOString(), inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt };
        state.invocations.push(invocation);
        await writeState(state);
        sendJson(response, 200, { text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation });
      } else {
        sendJson(response, 404, { error: 'not_found' });
      }
    } catch {
      sendJson(response, 500, { error: 'harness_error' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local control API did not expose a TCP address');
  emitJson({ status: 'running', url: `http://127.0.0.1:${address.port}`, installationId: state.installationId, credentialBoundary: 'local-only' });
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function aiAccountsList(): Promise<void> {
  const state = await readState();
  emitJson({ accounts: state.accounts.map(accountView) });
}

/** Lists the normalized local account surfaces without probing provider credentials. */
export async function aiAccountProviders(): Promise<void> {
  emitJson({ harnesses: localRouter().AI_LOCAL_HARNESSES });
}

/** Starts the vendor-owned login flow and records only a local opaque profile reference. */
export async function aiAccountLogin(harnessCommandName: string, label?: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  await loginNativeHarness(harness);
  const state = await readState();
  const accountLabel = (label ?? `${harness.displayName} local`).trim();
  if (!state.accounts.some((account) => account.label.toLowerCase() === accountLabel.toLowerCase())) {
    state.accounts.push({ id: randomUUID(), provider: harness.provider, label: accountLabel, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${harness.binary}` });
    await writeState(state);
  }
  emitHarnessOutput({ status: 'connected', harness: harness.command, account: accountLabel, credentialBoundary: 'local-only' });
}

/** Opens the real native agent TUI; no provider credential crosses the ClikCode boundary. */
export async function aiHarnessLaunch(harnessCommandName: string, sessionId?: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (sessionId) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`AI session "${sessionId}" was not found`);
    session.nativeHarness = harness.command;
    session.provider = harness.provider;
    session.route = 'local';
    session.workspace = process.cwd();
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  await launchNativeHarness(harness);
}

export async function aiModelsList(): Promise<void> {
  const state = await readState();
  emitJson({
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id,
      account: account.label,
      provider: account.provider,
      model,
      status: account.status,
    }))),
  });
}

export async function aiUsage(): Promise<void> {
  const state = await readState();
  const totals = state.invocations.reduce(
    (sum, invocation) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: sum.latencyMs + invocation.latencyMs,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  );
  emitJson({ ...totals, avgLatencyMs: totals.calls ? Math.round(totals.latencyMs / totals.calls) : 0, invocations: state.invocations });
}

/** Reports the separate ClikDeploy OAuth/API-key gateway identity, never a BYO provider login. */
export async function aiGatewayStatus(config: Conf): Promise<void> {
  const apiUrl = ApiClient.getApiUrl(config);
  emitJson({
    route: 'gateway',
    connected: Boolean(ApiClient.getApiKeyForUrl(config, apiUrl)),
    apiUrl,
    authentication: 'clikdeploy-oauth-or-api-key',
    credentialBoundary: 'gateway-auth-only',
    hint: `Run \`${harnessCommand()} gateway login\` to connect ClikDeploy Gateway, or use \`${harnessCommand()} accounts add\` for a provider login that stays local.`,
  });
}

export async function aiAccountAdd(options: { provider: string; label: string; auth: string; model?: string[]; credentialRef: string }): Promise<void> {
  const provider = options.provider.trim();
  const label = options.label.trim();
  const credentialRef = options.credentialRef.trim();
  if (!provider || !label || !credentialRef) throw new Error('provider, label, and local credential reference are required');
  const auth = requireAuthKind(options.auth);
  const harness = localHarnessForProvider(provider);
  if (harness && !harness.localAuth.includes(auth)) throw new Error(`${harness.displayName} does not support local ${auth} accounts`);
  const state = await readState();
  if (state.accounts.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`a local AI account named "${label}" already exists`);
  }
  const account: AiHarnessAccount = {
    id: randomUUID(), provider, label, authKind: auth, models: [...new Set(options.model ?? [])],
    status: 'ready', credentialRef,
  };
  state.accounts.push(account);
  await writeState(state);
  emitJson({ account: accountView(account), credentialBoundary: 'local-only' });
}

export async function aiAccountRemove(labelOrId: string): Promise<void> {
  const state = await readState();
  const index = state.accounts.findIndex((account) => account.id === labelOrId || account.label === labelOrId);
  if (index < 0) throw new Error(`local AI account "${labelOrId}" was not found`);
  const [removed] = state.accounts.splice(index, 1);
  state.sessions = state.sessions.map((session) => session.accountId === removed.id ? { ...session, accountId: null } : session);
  await writeState(state);
  emitJson({ removed: accountView(removed) });
}

export async function aiSessionCreate(options: { route: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  const state = await readState();
  const account = options.account
    ? state.accounts.find((item) => item.id === options.account || item.label === options.account)
    : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), route: options.route, accountId: account?.id ?? null,
    provider: options.provider ?? account?.provider ?? null, model: options.model ?? null,
    effort: options.effort ?? 'medium', accountFailover: options.accountFailover ?? 'on-quota-exhausted', createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  emitJson({ session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  emitJson({ sessions: state.sessions });
}

/**
 * The standalone `clikcode` command is a coding-session entrypoint, not a
 * command browser. Resume the most recently used session, creating the first
 * local session on demand so a fresh install lands directly in the TTY.
 */
export async function aiSessionOpenDefault(config: Conf): Promise<void> {
  const state = await readState();
  let session = [...state.sessions]
    .filter((item) => item.status !== 'closed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!session) {
    // A closed chat must never reopen without an explicit `sessions open`.
    // Its configuration is still the user's last agent choice, so carry that
    // forward into a clean chat rather than guessing a provider or model.
    const previous = [...state.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const now = new Date().toISOString();
    session = {
      id: randomUUID(), route: previous?.route ?? 'local', accountId: previous?.accountId ?? null,
      provider: previous?.provider ?? null, model: previous?.model ?? null,
      effort: previous?.effort ?? 'medium', accountFailover: previous?.accountFailover ?? 'on-quota-exhausted',
      createdAt: now, updatedAt: now, status: 'active',
    };
    state.sessions.push(session);
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
}

export async function aiSessionShow(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  emitJson({ session, resumed: true });
}

/** Shared slash-command grammar for a future TTY client and the headless CLI. */
export async function aiSessionCommand(id: string, input: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const words = input.trim().replace(/^\//, '').split(/\s+/).filter(Boolean);
  const head = words.shift()?.toLowerCase();
  if (!head) throw new Error('slash command is required');
  if (head === 'settings') return emitHarnessOutput({ panel: 'settings', session, controls: ['route', 'account', 'model', 'effort', 'accountFailover'] });
  if (head === 'accounts') {
    const action = words.shift()?.toLowerCase();
    if (action === 'add') {
      const shortcut = words.shift()?.toLowerCase();
      const provider = shortcut ? (localHarnessForCommand(shortcut)?.provider ?? shortcut) : undefined;
      if (!provider) throw new Error('usage: /accounts add <harness>');
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth oauth|api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    if (action === 'failover') {
      const setting = words.shift();
      if (setting !== 'auto' && setting !== 'never') throw new Error('usage: /accounts failover auto|never');
      session.accountFailover = setting === 'auto' ? 'on-quota-exhausted' : 'never';
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', session, accountFailover: session.accountFailover });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['add', 'remove', 'failover auto|never'] });
  }
  const harness = localHarnessForCommand(head);
  if (harness) return aiHarnessLaunch(harness.command, id);
  throw new Error(`unknown slash command: /${head}`);
}

/** Persistent terminal session using the same command and routing surface as automation. */
export async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.status === 'closed') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  const rl = createInterface({ input, output, terminal: true });
  emitHarnessOutput({ status: 'ready', session, commands: ['/claude', '/codex', '/opencode', '/antigravity', '/accounts', '/settings', '/exit'] });
  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question('› ')).trim();
      } catch (error) {
        // A non-interactive caller may close stdin after its final command.
        // Treat that exactly like leaving the foreground harness, not a crash.
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (!line) continue;
      if (line === '/exit' || line === '/quit') {
        session.status = 'closed';
        session.closedAt = new Date().toISOString();
        session.updatedAt = session.closedAt;
        await writeState(state);
        break;
      }
      if (line.startsWith('/')) await aiSessionCommand(id, line);
      else await aiGatewaySessionSend(config, id, line);
    }
  } finally {
    rl.close();
  }
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
export async function aiSessionSend(id: string, prompt: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('use aiGatewaySessionSend for gateway sessions');
  if (!session.accountId) throw new Error('local AI session has no account selected');
  let account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  const model = session.model ?? account.models[0];
  if (!model) throw new Error('local AI session has no model selected');
  if (account.models.length > 0 && !account.models.includes(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const startedAt = Date.now();
  const invoke = (active: AiHarnessAccount) => streamLocalAiTurn({
    provider: session.provider ?? active.provider, model, apiKey: localApiKey(active), credentialSource: 'env',
    messages: [...(session.messages ?? []), { role: 'user', content: text }], reasoningEffort: session.effort as never,
  });
  let turn;
  let switchedFrom: string | undefined;
  try {
    turn = await invoke(account);
  } catch (error) {
    if (session.accountFailover !== 'on-quota-exhausted' || !isUsageExhaustion(error)) throw error;
    const exhaustedAccount = account;
    if (!exhaustedAccount) throw error;
    exhaustedAccount.quotaState = 'exhausted';
    exhaustedAccount.quotaRetryAt = new Date(Date.now() + 60_000).toISOString();
    // Preserve the quota signal even if there is no alternate account or its
    // retry fails. It is a local scheduling fact, never a provider secret.
    await writeState(state);
    const fallback = state.accounts.find((item) =>
      item.id !== exhaustedAccount.id && item.provider === exhaustedAccount.provider && item.status === 'ready' && item.quotaState !== 'exhausted'
      && item.authKind === 'api-key' && item.models.includes(model),
    );
    if (!fallback) throw error;
    switchedFrom = exhaustedAccount.id;
    turn = await invoke(fallback);
    account = fallback;
    session.accountId = fallback.id;
  }
  const invocation = {
    id: randomUUID(), accountId: account.id, provider: session.provider ?? account.provider, model,
    at: new Date().toISOString(), inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt,
  };
  state.invocations.push(invocation);
  session.messages = [...(session.messages ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: turn.text }].slice(-40);
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  emitHarnessOutput({ session, text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
}

/** Send a gateway session through the existing authenticated platform assistant stream. */
export async function aiGatewaySessionSend(config: Conf, id: string, prompt: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route !== 'gateway') return aiSessionSend(id, prompt);
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const baseUrl = ApiClient.getApiUrl(config).replace(/\/$/, '');
  const apiKey = ApiClient.getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, messages: session.messages ?? [], mode: 'plan' }),
  });
  if (!response.ok || !response.body) throw new Error(`gateway AI request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string };
        if (event.type === 'delta' && typeof event.text === 'string') reply += event.text;
        if (event.type === 'error') throw new Error(event.error ?? 'gateway AI request failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (!reply) throw new Error('gateway AI response contained no text');
  const invocation = { id: randomUUID(), accountId: 'gateway', provider: session.provider ?? 'clikdeploy-gateway', model: session.model ?? 'platform', at: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  state.invocations.push(invocation);
  session.messages = [...(session.messages ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }].slice(-40);
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  emitHarnessOutput({ session, text: reply, usage: { attributedBy: 'clikdeploy-gateway' }, invocation });
}

export async function aiSessionSet(id: string, options: { route?: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  const state = await readState();
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`AI session "${id}" was not found`);
  const current = state.sessions[index];
  const account = options.account === undefined
    ? undefined
    : state.accounts.find((item) => item.id === options.account || item.label === options.account);
  if (options.account !== undefined && !account) throw new Error(`local AI account "${options.account}" was not found`);
  const next: HarnessSession = {
    ...current,
    ...(options.route ? { route: options.route } : {}),
    ...(account ? { accountId: account.id, provider: options.provider ?? account.provider } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.accountFailover ? { accountFailover: options.accountFailover } : {}),
    updatedAt: new Date().toISOString(),
  };
  state.sessions[index] = next;
  await writeState(state);
  emitJson({ session: next });
}
