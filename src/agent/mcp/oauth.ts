/** OAuth for remote MCP servers, as the MCP authorization spec lays it out:
 * a 401 whose `WWW-Authenticate` names the server's protected-resource
 * metadata (RFC 9728), that document naming an authorization server, whose
 * own metadata (RFC 8414, or OIDC discovery) gives the endpoints; a client
 * registered dynamically (RFC 7591) unless the user configured one; an
 * authorization code with PKCE S256, asked for this server only (the
 * resource indicator, RFC 8707).
 *
 * Two halves, kept apart on purpose:
 *
 *  - The PROVIDER (mcpOAuthProvider) is what a connection uses: the stored
 *    token on every request, refreshed before it expires and once on a 401.
 *    It never starts a sign-in. A server it cannot authorize is recorded as
 *    needing one and reported; a worker starting up or a turn in the
 *    background must never open a browser (a vendor that did, on every
 *    session, is why sign-in servers are never copied to vendors either --
 *    harness/mcp-sign-in.ts).
 *
 *  - The SIGN-IN (signInMcpServer) runs only when the user asks:
 *    `clikcode mcp login <name>`, or `/mcp login <name>` in a conversation.
 *    Its link is opened where a browser is local and shown where none is;
 *    the loopback callback finishes it, or the address the browser ended on
 *    (or just the code) pasted back -- the same two ways every other
 *    ClikCode sign-in finishes.
 *
 * Tokens live in `<state dir>/mcp-oauth/<name>.json`, 0600, one file per
 * server, and only there: they are never written into mcp.json, a header, or
 * any vendor's config. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { atomicWriteFile } from '../../session/store/files.js';
import type { McpServerSpec } from './config.js';

type Fetch = typeof fetch;
type HttpSpec = Extract<McpServerSpec, { transport: 'http' | 'sse' }>;

export const MCP_SIGN_IN_REQUIRED = 'MCP_SIGN_IN_REQUIRED';

/** A server that will not answer without a sign-in this process may not start. */
export class McpSignInRequired extends Error {
  readonly code = MCP_SIGN_IN_REQUIRED;
  constructor(readonly server: string) {
    super(mcpSignInNote(server));
    this.name = 'McpSignInRequired';
  }
}

/** The one sentence a turn, a list and an error all use. */
export function mcpSignInNote(server: string): string {
  return `${server} needs sign-in: run clikcode mcp login ${server}`;
}

export function isMcpSignInRequired(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === MCP_SIGN_IN_REQUIRED;
}

// ── the stored record ───────────────────────────────────────────────────────

export interface McpOAuthRecord {
  /** The server URL this was obtained for. A different URL under the same
   * name is a different server, and none of this applies to it. */
  server: string;
  resource?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scope?: string;
  client?: { id: string; secret?: string; authMethod?: string; redirectUri?: string; registered?: boolean };
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
  /** Refused, or never signed in: only `clikcode mcp login` clears it. */
  needsSignIn?: boolean;
  updatedAt?: string;
}

function safeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return clean === name ? clean : `${clean}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

export function mcpOAuthFile(stateDir: string, name: string): string {
  return join(stateDir, 'mcp-oauth', `${safeName(name)}.json`);
}

/** The record for this server, or undefined when there is none for its URL. */
export async function readMcpOAuth(stateDir: string, name: string, url: string): Promise<McpOAuthRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(mcpOAuthFile(stateDir, name), 'utf8')) as McpOAuthRecord;
    return parsed && typeof parsed === 'object' && parsed.server === url ? parsed : undefined;
  } catch { return undefined; }
}

async function writeMcpOAuth(stateDir: string, name: string, record: McpOAuthRecord): Promise<void> {
  await atomicWriteFile(mcpOAuthFile(stateDir, name), `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** `clikcode mcp logout`, and `mcp remove`: the tokens and the registration go. */
export async function forgetMcpOAuth(stateDir: string, name: string): Promise<boolean> {
  const file = mcpOAuthFile(stateDir, name);
  const existed = await stat(file).then(() => true, () => false);
  await rm(file, { force: true });
  return existed;
}

/** Whether ClikCode holds (or has held) OAuth state for this server: a
 * server it signs in to itself, never one to hand a vendor. */
export async function hasMcpOAuth(stateDir: string, name: string, url: string): Promise<boolean> {
  return Boolean(await readMcpOAuth(stateDir, name, url));
}

export type McpSignInState = 'signed-in' | 'needs-sign-in' | 'none';

