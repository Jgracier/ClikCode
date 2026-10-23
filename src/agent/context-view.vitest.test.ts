import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationItem, ToolSpec } from './model-client.js';
import type { ToolContext } from './tool-contract.js';
import { ContextFitError, estimateRequestTokens, fitContext, isHarnessNote, responseReserve, shrinkArgs } from './context-view.js';
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


it('bounds a long run of silent tool steps independently instead of pinning them as one giant step', () => {
  const items: ConversationItem[] = [user('Preserve customer data.')];
  for (let i = 0; i < 1000; i++) items.push(
    { type: 'tool_call', id: `silent-${i}`, name: 'read_file', args: { path: `file-${i}` } },
    { type: 'tool_result', id: `silent-${i}`, name: 'read_file', output: 'diagnostics '.repeat(100) },
  );
  const view = fitContext({ system: 'instructions', items, tools, window: 8192 });
  expect(view.estimatedTokens + responseReserve(8192) + 410).toBeLessThanOrEqual(8192);
  expect(view.items.some((item) => item.type === 'tool_result' && item.id === 'silent-999')).toBe(true);
  const calls = new Set(view.items.flatMap((item) => item.type === 'tool_call' ? [item.id] : []));
  for (const item of view.items) if (item.type === 'tool_result') expect(calls.has(item.id)).toBe(true);
});


it('can keep working after years of prior requests without pinning them all in each request', async () => {
  const items: ConversationItem[] = Array.from({ length: 3000 }, (_, i) => user(`Earlier request ${i}: ${'archived context '.repeat(20)}`));
  items.push(user('Current task: fix the parser without deleting data.'));
  const original = JSON.stringify(items);
  const view = fitContext({ system: 'policy', items, tools, window: 4096 });
  expect(view.items).toContainEqual(items.at(-1));
  expect(view.items.length).toBeLessThan(100);
  expect(view.estimatedTokens + responseReserve(4096) + 205).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(items)).toBe(original);
  const read = await readContextTool(() => items).run({ id: 'item:0' }, { outputCap: 1024 } as ToolContext);
  expect(read.output).toContain('Earlier request 0');
});

it('keeps the actual user task pinned after internal continuation messages', () => {
  const items: ConversationItem[] = [user('actual current task'), { type: 'text', role: 'assistant', text: 'a'.repeat(40000) }, { type: 'text', role: 'user', source: 'harness', text: '[harness] Continue.' }];
  const view = fitContext({ system: 's', items, tools, window: 4096 });
  expect(view.items).toContainEqual(items[0]);
});


it('retains the unfinished reply anchor when older requests compete for a small context', () => {
  const items: ConversationItem[] = Array.from({ length: 200 }, (_, i) => user(`Archived instruction ${i}: ${'older request '.repeat(50)}`));
  const task = user('Continue the current implementation.');
  items.push(task, { type: 'text', role: 'assistant', text: `${'unfinished reply '.repeat(400)}TAIL_TO_CONTINUE` }, { type: 'text', role: 'user', source: 'harness', text: '[harness] Continue exactly where the reply stopped.' });
  const view = fitContext({ system: 's', items, tools, window: 4096 });
  expect(view.items).toContainEqual(task);
  expect(view.items.some((item) => item.type === 'text' && item.role === 'assistant' && item.text.includes('TAIL_TO_CONTINUE'))).toBe(true);
});

// ── the failure seen on a real 32,000-token model (2026-10-23): a ~5k-token request, five agents launched with long prompts, ──
// ── notices written before they carried `source: 'harness'`. The turn ended: "need about 30,550 input tokens ... beyond 32,000". ──

const call = (id: string, prompt: string): ConversationItem => ({ type: 'tool_call', id, name: 'agent', args: { prompt, description: 'Audit one area', background: true } });
const result = (id: string, output: string): ConversationItem => ({ type: 'tool_result', id, name: 'agent', output });
const note = (text: string): ConversationItem => ({ type: 'text', role: 'user', text });

