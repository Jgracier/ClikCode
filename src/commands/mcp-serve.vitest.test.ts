import { rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildChangedSinceListed, handleMcpRequest } from './mcp-serve.js';

const file = fileURLToPath(new URL('../agent/computer/computer-tools.js', import.meta.url));
const copy = (extra: string): string => `export const computerToolSet = [{ name: 'browser_use', description: 'new', parameters: { type: 'object', properties: { action: { type: 'string' }${extra} } }, run: async () => ({ output: 'x' }) }];`;
type ListResult = { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };

it('lists the installed build\'s schema, and notices a newer build once after the list was given out', async () => {
  try {
    await writeFile(file, copy(''));
    const first = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as unknown as ListResult;
    expect(Object.keys(first.result.tools.find(tool => tool.name === 'browser_use')!.inputSchema.properties)).toEqual(['action']);
    expect(await buildChangedSinceListed()).toBe(false);
    await writeFile(file, copy(", connectionValues: { type: 'object' }"));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect(await buildChangedSinceListed()).toBe(true);
    expect(await buildChangedSinceListed()).toBe(false); // told once per build
    const again = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as unknown as ListResult;
    expect(Object.keys(again.result.tools.find(tool => tool.name === 'browser_use')!.inputSchema.properties)).toContain('connectionValues');
  } finally { await rm(file, { force: true }); }
});

it('says restart needed when a call is rejected for its arguments after the build changed', async () => {
  try {
    await writeFile(file, copy(''));
    await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await writeFile(file, copy(', y: { type: \'string\' }'));
    await utimes(file, new Date(), new Date(Date.now() + 9_000));
    const reply = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_use', arguments: {} } }, async () => ({ ok: false, output: 'Invalid arguments: args.y: unknown property' })) as unknown as { result: { content: { text: string }[] } };
    expect(reply.result.content[0]!.text).toContain('restart needed');
  } finally { await rm(file, { force: true }); }
});

type CallResult = { result: { content: { text: string }[]; isError: boolean } };

it('serves the conversation tools exactly as the Gateway agent has them, and computer tools only while computer use is on', async () => {
  const { CONVERSATION_TOOLS, CONVERSATION_TOOLS_NOTE } = await import('../search/tools.js');
  const init = await handleMcpRequest({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) as unknown as { result: { instructions: string } };
  expect(init.result.instructions).toBe(CONVERSATION_TOOLS_NOTE);
  const { stateDirectory } = await import('../session/store/paths.js');
  const settings = `${stateDirectory()}/computer/settings.json`;
  const { mkdir } = await import('node:fs/promises');
  try {
    await writeFile(file, copy(''));
    const on = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as unknown as { result: { tools: { name: string; description: string; inputSchema: unknown }[] } };
    for (const tool of CONVERSATION_TOOLS) expect(on.result.tools.find(listed => listed.name === tool.name)).toEqual({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    expect(on.result.tools.map(tool => tool.name)).toContain('browser_use');
    await mkdir(`${stateDirectory()}/computer`, { recursive: true });
    await writeFile(settings, '{"enabled":false}');
    const off = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as unknown as ListResult;
    expect(off.result.tools.map(tool => tool.name)).toEqual(CONVERSATION_TOOLS.map(tool => tool.name));
    const refused = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_use', arguments: {} } }) as unknown as { error?: unknown; result?: CallResult['result'] };
    expect(refused.error ?? refused.result?.isError).toBeTruthy();
  } finally { await rm(file, { force: true }); await rm(settings, { force: true }); }
});

it('binds a conversation tool to the chat whose worker started the server', async () => {
  const { readState } = await import('../session/state/read.js');
  const { writeState } = await import('../session/state/write.js');
  const { resetCorpusCache } = await import('../search/corpus.js');
  const { resetHarnessStateCaches } = await import('../session/state/index-file.js');
  resetCorpusCache(); resetHarnessStateCaches();
  const id = 'cccccccc-3333-4333-8333-333333333333';
  const state = await readState();
  state.sessions.push({ id, route: 'local', accountId: null, provider: 'anthropic', model: 'claude', effort: 'medium', permissionMode: 'ask', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active', nativeHarness: 'claude', name: 'Bound chat',
    messages: [{ role: 'user', content: 'the flux capacitor needs 1.21 gigawatts' }, { role: 'assistant', content: 'noted' }] } as never);
  await writeState(state);
  const call = (chat: () => Promise<string | undefined>) => handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hindsight', arguments: { query: 'gigawatts' } } }, undefined, chat) as unknown as Promise<CallResult>;
  const bound = await call(async () => id);
  expect(bound.result.isError).toBe(false);
  expect(bound.result.content[0]!.text).toContain('gigawatts');
  const unbound = await call(async () => undefined);
  expect(unbound.result.isError).toBe(true);
  expect(unbound.result.content[0]!.text).toBe('hindsight is this conversation, and this call has none.');
});

it('lists the computer tools behind one loader for a harness that re-reads tool lists, and tells the client once they load', async () => {
  const { deferComputerTools, takeListChanged, LOAD_COMPUTER_TOOLS } = await import('./mcp-serve.js');
  try {
    await writeFile(file, copy(''));
    deferComputerTools(true);
    const before = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as unknown as ListResult & { result: { tools: { description: string }[] } };
    const names = before.result.tools.map(tool => tool.name);
    expect(names).toContain(LOAD_COMPUTER_TOOLS);
    expect(names).not.toContain('browser_use');
    expect(JSON.stringify(before.result.tools)).toContain('browser_use: new');
    expect(takeListChanged()).toBe(false);
    const loaded = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: LOAD_COMPUTER_TOOLS, arguments: {} } }) as unknown as CallResult;
    expect(loaded.result.isError).toBe(false);
    expect(loaded.result.content[0]!.text).toContain('browser_use');
    expect(takeListChanged()).toBe(true);
    expect(takeListChanged()).toBe(false);
    const after = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as unknown as ListResult;
    expect(after.result.tools.map(tool => tool.name)).toContain('browser_use');
    expect(after.result.tools.map(tool => tool.name)).not.toContain(LOAD_COMPUTER_TOOLS);
  } finally { deferComputerTools(false); await rm(file, { force: true }); }
});
