import { expect, it, vi } from 'vitest';
import type { ToolContext } from '../tool-contract.js';

const mock = vi.hoisted(() => ({ enabled: true, run: vi.fn() }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => mock.enabled }));
vi.mock('../computer/browser.js', () => ({ computerPage: async () => ({}) }));
vi.mock('../computer/tailcat-handoff.js', () => ({ runTailcatHandoff: mock.run }));
import { computerHandoffTool } from './computer-handoff.js';

it('shows the one-use phone link and resumes when the user finishes', async () => {
  mock.run.mockImplementationOnce(async ({ onLink }: { onLink(link: string): void }) => {
    onLink('https://jgracier.github.io/ClikCode/handoff/#addr=test&token=test');
  });
  const output: string[] = [];
  const result = await computerHandoffTool.run({}, { stateDir: '/tmp/computer-handoff-test', emitOutput: text => output.push(text) } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('Continue the task');
  expect(output).toEqual([expect.stringContaining('https://jgracier.github.io/ClikCode/handoff/#')]);
  expect(mock.run).toHaveBeenCalledWith(expect.objectContaining({ stateDir: '/tmp/computer-handoff-test' }));
});

it('reports an unavailable handoff without reporting success', async () => {
  mock.run.mockRejectedValueOnce(new Error('Tailcat could not start.'));
  const result = await computerHandoffTool.run({}, { stateDir: '/tmp/computer-handoff-test' } as ToolContext);
  expect(result).toMatchObject({ isError: true, output: 'Tailcat could not start.' });
});
