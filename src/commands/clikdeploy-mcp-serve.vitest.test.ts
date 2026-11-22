import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatPermissionMode, createClikDeployProxy, SIGN_IN_AGAIN } from './clikdeploy-mcp-serve.js';
import type { ClikDeployConnection } from '../agent/mcp/clikdeploy-session.js';

type Json = Record<string, any>;

/** A local stand-in for ClikDeploy's search-mode MCP server. */
let server: Server;
let url: string;
let seen: { method: string; headers: IncomingHttpHeaders; params: Json }[];
let status = 200;

beforeEach(async () => {
  seen = [];
  status = 200;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (status !== 200) { response.writeHead(status).end('{"error":"invalid api key"}'); return; }
      const message = JSON.parse(body || '{}') as Json;
      seen.push({ method: message.method, headers: request.headers, params: message.params ?? {} });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } }
        : message.method === 'tools/list' ? { tools: [
          { name: 'list_apps', description: 'apps', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'search_tools', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          { name: 'call_tool', description: 'call', inputSchema: { type: 'object' } },
          { name: 'some_pinned_extra', description: 'not core', inputSchema: { type: 'object' } },
        ] }
        : { content: [{ type: 'text', text: `ran ${message.params.name}` }] };
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

const connection = (key = 'k-1'): ClikDeployConnection => ({ url, key, config: { get: () => undefined } as never, codeConfig: {} as never });
const list = async (proxy: ReturnType<typeof createClikDeployProxy>): Promise<Json[]> => ((await proxy({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as Json).tools;
const call = async (proxy: ReturnType<typeof createClikDeployProxy>, name: string, args: Json = {}): Promise<Json> =>
  (await proxy({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }))!.result as Json;

describe('the ClikDeploy proxy', () => {
  it('lists the core and search tools under stable clikdeploy_ names, with their annotations', async () => {
    const tools = await list(createClikDeployProxy({ connection: () => connection(), permissionMode: async () => undefined }));
    expect(tools.map((tool) => tool.name)).toEqual(['clikdeploy_list_apps', 'clikdeploy_search_tools', 'clikdeploy_call_tool']);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
    expect(seen.find((entry) => entry.method === 'tools/list')!.headers.authorization).toBe('Bearer k-1');
  });

  it('runs a call upstream under its own name, telling the platform the chat\'s mode as it is at that call', async () => {
    let mode = 'bypass';
    const proxy = createClikDeployProxy({ connection: () => connection(), permissionMode: async () => mode });
    expect(await call(proxy, 'clikdeploy_call_tool', { name: 'gmail_send', arguments: { to: 'a' } })).toEqual({ content: [{ type: 'text', text: 'ran call_tool' }] });
    const first = seen.filter((entry) => entry.method === 'tools/call');
    expect(first[0]!.params).toEqual({ name: 'call_tool', arguments: { name: 'gmail_send', arguments: { to: 'a' } } });
    expect(first[0]!.headers['x-clikdeploy-permission-mode']).toBe('bypass');
    mode = 'ask';
    await call(proxy, 'clikdeploy_list_apps');
    expect(seen.filter((entry) => entry.method === 'tools/call')[1]!.headers['x-clikdeploy-permission-mode']).toBe('ask');
  });

  it('leaves the mode header out when the chat has none', async () => {
    await call(createClikDeployProxy({ connection: () => connection(), permissionMode: async () => undefined }), 'clikdeploy_list_apps');
    expect(seen.find((entry) => entry.method === 'tools/call')!.headers['x-clikdeploy-permission-mode']).toBeUndefined();
  });

  it('refuses a name that is not one of its own', async () => {
    const reply = await createClikDeployProxy({ connection: () => connection(), permissionMode: async () => undefined })({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_use' } });
    expect(reply!.error).toMatchObject({ code: -32602 });
  });

  it('still starts on a refused key, and its tools say to sign in again', async () => {
    status = 401;
    const proxy = createClikDeployProxy({ connection: () => connection(), permissionMode: async () => 'bypass' });
    expect(await proxy({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toMatchObject({ result: { serverInfo: { name: 'clikdeploy' } } });
    expect((await list(proxy)).map((tool) => tool.name)).toEqual(['clikdeploy_search_tools', 'clikdeploy_call_tool']);
    expect(await call(proxy, 'clikdeploy_search_tools', { query: 'gmail' })).toEqual({ content: [{ type: 'text', text: SIGN_IN_AGAIN }], isError: true });
  });

  it('still starts with the platform unreachable, and uses a new sign-in on the next call', async () => {
    let key = 'old';
    const down = createClikDeployProxy({ connection: () => ({ ...connection(key), url: 'http://127.0.0.1:9' }), permissionMode: async () => undefined });
    expect((await list(down)).map((tool) => tool.name)).toEqual(['clikdeploy_search_tools', 'clikdeploy_call_tool']);
    expect((await call(down, 'clikdeploy_search_tools', { query: 'x' })).isError).toBe(true);
    const proxy = createClikDeployProxy({ connection: () => connection(key), permissionMode: async () => undefined });
    await call(proxy, 'clikdeploy_list_apps');
    key = 'new';
    await call(proxy, 'clikdeploy_list_apps');
    expect(seen.filter((entry) => entry.method === 'tools/call').map((entry) => entry.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('says how to sign in when there is no sign-in at all', async () => {
    const proxy = createClikDeployProxy({ connection: () => { throw new Error('Sign in to ClikDeploy with clikdeploy login or clikcode gateway login first.'); }, permissionMode: async () => undefined });
    expect((await list(proxy)).length).toBe(2);
    expect(await call(proxy, 'clikdeploy_call_tool', { name: 'x' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('clikdeploy login') }] });
  });
});

describe('chatPermissionMode', () => {
  it('falls back to the turn\'s own mode when no chat worker can be read', async () => {
    expect(await chatPermissionMode({ CLIKDEPLOY_PERMISSION_MODE: 'bypass' })).toBe('bypass');
    expect(await chatPermissionMode({ CLIKDEPLOY_PERMISSION_MODE: 'nonsense' })).toBeUndefined();
    expect(await chatPermissionMode({})).toBeUndefined();
  });
});
