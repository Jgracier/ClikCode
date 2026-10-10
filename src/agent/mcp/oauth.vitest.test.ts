/** OAuth for remote MCP servers, against a real local HTTP server playing
 * both parts: an MCP endpoint that answers 401 without a good bearer token,
 * and the authorization server it names (RFC 9728 → RFC 8414 → RFC 7591 →
 * code + PKCE S256 → tokens). The "browser" is a fetch of the authorization
 * link, which follows the redirect into ClikCode's own loopback callback. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerSpec } from './config.js';
import { McpManager } from './manager.js';
import {
  discoverMcpOAuth, forgetMcpOAuth, mcpOAuthFile, mcpOAuthProvider, mcpOAuthState, parsePastedRedirect,
  parseWwwAuthenticate, readMcpOAuth, signInMcpServer, type McpSignInUi,
} from './oauth.js';
import type { ToolContext } from '../tool-contract.js';

type HttpSpec = Extract<McpServerSpec, { transport: 'http' | 'sse' }>;

let dir: string;
const servers: Server[] = [];
const managers: McpManager[] = [];

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-mcp-oauth-')); });
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(dir, { recursive: true, force: true });
});

async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
}

const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

interface FakeOptions {
  registration?: boolean;
  expiresIn?: number;
  refreshFails?: boolean;
  /** The first protected-resource lookup (from the challenge) is the only one. */
  noHeaderMetadata?: boolean;
}

/** One server for both roles. Everything it was asked is kept for the asserts. */
async function fakeOAuthMcp(options: FakeOptions = {}) {
  const log: string[] = [];
  const valid = new Set<string>();
  const refreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string }>();
  const registered: Array<Record<string, any>> = [];
  const seenTokens: string[] = [];
  let issued = 0;
  let base = '';
  const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(value));
  };
  const issue = (response: ServerResponse): void => {
    issued += 1;
    const access = `at-${issued}`;
    const refresh = `rt-${issued}`;
    valid.add(access);
    refreshTokens.add(refresh);
    json(response, 200, { access_token: access, token_type: 'Bearer', refresh_token: refresh, ...(options.expiresIn ? { expires_in: options.expiresIn } : {}) });
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base);
    log.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/mcp') {
      const auth = request.headers.authorization ?? '';
      const token = auth.replace(/^Bearer /, '');
      if (!valid.has(token)) {
        await body(request);
        const metadata = options.noHeaderMetadata ? '' : `, resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
        response.writeHead(401, { 'www-authenticate': `Bearer realm="fake"${metadata}` });
        response.end();
        return;
      }
      seenTokens.push(token);
      const message = JSON.parse(await body(request));
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-oauth' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'whoami', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: `token ${token}` }] };
      json(response, 200, { jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      json(response, 200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`], scopes_supported: ['mcp:tools'] });
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/as') {
      json(response, 200, {
        issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `${base}/as/token`,
        ...(options.registration === false ? {} : { registration_endpoint: `${base}/as/register` }),
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (url.pathname === '/as/register' && request.method === 'POST') {
      const asked = JSON.parse(await body(request));
      registered.push(asked);
      json(response, 201, { client_id: `client-${registered.length}`, redirect_uris: asked.redirect_uris, token_endpoint_auth_method: 'none' });
      return;
    }
    if (url.pathname === '/as/authorize') {
      // The user approving in the browser: straight back to the redirect URI.
      const params = url.searchParams;
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('response_type')).toBe('code');
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: params.get('code_challenge')!, clientId: params.get('client_id')!,
        redirectUri: params.get('redirect_uri')!, resource: params.get('resource')!,
      });
      const back = new URL(params.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state')!);
      response.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/as/token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request));
      if (form.get('grant_type') === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '');
        if (!pending || s256(form.get('code_verifier') ?? '') !== pending.challenge || pending.clientId !== form.get('client_id')
          || pending.redirectUri !== form.get('redirect_uri') || form.get('resource') !== `${base}/mcp`) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code')!);
        issue(response);
        return;
      }
      if (form.get('grant_type') === 'refresh_token') {
        const refresh = form.get('refresh_token') ?? '';
        if (options.refreshFails || !refreshTokens.delete(refresh)) { json(response, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' }); return; }
        issue(response);
        return;
      }
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const spec: HttpSpec = { name: 'fake', transport: 'http', url: `${base}/mcp`, headers: {} };
  return { base, spec, log, valid, registered, seenTokens, options, revokeAll: () => valid.clear() };
}

/** A browser on this machine: the link is followed, redirect and all, into
 * the loopback callback. Nothing is pasted. */
function browserUi(): McpSignInUi & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    show: (link) => { shown.push(link.url); void fetch(link.url).catch(() => undefined); },
    ask: (_prompt, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('answered')))),
  };
}

