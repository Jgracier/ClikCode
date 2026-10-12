import { describe, expect, it } from 'vitest';
import { BackgroundAgents } from '../background-agents.js';
import { listAgentsTool } from './list-agents.js';
import type { ToolContext } from '../tool-contract.js';

describe('the list_agents tool', () => {
  it('is a concurrent-safe read tool', () => {
    expect(listAgentsTool.class).toBe('read');
  });

  it('says so when there are no background agents, or the context has none', async () => {
    expect((await listAgentsTool.run({}, {} as ToolContext)).output).toMatch(/No background agents/);
    expect((await listAgentsTool.run({}, { agents: new BackgroundAgents() } as ToolContext)).output).toMatch(/No background agents/);
  });

  it('lists each agent with its state and whether its result reached the model', async () => {
    const agents = new BackgroundAgents();
    let release!: () => void;
    const running = agents.start('slow one', () => new Promise((resolve) => { release = () => resolve({ output: 'ok' }); }));
    const finished = agents.start('quick one', async () => ({ output: 'done' }));
    const failed = agents.start('broken one', async () => ({ output: 'boom', isError: true }));
    await agents.wait(finished, 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const lines = (await listAgentsTool.run({}, { agents } as ToolContext)).output.split('\n');
    expect(lines).toEqual([
      `${running}  running  slow one`,
      `${finished}  finished, result delivered  quick one`,
      `${failed}  failed, result not yet delivered  broken one`,
    ]);
    release();
    await agents.settled();
  });
});
