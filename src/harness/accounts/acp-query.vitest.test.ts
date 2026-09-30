import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpDiscoveryDirectory, acpDiscoverySession, acpSessionModels } from './acp-query.js';

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
