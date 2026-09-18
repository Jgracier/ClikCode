import { describe, it, expect, beforeEach, vi } from 'vitest';
import { selectLocalHarnessRouteAsync } from './ai-local-harness';

describe('Router toggle behavior (per-agent and global)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ROUTER_DECISION_MAKER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'fake-key';
    delete process.env.ROUTER_DECISION_MAKER_ENABLED;
  });

  it('consults TypeSafe when agent has the Jev remediation capability', async () => {
    const fakeDecision = { top_choice: 'openai:gpt-5' };
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeDecision });

    const accounts = [{ id: 'a1', provider: 'openai', label: 'local', authKind: 'api-key', models: ['gpt-5'], status: 'ready', credentialRef: 'x' }];
    const candidates = [
      { provider: 'openai', model: 'gpt-5', accessClass: 'metered', estimatedCostPerMTok: 0.1, inputCostPerMTok: 0.1, accountId: 'a1' },
    ];

    const selected = await selectLocalHarnessRouteAsync(accounts as any, candidates as any, { route: 'local', strategy: 'auto', agentCapabilities: ['analyze_env_remediation'] });
    expect(selected.provider).toBe('openai');
    expect(selected.model).toBe('gpt-5');
  });

  it('falls back to local selection when agent lacks the Jev remediation capability', async () => {
    const fakeDecision = { top_choice: 'openai:gpt-5' };
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeDecision });

    const accounts = [
      { id: 'a1', provider: 'anthropic', label: 'local', authKind: 'api-key', models: ['claude-opus-5'], status: 'ready', credentialRef: 'x' },
    ];
    const candidates = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'subscription', estimatedCostPerMTok: 0.05, inputCostPerMTok: 0.05, accountId: 'a1' },
      { provider: 'openai', model: 'gpt-5', accessClass: 'metered', estimatedCostPerMTok: 0.1, inputCostPerMTok: 0.1, accountId: 'a1' },
    ];

    const selected = await selectLocalHarnessRouteAsync(accounts as any, candidates as any, { route: 'local', strategy: 'budget', agentCapabilities: [] });
    // budget mode prefers cheapest (anthropic has lower cost here)
    expect(selected.provider).toBe('anthropic');
  });

  it('respects global ROUTER_DECISION_MAKER_ENABLED=false', async () => {
    process.env.ROUTER_DECISION_MAKER_ENABLED = 'false';
    const fakeDecision = { top_choice: 'openai:gpt-5' };
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeDecision });

    const accounts = [
      { id: 'a1', provider: 'anthropic', label: 'local', authKind: 'api-key', models: ['claude-opus-5'], status: 'ready', credentialRef: 'x' },
    ];
    const candidates = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'subscription', estimatedCostPerMTok: 0.05, inputCostPerMTok: 0.05, accountId: 'a1' },
      { provider: 'openai', model: 'gpt-5', accessClass: 'metered', estimatedCostPerMTok: 0.1, inputCostPerMTok: 0.1, accountId: 'a1' },
    ];

    const selected = await selectLocalHarnessRouteAsync(accounts as any, candidates as any, { route: 'local', strategy: 'budget', agentCapabilities: ['analyze_env_remediation'] });
    expect(selected.provider).toBe('anthropic');
  });
});
