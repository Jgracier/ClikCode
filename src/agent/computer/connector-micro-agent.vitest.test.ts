import { describe, expect, it } from 'vitest';
import { connectorTaskTool, agentMcpHandler, opensCloudConsole } from './connector-micro-agent-mcp.js';
import { chatRoute, microAccount, microPrompt, microTab, parseMicroResult, runMicroTask, type MicroPorts } from './connector-micro-agent.js';
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
    expect(p).toContain('finish the exact assigned platform task');
    expect(p).toContain('at most 25 calls');
    expect(p).toContain('connector_task for the assigned connector ONLY');
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
    expect(late).toMatchObject({ stop: { message: expect.stringContaining('ceiling while still working') } });
    const stalledPorts = ports('');
    stalledPorts.run = async () => ({ text: '', timedOut: true, stalled: true, calls: 3 });
    expect(await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 60_000 }, stalledPorts)).toMatchObject({ ok: false, stop: { message: expect.stringContaining('stalled: no tool call') } });
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

  it('never lets an agent into a cloud console: an address there is refused, and a page that lands there is left unseen', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const landing = { name: 'browser_use', description: 'd', parameters: { type: 'object' }, run: async (args: Record<string, unknown>) => { seen.push(args); return { output: args.url === 'about:blank' ? 'Page: about:blank' : 'Page: https://us-east-1.console.aws.amazon.com/iam/home#/security_credentials\n- button "Create access key"' }; } } as never;
    const handle = agentMcpHandler({ tab: 'agent-acme', maxCalls: 10, tools: [landing], stateDir: '/tmp/none' });
    const call = (n: number, args: Record<string, unknown>) => handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'browser_use', arguments: args } }) as Promise<{ result: { isError: boolean; content: Array<{ text: string }> } }>;
    const direct = await call(1, { action: 'open', url: 'https://console.aws.amazon.com/iam/' });
    expect(direct.result.isError).toBe(true);
    expect(direct.result.content[0]!.text).toMatch(/never work in a cloud console/);
    expect(seen).toHaveLength(0);
    const landed = await call(2, { action: 'open', url: 'https://acme.example/login' });
    expect(landed.result.isError).toBe(true);
    expect(landed.result.content[0]!.text).not.toMatch(/Create access key/);
    expect(seen.map(a => a.url)).toEqual(['https://acme.example/login', 'about:blank']);
    for (const ok of ['https://acme.example/', 'https://aws.amazon.com/pricing', 'https://docs.aws.amazon.com/iam/']) expect(opensCloudConsole({ url: ok })).toBe(false);
    for (const no of ['https://console.cloud.google.com/apis', 'https://portal.azure.com/#home', 'https://signin.aws.amazon.com/signin']) expect(opensCloudConsole({ url: no })).toBe(true);
  });

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

describe('a task no rule knows: read the rendered pages first, then one agent micro-task', () => {
  const judgement = (id: string): OnboardResult => ({ id, state: 'needs-agent', stage: 'triage', reason: 'discovery could not settle how to connect', next: { kind: 'agent', task: `open https://api.${id}.example and find its developer page. If it has an API key page, get a test key.`, call: { tool: 'connector_onboard', args: { id } } } });
  const published = (id: string): OnboardResult => ({ id, state: 'published', stage: 'published', reason: 'published', next: { kind: 'none', task: 'nothing' } });
  const make = (qualify: BrowserDriver['qualify'], agent: DriveOutcome | undefined) => {
    const reports: unknown[] = [], notes: string[] = [], asked: string[] = [];
    const client: DeployClient = { waiting: async () => [], batch: async () => ({ results: [judgement('acme')], skipped: [] }), onboard: async () => published('acme'), report: async r => { reports.push(r); }, note: async (_i, t) => { notes.push(t); }, tool: async () => ({}) };
    const driver: BrowserDriver = {
      oauthConnect: async () => ({ ok: true }), hasRecipe: async () => false, captureKey: async () => ({ ok: true }), keygrab: async () => ({ ok: true }),
      ...(qualify ? { qualify } : {}),
      ...(agent ? { agentTask: async (_id: string, s: StopInfo) => { asked.push(s.pageText); return agent; } } : {}),
    };
    return { client, driver, reports, notes, asked };
  };
  const quick = { sleep: async () => undefined, writeFile: async () => undefined, handoffDir: async () => '/tmp/h' };

  it('a site that does not resolve is reported as a dead host and no agent runs', async () => {
    const m = make(async () => ({ lane: 'dead', summary: 'the site does not resolve', human: { kind: 'retire', instructions: 'the vendor site does not load', reasonCode: 'dead-host' } }), { ok: true });
    const { outcomes } = await runConnectors(m.client, m.driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'human', humanStep: { kind: 'retire' } });
    expect(m.reports).toHaveLength(1);
    expect(m.asked).toHaveLength(0);
  });

  it('an auto lane gives the task to one agent micro-task, and success carries on to the next onboard step', async () => {
    const m = make(async () => ({ lane: 'auto', summary: 'no wall' }), { ok: true, note: 'agent got the key', recipe: true });
    const { outcomes } = await runConnectors(m.client, m.driver, quick);
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toContain('find its developer page');
    expect(outcomes[0]).toMatchObject({ status: 'published', recipe: true });
  });

  it('an agent that cannot do it leaves the hand-off note', async () => {
    const m = make(undefined, { ok: false, stop: { ...stop, message: 'the agent micro-task did not finish: nothing found' } });
    const { outcomes } = await runConnectors(m.client, m.driver, quick);
    expect(outcomes[0]!.status).toBe('handoff');
    expect(m.notes[0]).toContain('micro-task');
  });
});


