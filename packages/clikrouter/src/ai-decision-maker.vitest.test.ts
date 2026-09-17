import { describe, it, expect, beforeEach, vi } from 'vitest';
import { selectRouterCandidateDynamic } from './ai-router-selection';

describe('Router dynamic decision with TypeSafe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ROUTER_DECISION_MAKER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'fake-key';
  });

  it('selects provider from TypeSafe decision', async () => {
    const fakeDecision = { top_choice: 'openai:gpt-5' };
    // mock fetch to respond to the System One call
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeDecision });

    const candidates = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'metered', estimatedCostPerMTok: 0.05, inputCostPerMTok: 0.05 },
      { provider: 'openai', model: 'gpt-5', accessClass: 'metered', estimatedCostPerMTok: 0.1, inputCostPerMTok: 0.1 },
    ];

    const selected = await selectRouterCandidateDynamic(candidates as any, 'auto');
    expect(selected).not.toBeNull();
    expect(selected!.provider).toBe('openai');
    expect(selected!.model).toBe('gpt-5');
  });

  it('falls back to local selection when TypeSafe returns unexpected', async () => {
    const fakeDecision = { something_else: true };
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeDecision });

    const candidates = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'subscription', estimatedCostPerMTok: 0.05, inputCostPerMTok: 0.05 },
      { provider: 'openai', model: 'gpt-5', accessClass: 'metered', estimatedCostPerMTok: 0.1, inputCostPerMTok: 0.1 },
    ];

    const selected = await selectRouterCandidateDynamic(candidates as any, 'budget');
    // budget mode prefers cheapest (anthropic has lower cost here)
    expect(selected).not.toBeNull();
    expect(selected!.provider).toBe('anthropic');
  });
});
