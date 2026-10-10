/** MCP in ClikCode's own agent loop, against a real child process speaking
 * the protocol (fixtures/fake-mcp-server.mjs) and real local HTTP servers --
 * the framing, the crash and shutdown paths are exactly what a mock would
 * hide. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGatewayHarnessTurn } from '../run-turn.js';
import { disposeSessionState } from '../session-state.js';
import { ScriptedModelClient } from '../testing.js';
import type { ToolContext, ToolDefinition } from '../tool-contract.js';
import { loadMcpServers, parseMcpServerEntry, type McpServerSpec } from './config.js';
import { McpManager } from './manager.js';
import { formatMcpResult, mcpToolName, mcpToolParameters } from './tools.js';
import { writeMcpConfigEntry } from '../../harness/mcp-registry.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

let dir: string;
const managers: McpManager[] = [];
const servers: Server[] = [];

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-mcp-agent-')); });
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(dir, { recursive: true, force: true });
});

function fake(name: string, env: Record<string, string> = {}): McpServerSpec {
  return { name, transport: 'stdio', command: process.execPath, args: [FIXTURE], env };
}

function manager(specs: McpServerSpec[], timeouts: ConstructorParameters<typeof McpManager>[1] = {}): McpManager {
  const created = new McpManager(async () => ({ servers: specs }), timeouts);
  managers.push(created);
  return created;
}

const ctx = (signal?: AbortSignal): ToolContext => ({ signal } as unknown as ToolContext);
const find = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`no tool ${name} in ${tools.map((entry) => entry.name).join(', ')}`);
  return tool;
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('tool names', () => {
  it('is mcp__server__tool when that is already legal', () => {
    expect(mcpToolName('files', 'read_file')).toBe('mcp__files__read_file');
  });

  it('cleans illegal characters and keeps a hash so cleaned names stay distinct', () => {
    const dotted = mcpToolName('my.server', 'a.b');
    const underscored = mcpToolName('my_server', 'a_b');
    expect(dotted).toMatch(/^mcp__my_server__a_b_[0-9a-f]{8}$/);
    expect(underscored).toBe('mcp__my_server__a_b');
    expect(dotted).not.toBe(underscored);
  });

  it('never exceeds 64 characters, and is the same every time', () => {
    const long = mcpToolName('a-very-long-server-name-indeed', 'and_an_even_longer_tool_name_that_goes_on_and_on');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(mcpToolName('a-very-long-server-name-indeed', 'and_an_even_longer_tool_name_that_goes_on_and_on')).toBe(long);
    expect(mcpToolName('a-very-long-server-name-indeed', 'and_an_even_longer_tool_name_that_goes_on_and_on_2')).not.toBe(long);
  });

  it('gives a name already taken a hash suffix instead of shadowing it', () => {
    expect(mcpToolName('s', 't', new Set(['mcp__s__t']))).toMatch(/^mcp__s__t_[0-9a-f]{8}$/);
  });
});

describe('schemas and results', () => {
  it('forces an object schema and drops $schema', () => {
    expect(mcpToolParameters(undefined)).toEqual({ type: 'object', properties: {} });
    expect(mcpToolParameters({ $schema: 'x', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  });

  it('joins text, summarizes what is not text, and respects isError', () => {
    expect(formatMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({ output: 'a\nb' });
    expect(formatMcpResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }).output).toBe('[image: image/png, 3 B]');
    expect(formatMcpResult({ content: [{ type: 'text', text: 'no' }], isError: true })).toEqual({ output: 'no', isError: true });
    expect(formatMcpResult({ structuredContent: { a: 1 } }).output).toContain('"a": 1');
    expect(formatMcpResult({ content: [] }).output).toBe('(no output)');
  });
});

describe('config', () => {
  it('reads the mcpServers shape clikcode mcp add writes, plus hand-written keys', () => {
    expect(parseMcpServerEntry('a', { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } }))
      .toEqual({ name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
    expect(parseMcpServerEntry('b', { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } }))
      .toEqual({ name: 'b', transport: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } });
    expect(parseMcpServerEntry('c', { type: 'sse', url: 'https://x.test/sse' })).toMatchObject({ transport: 'sse' });
    expect(parseMcpServerEntry('d', { command: 'x', disabled: true })).toBeUndefined();
    expect(parseMcpServerEntry('e', { args: ['nothing to run'] })).toBeUndefined();
  });

  it('reads back exactly what the harness registry writes for clikcode mcp add', async () => {
    const path = join(dir, 'mcp.json');
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'files', target: 'npx', args: ['-y', 'pkg', '/tmp'] });
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'remote', target: 'https://mcp.example.com/mcp' });
    expect((await loadMcpServers(dir)).servers).toEqual([
      { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'pkg', '/tmp'], env: {} },
      { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
    ]);
  });

  it('treats a missing file as no servers and a broken one as a note', async () => {
    expect(await loadMcpServers(dir)).toEqual({ servers: [] });
    await writeFile(join(dir, 'mcp.json'), '{ not json');
    expect((await loadMcpServers(dir)).problem).toMatch(/not valid JSON/);
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { f: { command: 'node' } } }));
    expect((await loadMcpServers(dir)).servers).toHaveLength(1);
  });
});

describe('a server with a turn wait', () => {
  it('does not hold the turn past its wait: the others serve it, and it joins a later turn once up', async () => {
    const ready = join(dir, 'ready');
    // Silent until the file appears: a server whose start is slow this time.
    const slow: McpServerSpec = { ...fake('slow', { FAKE_MCP_SILENT_UNTIL: ready }), turnWaitMs: 200 };
    const subject = manager([fake('quick'), slow], { timeouts: { connectMs: 30_000 } });
    const begun = Date.now();
    const first = await subject.toolset();
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(first.tools.some((tool) => tool.name === 'mcp__quick__echo')).toBe(true);
    expect(first.tools.some((tool) => tool.name.startsWith('mcp__slow__'))).toBe(false);
    // Still starting is not a failure: nothing to tell the user.
    expect(first.notes).toEqual([]);
    await writeFile(ready, '');
    // The start already under way finishes once the server answers, and a
    // later turn offers its tools -- without starting it again.
    let later = await subject.toolset();
    for (let tries = 0; tries < 20 && !later.tools.some((tool) => tool.name === 'mcp__slow__echo'); tries += 1) later = await subject.toolset();
    expect(later.tools.some((tool) => tool.name === 'mcp__slow__echo')).toBe(true);
    expect(later.notes).toEqual([]);
  });
});

describe('a stdio server', () => {
  it('lists every tool across pages, with read only where the server says so', async () => {
    const { tools, notes } = await manager([fake('fake')]).toolset();
    expect(notes).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__fake__echo', 'mcp__fake__fail', 'mcp__fake__explode', 'mcp__fake__crash',
      'mcp__fake__slow', 'mcp__fake__picture', 'mcp__fake__structured', expect.stringMatching(/^mcp__fake__weird_name_with_spaces_[0-9a-f]{8}$/),
    ]);
    expect(find(tools, 'mcp__fake__echo').class).toBe('read');
    expect(find(tools, 'mcp__fake__picture').class).toBe('exec');
    expect(find(tools, 'mcp__fake__fail').class).toBe('exec');
    expect(find(tools, 'mcp__fake__echo').description).toContain('Echoes its text back.');
    expect(find(tools, 'mcp__fake__echo').parameters).not.toHaveProperty('$schema');
  });

  it('calls a tool, including one whose name had to be cleaned', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    expect((await find(tools, 'mcp__fake__echo').run({ text: 'hi' }, ctx())).output).toMatch(/^echo: hi/);
    const weird = tools.find((tool) => tool.name.startsWith('mcp__fake__weird'))!;
    expect((await weird.run({}, ctx())).output).toBe('weird ok');
    expect((await find(tools, 'mcp__fake__picture').run({}, ctx())).output)
      .toBe('[image: image/png, 2.9 KB]\n[resource: file:///tmp/report.pdf (application/pdf), 3 B]\n[resource link: x.txt file:///tmp/x.txt]');
    expect((await find(tools, 'mcp__fake__structured').run({}, ctx())).output).toContain('"temperature": 21');
  });

  it('reports a tool error as an error result, and a protocol error as a throw', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    expect(await find(tools, 'mcp__fake__fail').run({}, ctx())).toEqual({ output: 'the widget is jammed', isError: true });
    await expect(find(tools, 'mcp__fake__explode').run({}, ctx())).rejects.toThrow(/kaboom/);
  });

  it('times out a call that never answers, and tells the server it was abandoned', async () => {
    const { tools } = await manager([fake('fake')], { timeouts: { callMs: 300 } }).toolset();
    await expect(find(tools, 'mcp__fake__slow').run({}, ctx())).rejects.toThrow(/timed out/);
    expect((await find(tools, 'mcp__fake__echo').run({ text: 'x' }, ctx())).output).toMatch(/cancelled so far: \d+/);
  });

  it('abandons a call when the turn is cancelled', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    const controller = new AbortController();
    const pending = find(tools, 'mcp__fake__slow').run({}, ctx(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('survives a crash mid-call: the call fails with its stderr, the next turn restarts it', async () => {
    const pidFile = join(dir, 'pid');
    const mcp = manager([fake('fake', { FAKE_MCP_PID_FILE: pidFile })]);
    const { tools } = await mcp.toolset();
    const first = Number(await readFile(pidFile, 'utf8'));
    await expect(find(tools, 'mcp__fake__crash').run({}, ctx())).rejects.toThrow(/segfault in module frobnicate/);
    await until(() => !alive(first));
    const again = await mcp.toolset();
    expect(again.notes).toEqual([]);
    expect(Number(await readFile(pidFile, 'utf8'))).not.toBe(first);
    expect((await find(again.tools, 'mcp__fake__echo').run({ text: 'back' }, ctx())).output).toMatch(/^echo: back/);
  });

  it('reconnects on a call when the server died after its tools were listed', async () => {
    const pidFile = join(dir, 'pid');
    const { tools } = await manager([fake('fake', { FAKE_MCP_PID_FILE: pidFile })]).toolset();
    const first = Number(await readFile(pidFile, 'utf8'));
    process.kill(-first, 'SIGKILL');
    await until(() => !alive(first));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await find(tools, 'mcp__fake__echo').run({ text: 'again' }, ctx())).output).toMatch(/^echo: again/);
  });

  it('a server that will not start costs only its own tools, with its reason', async () => {
    let clock = 0;
    const mcp = manager([fake('broken', { FAKE_MCP_FAIL_START: '1' }), fake('good')], { now: () => clock });
    const { tools, notes } = await mcp.toolset();
    expect(tools.every((tool) => tool.name.startsWith('mcp__good__'))).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"broken" is unavailable/);
    expect(notes[0]).toMatch(/could not open the database/);
    // Not retried on every turn, and said once: a server that stays down
    // does not add the same line to every turn.
    const started = Date.now();
    expect((await mcp.toolset()).notes).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
    // Retried after the backoff; failing again for the same reason is not news.
    clock += 61_000;
    const retried = await mcp.toolset();
    expect(retried.notes).toEqual([]);
    expect(retried.tools.every((tool) => tool.name.startsWith('mcp__good__'))).toBe(true);
  });

  it('a command that does not exist is a note, not a failed turn', async () => {
    const { tools, notes } = await manager([{ name: 'nope', transport: 'stdio', command: join(dir, 'no-such-binary'), args: [], env: {} }]).toolset();
    expect(tools).toEqual([]);
    expect(notes[0]).toMatch(/"nope" is unavailable/);
  });

  it('shuts its servers down, and restarts one whose config changed', async () => {
    const pidFile = join(dir, 'pid');
    let specs = [fake('fake', { FAKE_MCP_PID_FILE: pidFile })];
    const mcp = new McpManager(async () => ({ servers: specs }));
    managers.push(mcp);
    await mcp.toolset();
    const first = Number(await readFile(pidFile, 'utf8'));
    expect(alive(first)).toBe(true);
    specs = [fake('fake', { FAKE_MCP_PID_FILE: pidFile, CHANGED: '1' })];
    await mcp.toolset();
    const second = Number(await readFile(pidFile, 'utf8'));
    expect(second).not.toBe(first);
    await until(() => !alive(first));
    await mcp.shutdown();
    await until(() => !alive(second));
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function body(request: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function answer(message: any): any {
  if (message.method === 'initialize') return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'web' } };
  if (message.method === 'tools/list') return { tools: [{ name: 'lookup', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] };
  if (message.method === 'tools/call') return { content: [{ type: 'text', text: `found ${message.params.arguments.q}` }] };
  return {};
}

describe('an HTTP server', () => {
  it('speaks streamable HTTP: session id, protocol header, JSON and SSE answers', async () => {
    const seen: Array<{ method?: string; session?: string; version?: string }> = [];
    const url = await listen(async (request, response) => {
      if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
      const message = await body(request);
      seen.push({ method: message.method, session: request.headers['mcp-session-id'] as string, version: request.headers['mcp-protocol-version'] as string });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) });
      if (message.method === 'tools/list') {
        // An SSE answer, preceded by an unrelated notification.
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\nevent: message\ndata: ${reply}\n\n`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(reply);
    });
    const { tools, notes } = await manager([{ name: 'web', transport: 'http', url, headers: { authorization: 'Bearer t' } }]).toolset();
    expect(notes).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.class])).toEqual([['mcp__web__lookup', 'read']]);
    expect((await tools[0].run({ q: 'cats' }, ctx())).output).toBe('found cats');
    expect(seen[0]).toEqual({ method: 'initialize', session: undefined, version: undefined });
    expect(seen.slice(1).every((entry) => entry.session === 'sess-1' && entry.version === '2025-03-26')).toBe(true);
  });

  it('falls back to the legacy HTTP+SSE transport when the POST is refused', async () => {
    let stream: ServerResponse | undefined;
    const url = await listen(async (request, response) => {
      if (request.method === 'GET') {
        stream = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: endpoint\ndata: /messages?session=abc\n\n');
        return;
      }
      if (request.url === '/mcp') { response.writeHead(405).end(); return; }
      const message = await body(request);
      response.writeHead(202).end();
      if (message.id !== undefined) stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) })}\n\n`);
    });
    const { tools, notes } = await manager([{ name: 'old', transport: 'http', url, headers: {} }]).toolset();
    expect(notes).toEqual([]);
    expect((await find(tools, 'mcp__old__lookup').run({ q: 'dogs' }, ctx())).output).toBe('found dogs');
  });

  it('an unreachable URL is a note', async () => {
    const { tools, notes } = await manager([{ name: 'gone', transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: {} }]).toolset();
    expect(tools).toEqual([]);
    expect(notes[0]).toMatch(/"gone" is unavailable/);
  });
});

// ── through the agent loop ───────────────────────────────────────────────────

describe('in a turn', () => {
  it('offers MCP tools to the model, runs a read one freely, and asks before any other', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    const approvals: string[] = [];
    const client = new ScriptedModelClient([
      { toolCalls: [{ id: 'c1', name: 'mcp__fake__echo', args: { text: 'hello' } }] },
      { toolCalls: [{ id: 'c2', name: 'mcp__fake__fail', args: {} }] },
      { text: 'done' },
    ]);
    const stateDir = join(dir, 'state');
    const result = await runGatewayHarnessTurn({
      sessionId: 'mcp-turn', cwd: dir, stateDir, homeDir: dir, prompt: 'go', permissionMode: 'auto',
      modelClient: client, extraTools: tools,
      onApproval: async (title, detail) => { approvals.push(`${title}\n${detail}`); return true; },
    });
    disposeSessionState(stateDir, 'mcp-turn');
    expect(result.text).toBe('done');
    expect(client.requests[0].tools.map((tool) => tool.name)).toContain('mcp__fake__echo');
    // The read-only tool ran without a prompt; the other asked even in auto mode.
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain('fake › fail');
    expect(approvals[0]).toContain('MCP server: fake');
    const results = client.requests[2].items.filter((item) => item.type === 'tool_result');
    expect(results.map((item) => item.type === 'tool_result' && [item.output.split('\n')[0], item.isError ?? false]))
      .toEqual([['echo: hello', false], ['the widget is jammed', true]]);
  });

  it('remembers "always" for exactly that MCP tool, from the next turn on', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    const rules: Array<string | undefined> = [];
    const stateDir = join(dir, 'state');
    const turn = async (id: string) => {
      await runGatewayHarnessTurn({
        sessionId: id, cwd: dir, stateDir, homeDir: dir, prompt: 'go', permissionMode: 'ask', extraTools: tools,
        modelClient: new ScriptedModelClient([
          { toolCalls: [{ id: 'c1', name: 'mcp__fake__fail', args: {} }] },
          { toolCalls: [{ id: 'c2', name: 'mcp__fake__picture', args: {} }] },
          { text: 'done' },
        ]),
        onApproval: async (_title, _detail, rule) => { rules.push(rule); return 'always'; },
      });
      disposeSessionState(stateDir, id);
    };
    await turn('mcp-always-1');
    expect(rules).toEqual(['mcp__fake__fail', 'mcp__fake__picture']);
    const saved = JSON.parse(await readFile(join(dir, '.clikcode', 'settings.local.json'), 'utf8'));
    expect(saved.permissions.allow).toEqual(['mcp__fake__fail', 'mcp__fake__picture']);
    await turn('mcp-always-2');
    expect(rules).toHaveLength(2);
  });
});

describe('resources', () => {
  const resourceCtx = (acceptsImages = false): ToolContext => ({ acceptsImages } as unknown as ToolContext);

  it('offers no resource tools when no server has resources', async () => {
    const { tools } = await manager([fake('fake')]).toolset();
    expect(tools.map((tool) => tool.name)).not.toContain('list_mcp_resources');
    expect(tools.map((tool) => tool.name)).not.toContain('read_mcp_resource');
  });

  it('lists every page of every resource server, or only the one named', async () => {
    const { tools } = await manager([fake('docs', { FAKE_MCP_RESOURCES: '1' }), fake('plain')]).toolset();
    const list = find(tools, 'list_mcp_resources');
    expect(list.class).toBe('read');
    expect(list.mcp).toBeUndefined();
    expect((list.parameters as { properties: { server: { enum: string[] } } }).properties.server.enum).toEqual(['docs']);
    const all = await list.run({}, resourceCtx());
    expect(all.isError).toBeFalsy();
    expect(all.output).toBe([
      'docs: 3 resources',
      '- file:///notes/todo.md (todo.md, text/markdown): What is left to do.',
      '- file:///img/dot.png (dot.png, image/png)',
      '- file:///bin/report.pdf (report.pdf, application/pdf)',
    ].join('\n'));
    expect((await list.run({ server: 'plain' }, resourceCtx())).isError).toBe(true);
  });

  it('reads text as text, summarizes a blob, and names a missing resource', async () => {
    const { tools } = await manager([fake('docs', { FAKE_MCP_RESOURCES: '1' })]).toolset();
    const read = find(tools, 'read_mcp_resource');
    expect(await read.run({ server: 'docs', uri: 'file:///notes/todo.md' }, resourceCtx())).toEqual({ output: '- ship resources' });
    expect((await read.run({ server: 'docs', uri: 'file:///bin/report.pdf' }, resourceCtx(true))).output).toBe('[binary resource file:///bin/report.pdf (application/pdf), 2.0 KB]');
    const missing = await read.run({ server: 'docs', uri: 'file:///nope' }, resourceCtx());
    expect(missing.isError).toBe(true);
    expect(missing.output).toMatch(/Resource not found: file:\/\/\/nope/);
  });

  it('attaches an image resource for a model that can see it, and only summarizes it for one that cannot', async () => {
    const { tools } = await manager([fake('docs', { FAKE_MCP_RESOURCES: '1' })]).toolset();
    const read = find(tools, 'read_mcp_resource');
    const seen = await read.run({ server: 'docs', uri: 'file:///img/dot.png' }, resourceCtx(true));
    expect(seen.output).toMatch(/attached for you to see/);
    expect(seen.images).toEqual([{ mimeType: 'image/png', data: expect.any(String), name: 'file:///img/dot.png' }]);
    const blind = await read.run({ server: 'docs', uri: 'file:///img/dot.png' }, resourceCtx(false));
    expect(blind.images).toBeUndefined();
    expect(blind.output).toMatch(/^\[binary resource file:\/\/\/img\/dot\.png \(image\/png\), \d+ B\]$/);
  });

  it('restarts a resource server that died since the listing', async () => {
    const pidFile = join(dir, 'docs.pid');
    const { tools } = await manager([fake('docs', { FAKE_MCP_RESOURCES: '1', FAKE_MCP_PID_FILE: pidFile })]).toolset();
    const first = Number(await readFile(pidFile, 'utf8'));
    process.kill(first, 'SIGKILL');
    await until(() => !alive(first));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await find(tools, 'read_mcp_resource').run({ server: 'docs', uri: 'file:///notes/todo.md' }, resourceCtx())).output).toBe('- ship resources');
  });
});