/** What ClikCode's own record says, without asking the server. */
export async function mcpOAuthState(stateDir: string, spec: HttpSpec): Promise<McpSignInState> {
  const record = await readMcpOAuth(stateDir, spec.name, spec.url);
  if (record?.tokens && !record.needsSignIn) return 'signed-in';
  if (record?.needsSignIn || spec.oauth) return 'needs-sign-in';
  return 'none';
}

// ── discovery ───────────────────────────────────────────────────────────────

/** `Bearer realm="x", resource_metadata="https://…", scope="a b"` → params. */
export function parseWwwAuthenticate(header: string | null | undefined): { scheme?: string; params: Record<string, string> } {
  if (!header?.trim()) return { params: {} };
  const scheme = /^\s*([A-Za-z][\w-]*)/.exec(header)?.[1];
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return { ...(scheme ? { scheme } : {}), params };
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface McpOAuthDiscovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
  authMethods?: string[];
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, any> | undefined> {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined; }
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
  } catch { return undefined; }
}

/** RFC 9728 §3.1: the well-known name goes between the host and the path. */
function wellKnown(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  const at = (p: string): string => `${url.origin}/.well-known/${suffix}${p}`;
  return path ? [at(path), at('')] : [at('')];
}

/** RFC 8414 §3 for an issuer with a path, then OIDC's two spellings. */
function authorizationServerUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Everything a sign-in needs to know, from the server's challenge outward. */
export async function discoverMcpOAuth(
  spec: Pick<HttpSpec, 'url' | 'oauth'>, challenge: string | null, fetchImpl: Fetch = fetch,
): Promise<McpOAuthDiscovery> {
  const { params } = parseWwwAuthenticate(challenge);
  let protectedResource: Record<string, any> | undefined;
  for (const candidate of [...(params.resource_metadata ? [params.resource_metadata] : []), ...wellKnown(spec.url, 'oauth-protected-resource')]) {
    protectedResource = await getJson(new URL(candidate, spec.url).toString(), fetchImpl);
    if (protectedResource) break;
  }
  const servers = Array.isArray(protectedResource?.authorization_servers)
    ? protectedResource!.authorization_servers.filter((item: unknown): item is string => typeof item === 'string')
    : [];
  // A server from before RFC 9728 (the 2025-03-26 revision) is its own
  // authorization server, at its origin.
  const issuer = servers[0] ?? new URL(spec.url).origin;
  let metadata: AuthorizationServerMetadata | undefined;
  for (const candidate of authorizationServerUrls(issuer)) {
    metadata = await getJson(candidate, fetchImpl) as AuthorizationServerMetadata | undefined;
    if (metadata?.authorization_endpoint && metadata.token_endpoint) break;
    metadata = undefined;
  }
  if (!metadata && servers.length) throw new Error(`the authorization server ${issuer} publishes no metadata`);
  const origin = new URL(issuer).origin;
  // The 2025-03-26 revision's defaults, for a server publishing neither document.
  const endpoints = metadata ?? { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
  const methods = metadata?.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.length && !methods.includes('S256')) {
    throw new Error(`the authorization server ${issuer} does not support PKCE S256`);
  }
  const prmScopes = Array.isArray(protectedResource?.scopes_supported) ? protectedResource!.scopes_supported.filter((item: unknown) => typeof item === 'string') : [];
  const scope = params.scope || spec.oauth?.scope || (prmScopes.length ? prmScopes.join(' ') : undefined);
  return {
    resource: typeof protectedResource?.resource === 'string' ? protectedResource.resource : spec.url,
    issuer,
    authorizationEndpoint: endpoints.authorization_endpoint!,
    tokenEndpoint: endpoints.token_endpoint!,
    ...(endpoints.registration_endpoint ? { registrationEndpoint: endpoints.registration_endpoint } : {}),
    ...(scope ? { scope } : {}),
    ...(metadata?.token_endpoint_auth_methods_supported ? { authMethods: metadata.token_endpoint_auth_methods_supported } : {}),
  };
}

// ── tokens ──────────────────────────────────────────────────────────────────

/** A token endpoint's refusal (4xx): the grant is gone, not the network. */
class TokenRefused extends Error {}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

