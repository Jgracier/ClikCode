import { afterEach, expect, it, vi } from 'vitest';
import { hotTool } from './hot-tools.js';
import { sharedState } from './shared-state.js';
import type { ToolDefinition } from '../tool-contract.js';

afterEach(() => { vi.unstubAllEnvs(); });

it('runs the tool in the program when there is no rebuilt copy beside it, keeping its description', async () => {
  const tool = { name: 'demo', class: 'exec', description: 'd', parameters: { type: 'object', properties: {} }, run: async () => ({ output: 'in the program' }) } as unknown as ToolDefinition;
  const hot = hotTool(tool);
  expect(hot.description).toBe('d');
  expect((await hot.run({} as never, {} as never)).output).toBe('in the program');
});

it('gives a reloaded module the same state object', () => {
  const first = sharedState('test-key', () => new Map([['a', 1]]));
  const second = sharedState('test-key', () => new Map<string, number>());
  expect(second).toBe(first);
});

it('runs a rebuilt copy as soon as its file changes, and falls back to the program if the copy is broken', async () => {
  const { writeFile, rm, utimes } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const file = fileURLToPath(new URL('./computer-tools.js', import.meta.url));
  const copy = (version: string): string => `export const computerToolSet = [{ name: 'demo', run: async () => ({ output: '${version}' }) }];`;
  const tool = { name: 'demo', class: 'exec', description: 'd', parameters: { type: 'object', properties: {} }, run: async () => ({ output: 'program' }) } as unknown as ToolDefinition;
  const hot = hotTool(tool);
  vi.stubEnv('CLIKCODE_HOT_TOOLS', '1');
  try {
    await writeFile(file, copy('v1'));
    expect((await hot.run({} as never, {} as never)).output).toBe('v1');
    await writeFile(file, copy('v2'));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect((await hot.run({} as never, {} as never)).output).toBe('v2');
    await writeFile(file, 'export const computerToolSet = (() => { throw new Error("broken build"); })();');
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    const broken = (await hot.run({} as never, {} as never)).output;
    expect(broken).toContain('did not load');
    expect(broken).toContain('program');
    // Said once: the next call is the plain result.
    expect((await hot.run({} as never, {} as never)).output).toBe('program');
  } finally { await rm(file, { force: true }); }
});

it('never reloads outside development: an installed build runs the program\'s own tools', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const file = fileURLToPath(new URL('./computer-tools.js', import.meta.url));
  const tool = { name: 'demo', class: 'exec', description: 'd', parameters: { type: 'object', properties: {} }, run: async () => ({ output: 'program' }) } as unknown as ToolDefinition;
  vi.stubEnv('CLIKCODE_HOT_TOOLS', '0');
  try {
    await writeFile(file, `export const computerToolSet = [{ name: 'demo', run: async () => ({ output: 'next version' }) }];`);
    expect((await hotTool(tool).run({} as never, {} as never)).output).toBe('program');
  } finally { await rm(file, { force: true }); }
});
