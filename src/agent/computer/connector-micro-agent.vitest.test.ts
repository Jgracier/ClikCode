import { describe, expect, it } from 'vitest';
import { agentMcpHandler } from './connector-micro-agent-mcp.js';
import { microPrompt, microTab, parseMicroResult, runMicroTask, type MicroPorts } from './connector-micro-agent.js';
import { runConnectors, type BrowserDriver, type DeployClient, type DriveOutcome, type OnboardResult, type StopInfo } from './connector-runner.js';
import { forgetSecrets, registerSecret } from './secret-scrubber.js';

const stop: StopInfo = { kind: 'unknown', message: 'no rule fits this screen', url: 'https://vendor.example/settings', pageText: 'Developer settings. Create token', controls: ['Create token', 'Docs'] };
const ports = (text: string, over: Partial<{ timedOut: boolean; calls: number; stamps: string[] }> = {}): MicroPorts & { prompts: string[] } => {
  const stamps = over.stamps ?? ['', 'vendor.example:google:now'];
  const prompts: string[] = [];
  return { prompts, recipeStamp: async () => stamps.shift() ?? '', run: async prompt => { prompts.push(prompt); return { text, timedOut: over.timedOut ?? false, calls: over.calls ?? 7 }; } };
};

describe('agent micro-task', () => {
  it('the prompt is the screen and one goal, with the call budget and the tools allowed, and it hides a secret', () => {
    registerSecret('sk_live_topsecretvalue1');
    const p = microPrompt('acme', { ...stop, pageText: 'token sk_live_topsecretvalue1 here' }, 25);
    forgetSecrets();
    expect(p).toContain('https://vendor.example/settings');
    expect(p).toContain('get an API key');
    expect(p).toContain('at most 25 calls');
    expect(p).toContain('browser_use and account_use tools ONLY');
    expect(p).toContain('Create token | Docs');
    expect(p).not.toContain('topsecretvalue');
  });

  it('reads the RESULT line', () => {
    expect(parseMicroResult('I did it.\nRESULT: captured')).toEqual({ kind: 'captured' });
    expect(parseMicroResult('RESULT: wall card The trial needs a card')).toEqual({ kind: 'wall', wall: 'card', why: 'The trial needs a card' });
    expect(parseMicroResult('RESULT: gave-up could not find the page')).toEqual({ kind: 'gave-up', why: 'could not find the page' });
    expect(parseMicroResult('no result at all')).toMatchObject({ kind: 'gave-up' });
  });

  it('success is a captured key, with the recipe that was recorded', async () => {
    const p = ports('RESULT: captured');
    const done = await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, p);
    expect(done).toMatchObject({ ok: true, recipe: true, actions: 7 });
    expect(p.prompts).toHaveLength(1);
  });

  it('success without a new recipe says so', async () => {
    const done = await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, ports('RESULT: captured', { stamps: ['x', 'x'] }));
    expect(done).toMatchObject({ ok: true, recipe: false });
  });

  it('a wall the agent names becomes a human step of that kind; a timeout and a missing result are not successes', async () => {
    const walled = await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, ports('RESULT: wall captcha a hCaptcha on the form'));
    expect(walled).toMatchObject({ ok: false, stop: { kind: 'captcha', human: { kind: 'captcha', reasonCode: 'captcha' } } });
    const late = await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, ports('', { timedOut: true }));
    expect(late.ok).toBe(false);
    const none = await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, ports('thinking...'));
    expect(none).toMatchObject({ ok: false, stop: { message: expect.stringContaining('did not finish') } });
  });

  it('a run that cannot start is a failure, not a crash', async () => {
    const failing: MicroPorts = { recipeStamp: async () => '', run: async () => { throw new Error('claude: command not found'); } };
    expect(await runMicroTask('acme', stop, { maxCalls: 5, maxMs: 1000 }, failing)).toMatchObject({ ok: false });
  });

  it('the tab is the agent\'s own, per vendor', () => { expect(microTab('Acme_1')).toBe('agent-acme-1'); });
});

