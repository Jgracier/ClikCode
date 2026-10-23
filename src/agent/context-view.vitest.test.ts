import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ConversationItem, ToolSpec } from './model-client.js';
import type { ToolContext } from './tool-contract.js';
import { ContextFitError, estimateRequestTokens, fitContext, responseReserve } from './context-view.js';
import { exposeSpecialists } from './on-demand-tools.js';
import { defaultTools, toolSpecs } from './tools/registry.js';
import { readContextTool } from './tools/read-context.js';
import { retainToolOutput } from './tool-output.js';
import { fullRecordPath } from '../session/full-record.js';
import { toolOutputDir } from './security.js';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'context-fit-')); roots.push(dir); return dir; }
const user = (text: string): ConversationItem => ({ type: 'text', role: 'user', text });
function history(count: number): ConversationItem[] {
  const items = [user('Keep existing permissions. Do not delete customer data.')];
  for (let i = 0; i < count; i++) items.push(
    { type: 'text', role: 'assistant', text: `Inspecting file ${i}` },
    { type: 'tool_call', name: 'read_file', id: `r${i}`, args: { path: `file-${i}` } },
    { type: 'tool_result', name: 'read_file', id: `r${i}`, output: `file ${i}\n${'old diagnostic output '.repeat(400)}\nend ${i}` },
  );
  return [...items, user('Fix file 19 without changing permissions.')];
}
const tools: ToolSpec[] = ['read_file', 'read_context', 'load_tools'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }));

it.each([4096, 8192, 16384, 32768, 131072])('fits a %i-token model while preserving user requests, call pairs and the durable input', (window) => {
  const items = history(30);
  const original = JSON.stringify(items);
  const view = fitContext({ system: 'Follow the user and preserve permissions.', items, tools, window });
  expect(view.estimatedTokens + responseReserve(window) + Math.max(128, Math.ceil(window * .05))).toBeLessThanOrEqual(window);
  expect(view.items.filter((item) => item.type === 'text' && item.role === 'user')).toEqual(items.filter((item) => item.type === 'text' && item.role === 'user'));
  const calls = new Set(view.items.flatMap((item) => item.type === 'tool_call' ? [item.id] : []));
  for (const item of view.items) if (item.type === 'tool_result') expect(calls.has(item.id)).toBe(true);
  expect(JSON.stringify(items)).toBe(original);
  expect(view.items.some((item) => item.type === 'summary')).toBe(false);
});

it('keeps a fitting request byte-stable and accounts for UTF-8, schemas and images', () => {
  const items = [user('hello')];
  expect(fitContext({ system: 's', items, tools, window: 131072 }).items).toBe(items);
  expect(estimateRequestTokens('界'.repeat(100), items, tools)).toBeGreaterThan(estimateRequestTokens('x'.repeat(100), items, tools));
  expect(estimateRequestTokens('s', [{ ...user('image'), type: 'text', role: 'user', text: 'image', images: [{ mimeType: 'image/png', data: 'x'.repeat(100000) }] }], tools)).toBeLessThan(5000);
});

it('fails explicitly when essential user instructions cannot fit', () => {
  expect(() => fitContext({ system: 'policy', items: [user('mandatory '.repeat(20000))], tools, window: 4096 })).toThrow(ContextFitError);
});

it('never alters signed reasoning or splits its tool step', () => {
  const items: ConversationItem[] = [user('task'), { type: 'reasoning', text: 'signed thought', signature: 'signature', model: 'm' }, { type: 'tool_call', name: 'read_file', id: 'signed', args: {} }, { type: 'tool_result', name: 'read_file', id: 'signed', output: 'x'.repeat(40000) }];
  const view = fitContext({ system: 's', items, tools, window: 4096 });
  expect(view.items.find((item) => item.type === 'reasoning')).toEqual(items[1]);
  expect(view.items.some((item) => item.type === 'tool_call' && item.id === 'signed')).toBe(true);
});

it('defers specialist schemas, then restores them from the transcript without changing execution definitions', () => {
  const definitions = defaultTools();
  const exposure = exposeSpecialists(definitions);
  const first = exposure.advertised([]);
  expect(first.some((tool) => tool.name === 'agent')).toBe(false);
  expect(first.some((tool) => tool.name === 'load_tools')).toBe(true);
  expect(JSON.stringify(toolSpecs(first)).length).toBeLessThan(JSON.stringify(toolSpecs(definitions)).length);
  const restored = exposure.advertised([{ type: 'tool_call', id: 'load', name: 'load_tools', args: { tools: ['agent'] } }]);
  expect(restored.find((tool) => tool.name === 'agent')).toBe(definitions.find((tool) => tool.name === 'agent'));
});

it('retrieves omitted middle evidence from the full session history and isolates handoff records', async () => {
  const stateDir = await temp();
  const items: ConversationItem[] = [{ type: 'tool_result', id: 'r1', name: 'read_file', output: `${'x'.repeat(10000)}critical evidence${'y'.repeat(10000)}` }];
  const reader = readContextTool(() => items);
  const ctx = { stateDir, sessionId: 's1', outputCap: 1024 } as ToolContext;
  expect((await reader.run({ source: 'tool', id: 'r1', query: 'critical evidence', limit: 512 }, ctx)).output).toContain('critical evidence');
  expect((await reader.run({ id: 'item:0', offset: 9950, limit: 512 }, ctx)).output).toContain('critical evidence');
  expect((await reader.run({ id: '../../other' }, ctx)).isError).toBe(true);
  const file = fullRecordPath(stateDir, 's1');
  await mkdir(join(stateDir, 'records'), { recursive: true });
  await writeFile(file, `${'a'.repeat(8190)}boundary needle${'b'.repeat(10000)}`);
  expect((await reader.run({ source: 'handoff', query: 'boundary needle', limit: 512 }, ctx)).output).toContain('boundary needle');
  expect((await readContextTool(() => items, false).run({ source: 'handoff' }, ctx)).isError).toBe(true);
  expect((await reader.run({ source: 'handoff' }, { ...ctx, sessionId: 's2' })).isError).toBe(true);
});

it('saves full oversized outputs once in private session artifacts and supplies a bounded reference', async () => {
  const stateDir = await temp();
  const output = `head\n${'x'.repeat(20000)}\nimportant middle\n${'y'.repeat(20000)}\ntail`;
  const shown = await retainToolOutput(output, 2048, stateDir, 's1', 'call');
  expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(2048);
  expect(shown).toContain('Full output saved');
  expect(shown).toContain('tail');
  const dir = toolOutputDir(stateDir, 's1');
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(await readFile(join(dir, files[0]!), 'utf8')).toBe(output);
  expect((await stat(join(dir, files[0]!))).mode & 0o777).toBe(0o600);
  await retainToolOutput(output, 2048, stateDir, 's1', 'call');
  expect(await readdir(dir)).toEqual(files);
});