describe('micro-agent account routing', () => {
  const account = (provider: string, env: string, quotaState: 'available' | 'exhausted' = 'available'): import('../../harness/definition.js').AiHarnessAccount => ({ id: provider, provider, label: provider, authKind: 'vendor-cli', credentialRef: provider, status: 'ready', quotaState, ...(quotaState === 'exhausted' ? { quotaExhaustedAt: new Date().toISOString(), quotaRetryAt: new Date(Date.now() + 3_600_000).toISOString() } : {}), models: [], nativeProfile: { env, path: `/profiles/${provider}` } });
  it('uses the saved Codex profile when Claude is spent', () => {
    const codex = account('openai', 'CODEX_HOME');
    expect(microAccount([account('anthropic', 'CLAUDE_CONFIG_DIR', 'exhausted'), codex])?.id).toBe('openai');
  });
  it('does not treat an API key or a signed-out profile as a native fallback', () => {
    const signedOut = { ...account('openai', 'CODEX_HOME'), status: 'needs_login' as const };
    const api = { ...account('anthropic', 'CLAUDE_CONFIG_DIR'), authKind: 'api-key' as const };
    expect(microAccount([signedOut, api])).toBeUndefined();
  });
});


it('rejects cross-connector edits and unlisted operations before any platform call', async () => {
 const tool = connectorTaskTool('assigned');
 await expect(tool.run({ tool: 'connector_spec_patch', args: { id: 'other' } }, {} as never)).rejects.toThrow('assigned connector');
 await expect(tool.run({ tool: 'connector_spec_set', args: {} }, {} as never)).rejects.toThrow('not available');
 expect(parseMicroResult('RESULT: completed')).toEqual({ kind: 'captured' });
    expect(parseMicroResult('RESULT: completed fixed the base URL; connector_onboard now asks for live tests')).toEqual({ kind: 'captured', said: 'fixed the base URL; connector_onboard now asks for live tests' });
});

it('describes allowed operations and saves notes with the assigned id and worker, never another connector', async () => {
  const calls: unknown[] = [];
  const tool = connectorTaskTool('acme', { describe: async name => ({ name, inputSchema: { type: 'object' } }), call: async (name, args) => { calls.push([name, args]); return { saved: true }; } });
  const description = await tool.run({ tool: 'describe', args: { tool: 'connector_spec_patch' } } as never, {} as never);
  expect(description.output).toContain('inputSchema');
  await tool.run({ tool: 'connector_work_note', args: { text: 'Saved the official reference', worker: 'another-worker' } } as never, {} as never);
  expect(calls).toEqual([['connector_work_note', { text: 'Saved the official reference', id: 'acme', worker: 'cc-runner' }]]);
  await expect(tool.run({ tool: 'describe', args: { tool: 'delete_app' } } as never, {} as never)).rejects.toThrow('not available');
});

it('retains calls consumed before a native agent exits with an error', async () => {
  const failed: MicroPorts = { recipeStamp: async () => '', run: async () => ({ text: '', timedOut: false, calls: 7, error: 'native account unavailable' }) };
  expect(await runMicroTask('acme', stop, { maxCalls: 25, maxMs: 1000 }, failed)).toMatchObject({ ok: false, agentCalls: 7 });
});