async function tokenRequest(
  record: McpOAuthRecord, form: Record<string, string>, fetchImpl: Fetch, now: number,
): Promise<NonNullable<McpOAuthRecord['tokens']>> {
  const client = record.client!;
  const body = new URLSearchParams({ ...form, ...(record.resource ? { resource: record.resource } : {}) });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.secret && client.authMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.id);
    if (client.secret) body.set('client_secret', client.secret);
  }
  const response = await fetchImpl(record.tokenEndpoint!, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(30_000) });
  const text = await response.text().catch(() => '');
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text); } catch { /* fail-open-ok: a non-JSON answer is reported below by its status */ }
  if (!response.ok || typeof parsed.access_token !== 'string') {
    const reason = [parsed.error, parsed.error_description].filter((item) => typeof item === 'string').join(': ') || `HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500) throw new TokenRefused(`the token endpoint refused: ${reason}`);
    throw new Error(`the token endpoint answered ${reason}`);
  }
  const expiresIn = Number(parsed.expires_in);
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === 'string' ? { refreshToken: parsed.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
  };
}

// ── the provider a connection uses ──────────────────────────────────────────

/** What the HTTP transport asks of whoever holds this server's credential. */
export interface McpAuth {
  /** The Authorization header for the next request; undefined when none is
   * held. Refreshes a token about to expire. Throws McpSignInRequired when
   * the refresh is refused. */
  authorization(): Promise<string | undefined>;
  /** A 401. `retry`: a fresh token is ready. `sign-in`: recorded as needing
   * one. `fail`: an ordinary error (no challenge, nothing held). `final`: a
   * retry was already refused, so no second refresh. */
  unauthorized(challenge: string | null, sent: string | undefined, final: boolean): Promise<'retry' | 'sign-in' | 'fail'>;
  /** Changes when the stored record does (a sign-in elsewhere). */
  stamp(): Promise<string>;
}

/** Refresh this long before the stated expiry, so a request is not sent with
 * a token that dies on the way. */
const REFRESH_EARLY_MS = 60_000;

export function mcpOAuthProvider(
  stateDir: string, spec: HttpSpec, options: { fetchImpl?: Fetch; now?: () => number } = {},
): McpAuth {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let refreshing: Promise<'ok' | 'refused' | 'failed'> | undefined;
  const read = () => readMcpOAuth(stateDir, spec.name, spec.url);
  const markNeedsSignIn = async (): Promise<void> => {
    const record = await read();
    await writeMcpOAuth(stateDir, spec.name, { ...(record ?? { server: spec.url }), tokens: undefined, needsSignIn: true }).catch(() => undefined);
  };
  // One refresh at a time: two requests finding the token stale share it.
  const refresh = (): Promise<'ok' | 'refused' | 'failed'> => refreshing ??= (async () => {
    const record = await read();
    if (!record?.tokens?.refreshToken || !record.client || !record.tokenEndpoint) return 'refused';
    try {
      const tokens = await tokenRequest(record, { grant_type: 'refresh_token', refresh_token: record.tokens.refreshToken }, fetchImpl, now());
      // A server that does not rotate refresh tokens sends none back; the old one stays good.
      await writeMcpOAuth(stateDir, spec.name, { ...record, tokens: { refreshToken: record.tokens.refreshToken, ...tokens }, needsSignIn: false });
      return 'ok';
    } catch (error) {
      if (error instanceof TokenRefused) { await markNeedsSignIn(); return 'refused'; }
      return 'failed';
    }
  })().finally(() => { refreshing = undefined; });
  const header = (record: McpOAuthRecord | undefined): string | undefined =>
    record?.tokens && !record.needsSignIn ? `Bearer ${record.tokens.accessToken}` : undefined;
  return {
    async authorization() {
      const record = await read();
      if (!record?.tokens || record.needsSignIn) return undefined;
      const expiresAt = record.tokens.expiresAt;
      if (expiresAt !== undefined && now() >= expiresAt - REFRESH_EARLY_MS && record.tokens.refreshToken) {
        const outcome = await refresh();
        if (outcome === 'refused') throw new McpSignInRequired(spec.name);
        // 'failed' (the network): the old token goes; a 401 asks again.
        return header(await read()) ?? header(record);
      }
      return header(record);
    },
    async unauthorized(challenge, sent, final) {
      const record = await read();
      const current = header(record);
      // Another process (a sign-in, a worker's refresh) already replaced it.
      if (!final && current && current !== sent) return 'retry';
      if (!final && record?.tokens?.refreshToken) {
        const outcome = await refresh();
        if (outcome === 'ok') return 'retry';
        if (outcome === 'refused') return 'sign-in';
        return 'fail';
      }
      const bearer = parseWwwAuthenticate(challenge).scheme?.toLowerCase() === 'bearer';
      if (!bearer && !record && !spec.oauth) return 'fail';
      await markNeedsSignIn();
      return 'sign-in';
    },
    async stamp() {
      try {
        const info = await stat(mcpOAuthFile(stateDir, spec.name));
        return `${info.mtimeMs}:${info.size}`;
      } catch { return ''; }
    },
  };
}

// ── the sign-in, only when the user asks ────────────────────────────────────

/** The screen a sign-in shows on: the CLI's own line, the conversation's
 * sign-in band (tui/prompter.ts signInScreen), or a test. */
export interface McpSignInUi {
  /** The link: opened where a browser is local, shown either way. */
  show(link: { url: string }): void;
  /** The address the browser ended on, or its code, pasted back -- asked
   * beside the link, while the loopback callback may still finish it.
   * `signal` ends the question when the callback wins. */
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

export interface McpSignInOptions {
  stateDir: string;
  spec: HttpSpec;
  ui: McpSignInUi;
  fetchImpl?: Fetch;
  now?: () => number;
  /** How long the link stays good for. */
  timeoutMs?: number;
}

/** A pasted answer: a whole redirect address, its query, or the bare code. */
export function parsePastedRedirect(text: string): { code?: string; state?: string; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (!/(?:^|[?&#])(?:code|error)=/.test(trimmed)) return { code: trimmed };
  const at = trimmed.search(/[?#]/);
  const query = (at < 0 ? trimmed : trimmed.slice(at + 1)).replace(/#/g, '&');
  const params = new URLSearchParams(query);
  return {
    ...(params.get('code') ? { code: params.get('code')! } : {}),
    ...(params.get('state') ? { state: params.get('state')! } : {}),
    ...(params.get('error') ? { error: [params.get('error'), params.get('error_description')].filter(Boolean).join(': ') } : {}),
  };
}

const CALLBACK_PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3em"><h2>${title}</h2><p>${body}</p></body>`;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve((server.address() as AddressInfo).port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** The unauthenticated first request: its challenge starts discovery. */
async function challengeOf(spec: HttpSpec, fetchImpl: Fetch): Promise<{ status: number; challenge: string | null }> {
  const response = await fetchImpl(spec.url, {
    method: 'POST',
    headers: { ...spec.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clikcode', version: '1' } } }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, challenge: response.headers.get('www-authenticate') };
}

/** Sign in to one server: discover, register (or use the configured client),
 * authorize with PKCE, and store the tokens. Throws with a reason the user
 * can act on; cancelled when `ui.signal` aborts. */
export async function signInMcpServer(options: McpSignInOptions): Promise<void> {
  const { stateDir, spec, ui } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const { status, challenge } = await challengeOf(spec, fetchImpl);
  if (status !== 401 && status !== 403 && !spec.oauth && !parseWwwAuthenticate(challenge).params.resource_metadata) {
    throw new Error(`${spec.name} does not ask for a sign-in (it answered HTTP ${status})`);
  }
  const discovery = await discoverMcpOAuth(spec, challenge, fetchImpl);
  const previous = await readMcpOAuth(stateDir, spec.name, spec.url);

  const server = createServer();
  // The port a stored registration was made for, so it can be used again;
  // a configured one; else any free one (RFC 8252 §7.3).
  const configuredPort = spec.oauth?.callbackPort;
  const reusable = !spec.oauth?.clientId && previous?.client?.registered && previous.issuer === discovery.issuer ? previous.client : undefined;
  const reusePort = reusable?.redirectUri ? Number(new URL(reusable.redirectUri).port) : undefined;
  let port: number;
  try {
    port = await listen(server, configuredPort ?? reusePort ?? 0);
  } catch (error) {
    if (configuredPort !== undefined) throw new Error(`port ${configuredPort} for the sign-in callback is in use: ${(error as Error).message}`);
    port = await listen(server, 0);
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    let client: NonNullable<McpOAuthRecord['client']>;
    if (spec.oauth?.clientId) {
      client = { id: spec.oauth.clientId, redirectUri };
    } else if (reusable && reusable.redirectUri === redirectUri) {
      client = reusable;
    } else {
      if (!discovery.registrationEndpoint) {
        throw new Error(`${spec.name}'s authorization server does not register clients; add it again with --client-id <id>`);
      }
      client = await registerClient(discovery, redirectUri, fetchImpl);
    }
    const pkce = pkcePair();
    const state = base64url(randomBytes(16));
    const authorize = new URL(discovery.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: client.id, redirect_uri: redirectUri,
      code_challenge: pkce.challenge, code_challenge_method: 'S256', state,
      resource: discovery.resource, ...(discovery.scope ? { scope: discovery.scope } : {}),
    })) authorize.searchParams.set(key, value);

    const code = await waitForCode({ server, state, ui, url: authorize.toString(), name: spec.name, timeoutMs: options.timeoutMs ?? 10 * 60_000 });
    const record: McpOAuthRecord = {
      server: spec.url, resource: discovery.resource, issuer: discovery.issuer,
      authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint,
      ...(discovery.registrationEndpoint ? { registrationEndpoint: discovery.registrationEndpoint } : {}),
      ...(discovery.scope ? { scope: discovery.scope } : {}),
      client,
    };
    const tokens = await tokenRequest(record, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier }, fetchImpl, now())
      .catch((error: unknown) => { throw new Error(`${spec.name}: ${(error as Error).message}`); });
    await writeMcpOAuth(stateDir, spec.name, { ...record, tokens, needsSignIn: false });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function registerClient(discovery: McpOAuthDiscovery, redirectUri: string, fetchImpl: Fetch): Promise<NonNullable<McpOAuthRecord['client']>> {
  // A public client where the server takes one; else a secret sent in the
  // form (Figma registers no public clients).
  const methods = discovery.authMethods;
  const method = !methods?.length || methods.includes('none') ? 'none'
    : methods.includes('client_secret_post') ? 'client_secret_post' : methods[0]!;
  const response = await fetchImpl(discovery.registrationEndpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'ClikCode',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(discovery.scope ? { scope: discovery.scope } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text().catch(() => '');
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text); } catch { /* fail-open-ok: reported below by its status */ }
  if (!response.ok || typeof parsed.client_id !== 'string') {
    const reason = [parsed.error, parsed.error_description].filter((item) => typeof item === 'string').join(': ') || `HTTP ${response.status}`;
    throw new Error(`client registration was refused (${reason}); add the server again with --client-id <id>`);
  }
  return {
    id: parsed.client_id,
    ...(typeof parsed.client_secret === 'string' ? { secret: parsed.client_secret } : {}),
    authMethod: typeof parsed.token_endpoint_auth_method === 'string' ? parsed.token_endpoint_auth_method : method,
    redirectUri, registered: true,
  };
}

/** The code, from whichever comes first: the browser reaching the loopback
 * callback, or the user pasting where it ended up. */
function waitForCode(input: {
  server: Server; state: string; ui: McpSignInUi; url: string; name: string; timeoutMs: number;
}): Promise<string> {
  const { server, state, ui } = input;
  const done = new AbortController();
  return new Promise<string>((resolve, reject) => {
    const finish = (error: Error | undefined, code?: string): void => {
      if (done.signal.aborted) return;
      done.abort();
      clearTimeout(timer);
      ui.signal?.removeEventListener('abort', onCancel);
      if (error) reject(error); else resolve(code!);
    };
    const onCancel = (): void => finish(Object.assign(new Error(`Sign-in to ${input.name} cancelled`), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(new Error(`Sign-in to ${input.name} timed out`)), input.timeoutMs);
    timer.unref?.();
    if (ui.signal?.aborted) return onCancel();
    ui.signal?.addEventListener('abort', onCancel, { once: true });
    const accept = (answer: { code?: string; state?: string; error?: string }): string | undefined => {
      if (answer.state !== undefined && answer.state !== state) return 'that answer belongs to a different sign-in';
      if (answer.error) { finish(new Error(`${input.name} refused the sign-in: ${answer.error}`)); return answer.error; }
      if (!answer.code) return 'no code in that answer';
      finish(undefined, answer.code);
      return undefined;
    };
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      const answer = {
        ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}),
        // The loopback answer must carry this sign-in's state: anything else
        // on this machine could otherwise hand us a code of its choosing.
        state: url.searchParams.get('state') ?? '',
        ...(url.searchParams.get('error') ? { error: [url.searchParams.get('error'), url.searchParams.get('error_description')].filter(Boolean).join(': ') } : {}),
      };
      const problem = accept(answer);
      response.writeHead(problem ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(problem
        ? CALLBACK_PAGE('Sign-in did not finish', `ClikCode could not use this answer: ${problem.replace(/[<>&]/g, '')}.`)
        : CALLBACK_PAGE(`Signed in to ${input.name.replace(/[<>&]/g, '')}`, 'You can close this tab and go back to ClikCode.'));
    });
    ui.show({ url: input.url });
    // Pasted answers, until one is good or the callback wins.
    void (async () => {
      let prompt = 'Or paste the address your browser ended on (or its code)';
      while (!done.signal.aborted) {
        let text: string;
        try { text = await ui.ask(prompt, done.signal); } catch { return; }
        if (done.signal.aborted) return;
        const problem = accept(parsePastedRedirect(text));
        if (!problem) return;
        prompt = `${problem[0]!.toUpperCase()}${problem.slice(1)} · paste the address again`;
      }
    })();
  });
}
