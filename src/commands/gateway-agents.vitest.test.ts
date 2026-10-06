import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://app.test', apiKey: 'account-key' }),
}));
vi.mock('../cli/structured-output.js', () => ({ emitResult: vi.fn() }));

import { emitResult } from '../cli/structured-output.js';
import {
  applyToolEdits, findAgent, gatewayAgentCreate, gatewayAgentScheduleAdd, gatewayAgentSet, parseToolEdits, scheduleBody,
  settingsPatch, withStepUp,
} from './gateway-agents.js';

const config = {} as never;
const roster = [
  { id: 'a1', handle: 'uabc_helper', name: 'Helper', toolsets: ['apps'], capabilities: ['list_apps'] },
  { id: 'a2', handle: 'silas', name: 'Silas', toolsets: [], capabilities: [] },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const originalFetch = globalThis.fetch;
let fetcher: ReturnType<typeof vi.fn>;

function serve(routes: (url: string, init: RequestInit) => Response | undefined) {
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://app.test/v1/agents', '');
    if (init.method === 'GET' && path === '') return json({ data: roster });
    if (init.method === 'GET' && path === '/tools') return json({ data: { toolsets: [{ id: 'apps' }, { id: 'deploy' }], capabilities: [] } });
    return routes(path, init) ?? json({ data: { ok: true } });
  });
  globalThis.fetch = fetcher as unknown as typeof fetch;
}
const writes = () => fetcher.mock.calls.filter(([, init]) => (init as RequestInit).method !== 'GET')
  .map(([url, init]) => ({ url, method: (init as RequestInit).method, body: (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : undefined, headers: (init as RequestInit).headers as Record<string, string> }));

beforeEach(() => { vi.clearAllMocks(); serve(() => undefined); });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('agent setting flags', () => {
  it('read auto and none as the server\'s null', async () => {
    expect(await settingsPatch({ model: 'auto', effort: 'auto', spendLimit: 'none' })).toEqual({ model: null, effort: null, spendLimitUsd: null });
    expect(await settingsPatch({
      name: 'Helper', description: 'Helps.', instructions: 'Be brief.', model: 'claude-sonnet-5', effort: 'xhigh',
      permission: 'bypass', spendLimit: '0', off: true,
    })).toEqual({
      name: 'Helper', description: 'Helps.', instructions: 'Be brief.', model: 'claude-sonnet-5', effort: 'xhigh',
      permissionMode: 'bypass', spendLimitUsd: 0, enabled: false,
    });
    expect(await settingsPatch({ spendLimit: '2.5', on: true })).toEqual({ spendLimitUsd: 2.5, enabled: true });
  });

  it('refuse values the server would not take', async () => {
    await expect(settingsPatch({ effort: 'extreme' })).rejects.toThrow(/--effort/);
    await expect(settingsPatch({ permission: 'yolo' })).rejects.toThrow(/--permission/);
    await expect(settingsPatch({ spendLimit: '-1' })).rejects.toThrow(/--spend-limit/);
    await expect(settingsPatch({ spendLimit: 'lots' })).rejects.toThrow(/--spend-limit/);
    await expect(settingsPatch({ on: true, off: true })).rejects.toThrow(/--on or --off/);
    await expect(settingsPatch({ instructions: 'x', instructionsFile: '/tmp/x' })).rejects.toThrow(/not both/);
  });

  it('edit tools with add, remove and set, splitting toolsets from tools', () => {
    expect(parseToolEdits(['add', 'deploy,get_app', 'remove', 'list_apps'])).toEqual({ add: ['deploy', 'get_app'], remove: ['list_apps'] });
    expect(parseToolEdits(['set', 'none'])).toEqual({ set: [], add: [], remove: [] });
    expect(() => parseToolEdits(['get_app'])).toThrow(/add, remove or set/);
    const ids = new Set(['apps', 'deploy']);
    expect(applyToolEdits(roster[0]!, parseToolEdits(['add', 'deploy', 'get_app', 'remove', 'list_apps']), ids))
      .toEqual({ toolsets: ['apps', 'deploy'], capabilities: ['get_app'] });
    expect(applyToolEdits(roster[0]!, parseToolEdits(['set', 'get_app']), ids)).toEqual({ toolsets: [], capabilities: ['get_app'] });
  });

  it('find an agent by id, handle or name', () => {
    expect(findAgent(roster, 'a2').id).toBe('a2');
    expect(findAgent(roster, '@silas').id).toBe('a2');
    expect(findAgent(roster, 'helper').id).toBe('a1');
    expect(() => findAgent(roster, 'nobody')).toThrow(/No agent/);
  });

  it('describe a schedule by exactly one of cron, preset or at', () => {
    expect(scheduleBody({ preset: 'daily', instruction: 'Summarise.' })).toEqual({ preset: 'daily', instruction: 'Summarise.' });
    expect(scheduleBody({ at: '2026-10-07T09:00:00Z', off: true })).toEqual({ at: '2026-10-07T09:00:00.000Z', enabled: false });
    expect(() => scheduleBody({ cron: '0 * * * *', preset: 'daily' })).toThrow(/one of/);
    expect(() => scheduleBody({})).toThrow(/one of/);
  });
});

describe('requests', () => {
  it('create sends every setting given', async () => {
    await gatewayAgentCreate(config, { name: 'Helper', instructions: 'Help.', tools: ['add', 'list_apps'], effort: 'low' });
    expect(writes()).toEqual([expect.objectContaining({
      url: 'https://app.test/v1/agents', method: 'POST',
      body: { name: 'Helper', instructions: 'Help.', effort: 'low', toolsets: [], capabilities: ['list_apps'] },
    })]);
    await expect(gatewayAgentCreate(config, { name: 'Helper' })).rejects.toThrow(/required/);
  });

  it('set patches the resolved agent with its tools edited', async () => {
    await gatewayAgentSet(config, 'Helper', { tools: ['remove', 'apps'], permission: 'auto' });
    expect(writes()).toEqual([expect.objectContaining({
      url: 'https://app.test/v1/agents/a1', method: 'PATCH',
      body: { permissionMode: 'auto', toolsets: [], capabilities: ['list_apps'] },
    })]);
    expect(emitResult).toHaveBeenCalledWith({ agent: { ok: true } });
    await expect(gatewayAgentSet(config, 'Helper', {})).rejects.toThrow(/at least one/);
  });

  it('schedules add posts the trigger with --totp sent up front', async () => {
    await gatewayAgentScheduleAdd(config, 'silas', { cron: '0 * * * *', totp: '123456' });
    const [write] = writes();
    expect(write).toMatchObject({ url: 'https://app.test/v1/agents/a2/triggers', method: 'POST', body: { cron: '0 * * * *' } });
    expect(write!.headers['x-totp-code']).toBe('123456');
  });
});

describe('the step-up', () => {
  const stepUp = (needs: string[]) => json({ error: 'Changing a platform agent needs it.', code: 'step-up-required', needs }, 403);

  it('prompts for the code and the password the server names, then retries once', async () => {
    let calls = 0;
    serve((_path, init) => ((init.headers as Record<string, string>)['x-superadmin-password'] ? undefined : (calls++, stepUp(['totp', 'password']))));
    const prompt = vi.fn(async (question: string) => (question.startsWith('Authenticator') ? '654321' : 'secret'));
    await withStepUp(config, '/a2', 'PATCH', { permissionMode: 'bypass' }, undefined, prompt, true);
    expect(calls).toBe(1);
    expect(prompt.mock.calls.map(([question, hidden]) => [question, hidden])).toEqual([['Authenticator code: ', false], ['Super-admin password: ', true]]);
    expect(writes()[1]!.headers).toMatchObject({ 'x-totp-code': '654321', 'x-superadmin-password': 'secret' });
  });

  it('keeps a --totp code when only the password was missing', async () => {
    serve((_path, init) => ((init.headers as Record<string, string>)['x-superadmin-password'] ? undefined : stepUp(['totp', 'password'])));
    const prompt = vi.fn(async () => 'secret');
    await withStepUp(config, '/a2', 'PATCH', {}, '111111', prompt, true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(writes()[1]!.headers).toMatchObject({ 'x-totp-code': '111111', 'x-superadmin-password': 'secret' });
  });

  it('without a terminal, says to pass --totp and does not retry', async () => {
    serve(() => stepUp(['totp']));
    const prompt = vi.fn();
    await expect(withStepUp(config, '/a2', 'DELETE', undefined, undefined, prompt, false)).rejects.toThrow(/--totp/);
    expect(prompt).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it('passes any other refusal straight through', async () => {
    serve(() => json({ error: 'Agent not found' }, 404));
    await expect(withStepUp(config, '/zz', 'DELETE', undefined, undefined, vi.fn(), true)).rejects.toThrow('Agent not found');
  });
});