describe('agent MCP server', () => {
  const tool = (seen: Array<Record<string, unknown>>) => ({ name: 'browser_use', description: 'd', parameters: { type: 'object' }, run: async (args: Record<string, unknown>) => { seen.push(args); return { output: 'ok' }; } }) as never;

  it('lists only the tools it was given, forces its own tab, and refuses calls past the budget', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handle = agentMcpHandler({ tab: 'agent-acme', maxCalls: 2, tools: [tool(seen)], stateDir: '/tmp/none' });
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map(t => t.name)).toEqual(['browser_use']);
    const call = (n: number, args: Record<string, unknown>) => handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'browser_use', arguments: args } }) as Promise<{ result: { isError: boolean; content: Array<{ text: string }> } }>;
    expect((await call(1, { action: 'open', tab: 'connectors' })).result.isError).toBe(false);
    await call(2, { action: 'observe' });
    const third = await call(3, { action: 'observe' });
    expect(third.result.isError).toBe(true);
    expect(third.result.content[0]!.text).toContain('Call budget of 2 used');
    expect(seen).toHaveLength(2);
    expect(seen.every(a => a.tab === 'agent-acme')).toBe(true);
    const unknown = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'computer_use', arguments: {} } }) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });
});

describe('the runner hands an unknown screen to the micro-task, once', () => {
  const oauthTask = (id: string): OnboardResult => ({ id, state: 'needs-agent', stage: 'connect', reason: 'a test account must be connected', next: { kind: 'agent', task: `oauth_connect: connect the test account for ${id}` } });
  const published = (id: string): OnboardResult => ({ id, state: 'published', stage: 'published', reason: 'published', next: { kind: 'none', task: 'nothing' } });
  const client = (later: OnboardResult[]) => {
    const notes: string[] = [];
    const c: DeployClient = { waiting: async () => [], batch: async () => ({ results: [oauthTask('acme')], skipped: [] }), onboard: async () => later.shift() ?? published('acme'), report: async () => undefined, note: async (_id, t) => { notes.push(t); }, tool: async () => ({}) };
    return { c, notes };
  };
  const driver = (agent: DriveOutcome, asked: Array<{ maxCalls: number }>): BrowserDriver => ({
    oauthConnect: async () => ({ ok: false, stop }), hasRecipe: async () => false, captureKey: async () => ({ ok: true }), keygrab: async () => ({ ok: true }),
    agentTask: async (_id, _stop, budget) => { asked.push(budget); return agent; },
  });
  const quick = { sleep: async () => undefined, writeFile: async () => undefined, handoffDir: async () => '/tmp/h' };

  it('a successful micro-task carries the vendor on to the next onboard step, and the recipe is recorded on the outcome', async () => {
    const asked: Array<{ maxCalls: number }> = [];
    const { c } = client([published('acme')]);
    const { outcomes } = await runConnectors(c, driver({ ok: true, note: 'agent got it', recipe: true }, asked), quick);
    expect(asked).toEqual([{ maxCalls: 25, maxMs: expect.any(Number) }]);
    expect(outcomes[0]).toMatchObject({ id: 'acme', status: 'published', recipe: true });
  });

  it('a failed micro-task falls back to the hand-off note, and is not tried a second time', async () => {
    const asked: Array<{ maxCalls: number }> = [];
    const { c, notes } = client([]);
    const { outcomes } = await runConnectors(c, driver({ ok: false, stop: { ...stop, message: 'the agent micro-task did not finish' } }, asked), quick);
    expect(asked).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('handoff');
    expect(notes[0]).toContain('micro-task');
  });

  it('a screen that is a known wall never wakes an agent', async () => {
    const asked: Array<{ maxCalls: number }> = [];
    const { c } = client([]);
    const d = driver({ ok: true }, asked);
    d.oauthConnect = async () => ({ ok: false, stop: { ...stop, kind: 'captcha', message: 'captcha' } });
    const { outcomes } = await runConnectors(c, d, quick);
    expect(asked).toHaveLength(0);
    expect(outcomes[0]!.status).toBe('human');
  });
});
