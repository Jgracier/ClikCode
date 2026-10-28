import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What each model step writes to the lifecycle log: the tokens it read and how many of them the server already held.
const logged = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock('../runtime/lifecycle-log.js', async (original) => ({
  ...await original<typeof import('../runtime/lifecycle-log.js')>(),
  lifecycle: (event: string, fields: Record<string, unknown> = {}) => { logged.push({ event, fields }); },
}));

const { runAgentLoop } = await import('./run-turn.js');
const { ScriptedModelClient } = await import('./testing.js');

let root: string;
beforeEach(async () => {
  logged.length = 0;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-step-log-')));
  await Promise.all(['work', 'state', 'home'].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const run = (client: InstanceType<typeof ScriptedModelClient>) => runAgentLoop({
  sessionId: 's-log', cwd: path.join(root, 'work'), stateDir: path.join(root, 'state'), homeDir: path.join(root, 'home'),
  userConfigDir: path.join(root, 'config'), prompt: 'hello', permissionMode: 'bypass', modelClient: client,
  onActivity: () => undefined, onResponseDelta: () => undefined,
});

describe('a model step in the lifecycle log', () => {
  it('says how much it read and how much of that the server already held', async () => {
    await run(new ScriptedModelClient([
      { text: 'one', toolCalls: [{ name: 'read_context', args: { source: 'history', id: 'item:0' } }], usage: { input: 9_000, cached: 8_100, output: 40 } },
      { text: 'done', usage: { input: 9_300, cached: 9_000, output: 12 } },
    ]));
    const steps = logged.filter((entry) => entry.event === 'turn.step').map((entry) => entry.fields);
    expect(steps.map((step) => [step.input, step.cached, step.output])).toEqual([[9_000, 8_100, 40], [9_300, 9_000, 12]]);
  });

  it('leaves out what the model did not report, rather than writing zeros', async () => {
    await run(new ScriptedModelClient([{ text: 'done', usage: { output: 5 } }]));
    const step = logged.find((entry) => entry.event === 'turn.step')!.fields;
    expect(step).not.toHaveProperty('input');
    expect(step).not.toHaveProperty('cached');
    expect(step.output).toBe(5);
  });
});
