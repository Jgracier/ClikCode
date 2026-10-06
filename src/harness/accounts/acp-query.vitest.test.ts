import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import { acpConfigOptionValues, acpDiscoveryDirectory, acpDiscoverySession, acpProbeArgv, acpSessionModels } from './acp-query.js';

describe('an ACP agent started only to be asked something', () => {
  it("switches off every MCP server in Copilot's config, so none can open a sign-in page", async () => {
    const copilot = allLocalHarnesses().find((item) => item.command === 'copilot')!;
    const root = mkdtempSync(join(tmpdir(), 'clikcode-probe-argv-'));
    try {
      const profile = join(root, 'copilot-profile');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, 'mcp-config.json'), JSON.stringify({ mcpServers: {
        'robinhood-trading': { type: 'http', url: 'https://agent.robinhood.com/mcp/trading' }, context7: { command: 'npx' },
      } }));
      const argv = await acpProbeArgv(copilot, { nativeProfile: { env: 'COPILOT_HOME', path: profile } }, join(root, 'home'));
      expect(argv).toEqual(['--disable-mcp-server', 'context7', '--disable-mcp-server', 'robinhood-trading']);
      expect(await acpProbeArgv(copilot, undefined, join(root, 'empty-home'))).toEqual([]);
      const qwen = allLocalHarnesses().find((item) => item.command === 'qwen')!;
      expect(await acpProbeArgv(qwen, undefined, join(root, 'home'))).toEqual(['--allowed-mcp-server-names', 'clikcode-probe-none']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ACP model discovery', () => {
  it('reads model choices and current value from session config options', () => {
    expect(acpSessionModels({ configOptions: [{
      id: 'model', currentValue: 'devstral-latest', options: [
        { value: 'devstral-latest', name: 'Devstral Latest' },
        { value: 'mistral-medium', name: 'Mistral Medium' },
      ],
    }] })).toEqual({
      models: ['devstral-latest', 'mistral-medium'],
      labels: { 'devstral-latest': 'Devstral Latest', 'mistral-medium': 'Mistral Medium' },
      current: 'devstral-latest',
    });
  });

  it('reads one config option\'s values, flat or grouped (Goose thinking_effort)', () => {
    const session = { configOptions: [
      { id: 'model', options: [{ value: 'm' }] },
      { configId: 'thinking_effort', options: [{ value: 'low' }, { group: 'more', options: [{ value: 'medium' }, { value: 'high' }] }] },
    ] };
    expect(acpConfigOptionValues(session, 'thinking_effort')).toEqual(['low', 'medium', 'high']);
    expect(acpConfigOptionValues(session, 'missing')).toEqual([]);
    expect(acpConfigOptionValues(undefined, 'thinking_effort')).toEqual([]);
  });
});

describe('the model-list session', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'acp-discovery-')); process.env.CLIKCODE_HOME = home; });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  /** An agent that numbers its sessions and knows which it has made. */
  const agent = () => {
    const calls: Array<{ method: string; params?: Record<string, any> }> = [];
    const made = new Set<string>();
    const request = async (method: string, params?: Record<string, any>) => {
      calls.push({ method, params });
      if (method === 'session/new') { const sessionId = `s${made.size + 1}`; made.add(sessionId); return { sessionId }; }
      if (!made.has(params?.sessionId)) throw new Error('no such session');
      return {};
    };
    return { calls, made, request };
  };

  it('reopens the first session instead of leaving a new chat on every refresh', async () => {
    const vendor = agent();
    for (let index = 0; index < 3; index += 1) await acpDiscoverySession(vendor.request, { sessionCapabilities: { resume: {} } }, 'cursor:default');
    expect(vendor.made.size).toBe(1);
    expect(vendor.calls.map((call) => call.method)).toEqual(['session/new', 'session/resume', 'session/resume']);
    expect(vendor.calls.every((call) => call.params?.cwd === acpDiscoveryDirectory())).toBe(true);
  });

  it('loads it when the agent can load but not resume', async () => {
    const vendor = agent();
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:default');
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:default');
    expect(vendor.calls.map((call) => call.method)).toEqual(['session/new', 'session/load']);
  });

  it('starts another when the kept one is gone, and keeps that', async () => {
    const vendor = agent();
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:default');
    vendor.made.clear();
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:default');
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:default');
    expect(vendor.calls.map((call) => call.method)).toEqual(['session/new', 'session/load', 'session/new', 'session/load']);
  });

  it('keeps one session per account', async () => {
    const vendor = agent();
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:a');
    await acpDiscoverySession(vendor.request, { loadSession: true }, 'goose:b');
    expect(vendor.made.size).toBe(2);
  });
});
