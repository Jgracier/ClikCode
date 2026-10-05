/** A remote MCP server that needs a browser sign-in is recognised from the
 * server's own answer, against a real HTTP server on loopback. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carriesCredentials, mcpServerNeedsSignIn, probeRemoteMcp, signInFromResponse } from './mcp-sign-in.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    if (request.url === '/oauth') {
      // What Robinhood's and Figma's MCP endpoints answer.
      response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth"` });
      response.end();
    } else if (request.url === '/optional') {
      // What Context7 answers: served, with optional OAuth advertised.
      response.writeHead(200, { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="x"' });
      response.end('{}');
    } else if (request.url === '/sse-oauth') {
      if (request.method === 'POST') { response.writeHead(405); response.end(); return; }
      response.writeHead(401, { 'www-authenticate': 'Bearer realm="x"' });
      response.end();
    } else if (request.url === '/key-required') {
      response.writeHead(401);
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('whether a remote MCP server needs a sign-in', () => {
  it('is a 401 or 403 that carries a challenge, and nothing else', () => {
    expect(signInFromResponse(401, 'Bearer resource_metadata="x"')).toBe('sign-in');
    expect(signInFromResponse(403, 'Bearer error="insufficient_scope"')).toBe('sign-in');
    expect(signInFromResponse(401, null)).toBe('open');
    expect(signInFromResponse(200, 'Bearer resource_metadata="x"')).toBe('open');
  });

  it('asks the server itself', async () => {
    expect(await probeRemoteMcp(`${base}/oauth`)).toBe('sign-in');
    expect(await probeRemoteMcp(`${base}/optional`)).toBe('open');
    expect(await probeRemoteMcp(`${base}/plain`)).toBe('open');
    expect(await probeRemoteMcp(`${base}/sse-oauth`)).toBe('sign-in');
    // An API key it lacks is not a browser page.
    expect(await probeRemoteMcp(`${base}/key-required`)).toBe('open');
  });

  it('is unknown when the server cannot be reached', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await probeRemoteMcp(`http://127.0.0.1:${port}/mcp`)).toBe('unknown');
  });

  it('knows a credential header when it sees one', () => {
    expect(carriesCredentials({ Authorization: 'Bearer abc' })).toBe(true);
    expect(carriesCredentials({ 'X-API-Key': 'k' })).toBe(true);
    expect(carriesCredentials({ 'X-Brain-Token': 't' })).toBe(true);
    expect(carriesCredentials({ 'X-Trace': 'on' })).toBe(false);
    expect(carriesCredentials({ Authorization: '' })).toBe(false);
    expect(carriesCredentials(undefined)).toBe(false);
  });
});

describe('the decision provisioning asks for', () => {
  const never = async (): Promise<never> => { throw new Error('must not ask the server'); };

  it('never asks about a local server', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signin-'));
    expect(await mcpServerNeedsSignIn({ name: 'x', target: 'npx', args: ['-y', 'x'] }, { stateDir, probe: never })).toBe('open');
  });

  it('copies an entry that carries its own credential, unless the vendor would drop it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signin-'));
    const entry = { name: 'r', target: `${base}/oauth`, headers: { Authorization: 'Bearer abc' } };
    expect(await mcpServerNeedsSignIn(entry, { stateDir, probe: never })).toBe('open');
    expect(await mcpServerNeedsSignIn(entry, { stateDir, headersReach: false })).toBe('sign-in');
  });

  it('remembers a definite answer by URL for a day, and never an unknown one', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signin-'));
    const entry = { name: 'r', target: 'https://mcp.example.test/mcp' };
    let asked = 0;
    const probe = async (): Promise<'sign-in'> => { asked += 1; return 'sign-in'; };
    expect(await mcpServerNeedsSignIn(entry, { stateDir, probe, now: 1_000 })).toBe('sign-in');
    expect(await mcpServerNeedsSignIn(entry, { stateDir, probe, now: 2_000 })).toBe('sign-in');
    expect(asked).toBe(1);
    const cached = JSON.parse(await readFile(join(stateDir, 'cache', 'mcp-sign-in.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(cached)).toEqual(['https://mcp.example.test/mcp']);
    expect(await mcpServerNeedsSignIn(entry, { stateDir, probe, now: 1_000 + 25 * 3600_000 })).toBe('sign-in');
    expect(asked).toBe(2);

    const offline = { name: 'o', target: 'https://offline.example.test/mcp' };
    let tries = 0;
    const down = async (): Promise<'unknown'> => { tries += 1; return 'unknown'; };
    expect(await mcpServerNeedsSignIn(offline, { stateDir, probe: down })).toBe('unknown');
    expect(await mcpServerNeedsSignIn(offline, { stateDir, probe: down })).toBe('unknown');
    expect(tries).toBe(2);
  });
});