function manager(spec: HttpSpec, now: () => number = Date.now): McpManager {
  const created = new McpManager(async () => ({ servers: [spec] }), {
    now, authFor: (server) => (server.transport === 'stdio' ? undefined : mcpOAuthProvider(dir, server, { now })),
  });
  managers.push(created);
  return created;
}

const ctx = {} as ToolContext;
const callWhoami = async (subject: McpManager): Promise<string> => {
  const { tools } = await subject.toolset();
  const tool = tools.find((entry) => entry.name === 'mcp__fake__whoami');
  if (!tool) throw new Error('no whoami tool');
  return JSON.stringify(await tool.run({}, ctx));
};

describe('parsing', () => {
  it('reads a WWW-Authenticate challenge', () => {
    expect(parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a/b", scope="r w", error=invalid_token')).toEqual({
      scheme: 'Bearer', params: { realm: 'x', resource_metadata: 'https://a/b', scope: 'r w', error: 'invalid_token' },
    });
  });

  it('takes a pasted redirect address, its query, or a bare code', () => {
    expect(parsePastedRedirect('http://127.0.0.1:5555/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parsePastedRedirect('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parsePastedRedirect('  abc123  ')).toEqual({ code: 'abc123' });
    expect(parsePastedRedirect('http://127.0.0.1/callback?error=access_denied&state=s')).toEqual({ error: 'access_denied', state: 's' });
  });
});