describe('the OAuth app registration rule', () => {
  it('replaces the no-credentials rule only for that task, and keeps every other limit', async () => {
    const { microPrompt } = await import('./connector-micro-agent.js');
    const stop = { kind: 'unknown' as const, url: 'https://developer.acme.example/apps', pageText: 'Register the app', controls: [] };
    const registering = microPrompt('acme', { ...stop, message: 'oauth-app: Register a web OAuth app named ClikDeploy' }, 40);
    expect(registering).toMatch(/register ONE OAuth app for ClikDeploy/);
    expect(registering).toMatch(/"to": "clikdeploy-connector", "with": \{ "integration": "acme"/);
    expect(registering).toMatch(/Never create an API key, a user, a role or a second app/);
    expect(registering).toMatch(/nothing in a cloud console/);
    const other = microPrompt('acme', { ...stop, message: 'an unrecognized screen' }, 40);
    expect(other).not.toMatch(/register ONE OAuth app/);
    expect(other).toMatch(/Never create, widen, rotate or delete credentials/);
  });
});


describe('a sign-up that wants a work email', () => {
  const stop: StopInfo = { kind: 'unknown', message: 'work-email: the sign-up refuses gmail', url: 'https://vendor.example/signup', pageText: 'Please use a company email address', controls: [] };
  it('tells the agent to sign up with the connected business mailbox, and how to read its mail', () => {
    const prompt = microPrompt('acme', stop, 20, { businessEmail: 'me@company.example' });
    expect(prompt).toContain('using me@company.example');
    expect(prompt).toContain('read_email_code or open_email_link with address me@company.example');
    expect(prompt).toContain('not Google sign-in');
  });
  it('says nothing of it when no business mailbox is connected', () => {
    expect(microPrompt('acme', stop, 20)).not.toContain('4b.');
  });
  it('hands the address over from its port', async () => {
    let seen = '';
    const ports: MicroPorts = { run: async prompt => { seen = prompt; return { text: 'RESULT: captured', timedOut: false, calls: 1 }; }, recipeStamp: async () => '', businessEmail: async () => 'me@company.example' };
    await runMicroTask('acme', stop, { maxCalls: 5, maxMs: 1_000 }, ports);
    expect(seen).toContain('me@company.example');
  });
});

it('tells the agent an unreadable texted-code reader is a wall to report at once, not a hand-off to wait on', async () => {
  const stop: StopInfo = { kind: 'unknown', message: 'a phone check', url: 'https://vendor.example/verify', pageText: 'Enter the code we texted you', controls: [] };
  const prompt = microPrompt('acme', stop, 20);
  expect(prompt).toContain('do not wait or hand off, end with RESULT: wall sms');
});

describe('the route a connector agent runs on', () => {
  const account = (id: string, provider: string, env: string, quotaState: 'available' | 'exhausted' = 'available'): import('../../harness/definition.js').AiHarnessAccount => ({ id, provider, label: `${id}@example.com`, authKind: 'vendor-cli', credentialRef: id, status: 'ready', quotaState, ...(quotaState === 'exhausted' ? { quotaExhaustedAt: new Date().toISOString(), quotaRetryAt: new Date(Date.now() + 3_600_000).toISOString() } : {}), nativeProfile: { env, path: `/tmp/${id}` } } as never);
  const chat = (updatedAt: string, nativeHarness: string, accountId: string, model?: string) => ({ id: updatedAt, route: 'local', nativeHarness, accountId, updatedAt, ...(model ? { model } : {}) }) as never;
  const accounts = [account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR'), account('codex-b', 'openai', 'CODEX_HOME')];

  it('is the harness, account and model of the most recent chat', () => {
    const route = chatRoute({ accounts, sessions: [chat('2026-11-18T10:00:00Z', 'codex', 'codex-b'), chat('2026-11-18T12:00:00Z', 'claude', 'claude-a', 'opus')] });
    expect(route).toMatchObject({ harness: 'claude', account: { id: 'claude-a' }, model: 'opus' });
  });
  it('does not fall back to another account when the chat\'s has no usage left', () => {
    const spent = [account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR', 'exhausted'), account('codex-b', 'openai', 'CODEX_HOME')];
    const route = chatRoute({ accounts: spent, sessions: [chat('2026-11-18T12:00:00Z', 'claude', 'claude-a')] });
    expect(route).toEqual({ error: expect.stringContaining('has no usage left now') });
  });
  it('says so when the chat runs on a harness a connector agent cannot use', () => {
    expect(chatRoute({ accounts, sessions: [chat('2026-11-18T12:00:00Z', 'opencode', 'claude-a')] })).toEqual({ error: expect.stringContaining('run on opencode') });
  });
  it('skips a newer chat on a harness that cannot run headless for the most recent Claude Code or Codex chat', () => {
    const route = chatRoute({ accounts, sessions: [chat('2026-11-18T10:00:00Z', 'claude', 'claude-a', 'opus'), chat('2026-11-18T12:00:00Z', 'copilot', 'claude-a')] });
    expect(route).toMatchObject({ harness: 'claude', account: { id: 'claude-a' }, model: 'opus' });
  });
});

describe('the micro-task and the egress', () => {
  it('hands the vendor run\'s egress to the agent run, and none for home', async () => {
    const seen: Array<string | undefined> = [];
    const ports: MicroPorts = { recipeStamp: async () => 'x', run: async (_prompt, options) => { seen.push(options.egress); return { text: 'RESULT: gave-up nothing', timedOut: false, calls: 1 }; } };
    const stop = { kind: 'unknown' as const, message: 'm', url: 'https://acme.example', pageText: '', controls: [] };
    await runMicroTask('acme', stop, { maxCalls: 5, maxMs: 60_000 }, ports, 'prod');
    await runMicroTask('acme', stop, { maxCalls: 5, maxMs: 60_000 }, ports, 'home');
    await runMicroTask('acme', stop, { maxCalls: 5, maxMs: 60_000 }, ports);
    expect(seen).toEqual(['prod', undefined, undefined]);
  });
});
