import { rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildChangedSinceListed, handleMcpRequest } from './mcp-serve.js';

const file = fileURLToPath(new URL('../agent/computer/computer-tools.js', import.meta.url));
const copy = (extra: string): string => `export const computerToolSet = [{ name: 'computer_web', description: 'new', parameters: { type: 'object', properties: { action: { type: 'string' }${extra} } }, run: async () => ({ output: 'x' }) }];`;
type ListResult = { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };

it('lists the installed build\'s schema, and notices a newer build once after the list was given out', async () => {
  try {
    await writeFile(file, copy(''));
    const first = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as unknown as ListResult;
    expect(Object.keys(first.result.tools.find(tool => tool.name === 'computer_web')!.inputSchema.properties)).toEqual(['action']);
    expect(await buildChangedSinceListed()).toBe(false);
    await writeFile(file, copy(", connectionValues: { type: 'object' }"));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect(await buildChangedSinceListed()).toBe(true);
    expect(await buildChangedSinceListed()).toBe(false); // told once per build
    const again = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as unknown as ListResult;
    expect(Object.keys(again.result.tools.find(tool => tool.name === 'computer_web')!.inputSchema.properties)).toContain('connectionValues');
  } finally { await rm(file, { force: true }); }
});

it('says restart needed when a call is rejected for its arguments after the build changed', async () => {
  try {
    await writeFile(file, copy(''));
    await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await writeFile(file, copy(', y: { type: \'string\' }'));
    await utimes(file, new Date(), new Date(Date.now() + 9_000));
    const reply = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'computer_web', arguments: {} } }, async () => ({ ok: false, output: 'Invalid arguments: args.y: unknown property' })) as unknown as { result: { content: { text: string }[] } };
    expect(reply.result.content[0]!.text).toContain('restart needed');
  } finally { await rm(file, { force: true }); }
});