describe('a context view that is truly minimal', () => {
  const longPrompt = 'Audit the area read-only and write findings. '.repeat(140); // ~6,300 characters, like the real launches
  const launchStep = (n: number): ConversationItem[] => Array.from({ length: 5 }, (_, i) => call(`s${n}c${i}`, longPrompt));
  const history = (): ConversationItem[] => [
    user('earlier request'),
    ...launchStep(1), ...launchStep(1).map((c) => result((c as { id: string }).id, 'Started in the background.')),
    note('[background agent agent_1 finished with an error] Audit: the model provider failed to produce a response.'),
    note('[background agent agent_2 finished with an error] Audit: the model provider failed to produce a response.'),
    user(`The real request. ${'It is long and must stay verbatim. '.repeat(430)}`), // ~15k characters, ~5k tokens
    ...launchStep(2),
  ];
  // The fixed part of the prompt (instructions and offered tools) on that model: most of a 32k window.
  const system = 'instructions '.repeat(2_800);

  it('does not refuse a request that fits once the arguments of old calls are shrunk', () => {
    const view = fitContext({ system, items: history(), tools, window: 32_000 });
    expect(view.estimatedTokens + responseReserve(32_000) + 1_600).toBeLessThanOrEqual(32_000);
    expect(view.items).toContainEqual(history().find((i) => i.type === 'text' && i.role === 'user' && i.text.startsWith('The real request.')));
  });

  it('keeps every call a valid call: same id, same name, same keys, only the long strings cut, with a way to read them whole', () => {
    const view = fitContext({ system, items: history(), tools, window: 32_000 });
    const kept = view.items.filter((i): i is Extract<ConversationItem, { type: 'tool_call' }> => i.type === 'tool_call');
    expect(kept.length).toBeGreaterThan(0);
    for (const c of kept) {
      expect(Object.keys(c.args).sort()).toEqual(['background', 'description', 'prompt']);
      expect(c.args.background).toBe(true);
      expect(String(c.args.prompt).length).toBeLessThanOrEqual(longPrompt.length);
    }
    expect(kept.some((c) => String(c.args.prompt).includes('read_context source=history id="item:'))).toBe(true);
  });

  it('what was cut can be read whole, by the id the excerpt names', async () => {
    const items = history();
    const index = items.findIndex((i) => i.type === 'tool_call');
    const read = await readContextTool(() => items).run({ id: `item:${index}` }, { outputCap: 8_192 } as ToolContext);
    expect(read.output).toContain(longPrompt.slice(0, 200));
  });

  it('lets go of the kept steps rather than refuse, when even their smallest excerpts will not fit', () => {
    // The request alone takes nearly the whole budget; three kept steps at 256 characters each do not fit beside it.
    const request = user(`Do it. ${'All of this matters. '.repeat(1_000)}`);
    const items = [user('earlier'), ...launchStep(1), request, ...launchStep(2)];
    const bare = estimateRequestTokens('s', [request], tools);
    const window = Math.ceil((bare + 60) / 0.7) + 1; // budget ~ bare + 60: no room for any kept step
    const view = fitContext({ system: 's', items, tools, window, outputReserve: Math.floor(window * 0.2) });
    expect(view.items).toContainEqual(request);
    expect(view.items.some((i) => i.type === 'tool_call')).toBe(false);
    expect(view.omittedGroups).toBeGreaterThan(0);
  });

  it('still refuses when the request and the instructions alone cannot fit: that is the real limit', () => {
    const huge = user('x'.repeat(200_000));
    expect(() => fitContext({ system, items: [user('a'), huge], tools, window: 32_000 })).toThrow(ContextFitError);
  });
});

describe('harness notices are not the user\'s requests', () => {
  it('recognises a notice with the flag, and one written before the flag existed', () => {
    expect(isHarnessNote({ type: 'text', role: 'user', source: 'harness', text: 'anything' })).toBe(true);
    for (const text of ['[background agent agent_3 finished] done', '[background shell sh_1 finished] exit 0', '[harness] Continue.', '[Stop hook] again', '[SubagentStop hook] again']) {
      expect(isHarnessNote(note(text)), text).toBe(true);
    }
  });
  it('never takes the user\'s own words, however they begin', () => {
    for (const text of ['hey', 'Please [harness] this', 'background agents: how do they work?', '[a link](https://x) says hi']) expect(isHarnessNote(note(text)), text).toBe(false);
    expect(isHarnessNote({ type: 'text', role: 'assistant', text: '[background agent x] y' })).toBe(false);
  });
  it('the request kept verbatim is the user\'s, not a later notice', () => {
    const request = user(`Real request. ${'detail '.repeat(1_500)}`);
    const items = [user('old'), { type: 'text', role: 'assistant', text: 'ok '.repeat(9_000) } as ConversationItem, request, note('[background agent agent_1 finished] short')];
    const view = fitContext({ system: 's', items, tools, window: 8_192 });
    expect(view.items).toContainEqual(request);
  });
});

describe('shrinkArgs', () => {
  it('cuts long strings, keeps keys and short values, and names how to read the rest', () => {
    const out = shrinkArgs({ prompt: 'p'.repeat(5_000), flag: true, n: 3, short: 'ok' }, 300, 'source=history id="item:4"');
    expect(Object.keys(out)).toEqual(['prompt', 'flag', 'n', 'short']);
    expect(String(out.prompt).length).toBeLessThan(500);
    expect(String(out.prompt)).toContain('read_context source=history id="item:4"');
    expect(out).toMatchObject({ flag: true, n: 3, short: 'ok' });
  });
  it('reaches into nested values and trims long lists, saying how many it left out', () => {
    const out = shrinkArgs({ edits: Array.from({ length: 12 }, (_, i) => ({ old: 'o'.repeat(600), new: `n${i}` })) }, 100, 'source=history id="item:1"') as { edits: unknown[] };
    expect(out.edits).toHaveLength(9);
    expect(String(out.edits[8])).toContain('4 more');
    expect(String((out.edits[0] as { old: string }).old).length).toBeLessThan(300);
  });
  it('returns small arguments as they were', () => {
    const args = { path: 'src/a.ts', old_string: 'a', new_string: 'b' };
    expect(shrinkArgs(args, 300, 'r')).toEqual(args);
  });
});

describe('read_context tells a small model what to do next', () => {
  const run = (args: Record<string, unknown>) => readContextTool(() => [user('a'), user('b')]).run(args as never, { outputCap: 4_096 } as ToolContext);
  it('a tool read without an id asks for one, instead of naming "undefined"', async () => {
    const out = await run({ source: 'tool' });
    expect(out.isError).toBe(true);
    expect(out.output).toContain('id is required');
    expect(out.output).not.toContain('undefined');
  });
  it('an unknown history id names the valid range and the way to search', async () => {
    const out = await run({ id: 'item:99' });
    expect(out.isError).toBe(true);
    expect(out.output).toContain('0 to 1');
    expect(out.output).toContain('query');
  });
});