describe('discovery', () => {
  it('follows the challenge to the protected resource and its authorization server', async () => {
    const fake = await fakeOAuthMcp();
    const found = await discoverMcpOAuth(fake.spec, `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(found).toMatchObject({
      resource: `${fake.base}/mcp`, issuer: `${fake.base}/as`,
      authorizationEndpoint: `${fake.base}/as/authorize`, tokenEndpoint: `${fake.base}/as/token`,
      registrationEndpoint: `${fake.base}/as/register`, scope: 'mcp:tools',
    });
  });

  it('finds the protected-resource document at its well-known path when the challenge names none', async () => {
    const fake = await fakeOAuthMcp({ noHeaderMetadata: true });
    const found = await discoverMcpOAuth(fake.spec, 'Bearer realm="fake"');
    expect(found.issuer).toBe(`${fake.base}/as`);
    expect(fake.log).toContain('GET /.well-known/oauth-protected-resource/mcp');
  });
});

describe('sign-in', () => {
  it('registers, authorizes with PKCE through the loopback callback, and stores the tokens privately', async () => {
    const fake = await fakeOAuthMcp();
    const ui = browserUi();
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui });
    const link = new URL(ui.shown[0]!);
    expect(link.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(link.searchParams.get('resource')).toBe(`${fake.base}/mcp`);
    expect(link.searchParams.get('scope')).toBe('mcp:tools');
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]).toMatchObject({ redirect_uris: [link.searchParams.get('redirect_uri')], token_endpoint_auth_method: 'none' });
    const record = await readMcpOAuth(dir, 'fake', fake.spec.url);
    expect(record?.tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(record?.needsSignIn).toBe(false);
    expect((await stat(mcpOAuthFile(dir, 'fake'))).mode & 0o777).toBe(0o600);
    expect(await mcpOAuthState(dir, fake.spec)).toBe('signed-in');
    // And a connection uses it.
    expect(await callWhoami(manager(fake.spec))).toContain('token at-1');
  });

  it('takes the address the browser ended on, pasted back, where no browser reaches the callback', async () => {
    const fake = await fakeOAuthMcp();
    let link = '';
    const ui: McpSignInUi = {
      show: (shown) => { link = shown.url; },
      // The phone's browser: it lands on 127.0.0.1, which fails there, and the
      // user copies the address bar.
      ask: async () => {
        const response = await fetch(link, { redirect: 'manual' });
        return response.headers.get('location')!;
      },
    };
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui });
    expect((await readMcpOAuth(dir, 'fake', fake.spec.url))?.tokens?.accessToken).toBe('at-1');
  });

  it('refuses a pasted answer from another sign-in and asks again', async () => {
    const fake = await fakeOAuthMcp();
    let link = '';
    const prompts: string[] = [];
    const ui: McpSignInUi = {
      show: (shown) => { link = shown.url; },
      ask: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return 'http://127.0.0.1:1/callback?code=stolen&state=wrong';
        return (await fetch(link, { redirect: 'manual' })).headers.get('location')!;
      },
    };
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui });
    expect(prompts[1]).toMatch(/different sign-in/);
  });

  it('uses a configured client id where the server registers none', async () => {
    const fake = await fakeOAuthMcp({ registration: false });
    await expect(signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi() })).rejects.toThrow(/--client-id/);
    const ui = browserUi();
    await signInMcpServer({ stateDir: dir, spec: { ...fake.spec, oauth: { clientId: 'my-app' } }, ui });
    expect(new URL(ui.shown[0]!).searchParams.get('client_id')).toBe('my-app');
    expect(fake.registered).toHaveLength(0);
    expect((await readMcpOAuth(dir, 'fake', fake.spec.url))?.client).toMatchObject({ id: 'my-app' });
  });

  it('is cancelled by the screen', async () => {
    const fake = await fakeOAuthMcp();
    const controller = new AbortController();
    const ui: McpSignInUi = { show: () => controller.abort(), ask: () => new Promise(() => undefined), signal: controller.signal };
    await expect(signInMcpServer({ stateDir: dir, spec: fake.spec, ui })).rejects.toThrow(/cancelled/);
  });

  it('logout forgets the tokens', async () => {
    const fake = await fakeOAuthMcp();
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi() });
    expect(await forgetMcpOAuth(dir, 'fake')).toBe(true);
    expect(await mcpOAuthState(dir, fake.spec)).toBe('none');
  });
});

describe('a connection with a stored sign-in', () => {
  it('refreshes a token about to expire before sending it', async () => {
    const fake = await fakeOAuthMcp({ expiresIn: 3600 });
    let clock = Date.now();
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi(), now: () => clock });
    const subject = manager(fake.spec, () => clock);
    expect(await callWhoami(subject)).toContain('token at-1');
    clock += 3600_000 - 30_000; // inside the refresh-early window
    expect(await callWhoami(subject)).toContain('token at-2');
    expect(fake.valid.has('at-1')).toBe(true); // refreshed early, not because it was refused
    expect((await readMcpOAuth(dir, 'fake', fake.spec.url))?.tokens).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('refreshes once on a 401 and retries', async () => {
    const fake = await fakeOAuthMcp();
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi() });
    const subject = manager(fake.spec);
    expect(await callWhoami(subject)).toContain('token at-1');
    fake.revokeAll();
    expect(await callWhoami(subject)).toContain('token at-2');
    expect(fake.log.filter((line) => line === 'POST /as/token')).toHaveLength(2);
  });

  it('marks the server as needing sign-in when the refresh is refused, and says so in the turn', async () => {
    const fake = await fakeOAuthMcp({ refreshFails: true });
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi() });
    const subject = manager(fake.spec);
    expect(await callWhoami(subject)).toContain('token at-1');
    fake.revokeAll();
    const { tools } = await subject.toolset();
    const result = await tools.find((entry) => entry.name === 'mcp__fake__whoami')!.run({}, ctx).catch((error: unknown) => ({ output: String(error) }));
    expect(JSON.stringify(result)).toMatch(/needs sign-in/);
    const next = await subject.toolset();
    expect(next.tools.map((tool) => tool.name)).not.toContain('mcp__fake__whoami');
    expect(next.notes.join('\n')).toContain('fake needs sign-in: run clikcode mcp login fake');
    expect(await mcpOAuthState(dir, fake.spec)).toBe('needs-sign-in');
    const record = JSON.parse(await readFile(mcpOAuthFile(dir, 'fake'), 'utf8'));
    expect(record.tokens).toBeUndefined();
  });
});

describe('never a sign-in in the background', () => {
  it('reports a server needing sign-in and skips it, without registering or authorizing', async () => {
    const fake = await fakeOAuthMcp();
    const subject = manager(fake.spec);
    const first = await subject.toolset();
    expect(first.tools).toEqual([]);
    expect(first.notes).toEqual(['MCP server fake needs sign-in: run clikcode mcp login fake; its tools are not offered until then']);
    expect(fake.log.some((line) => /\/as\/|well-known/.test(line))).toBe(false);
    // Said once, and not retried on the clock while nothing changed.
    const second = await subject.toolset();
    expect(second.notes).toEqual([]);
    expect(fake.log.filter((line) => line === 'POST /mcp')).toHaveLength(1);
    expect(await mcpOAuthState(dir, fake.spec)).toBe('needs-sign-in');
  });

  it('picks up a sign-in made elsewhere on the next turn', async () => {
    const fake = await fakeOAuthMcp();
    const subject = manager(fake.spec);
    expect((await subject.toolset()).tools).toEqual([]);
    await signInMcpServer({ stateDir: dir, spec: fake.spec, ui: browserUi() });
    expect(await callWhoami(subject)).toContain('token at-1');
  });

  it('leaves a server with its own credential header alone', async () => {
    const fake = await fakeOAuthMcp();
    const subject = new McpManager(async () => ({ servers: [{ ...fake.spec, headers: { authorization: 'Bearer wrong' } }] }), {
      authFor: () => undefined,
    });
    managers.push(subject);
    const { notes } = await subject.toolset();
    expect(notes.join('\n')).toMatch(/unavailable.*401/);
  });
});
