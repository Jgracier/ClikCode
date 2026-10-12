import { describe, expect, it } from 'vitest';
import { sessionModelLabel } from './output.js';
import { sessionEvent } from '../ide/session-event.js';
import type { HarnessSession } from '../session/model.js';

const gateway = (model: string | null, reported?: string): HarnessSession => ({
  id: 's', route: 'gateway', provider: 'gateway', model, accountId: null, effort: 'platform-managed',
  ...(reported ? { reported: { at: '2026-10-06T00:00:00.000Z', model: reported } } : {}),
} as HarnessSession);

describe('the model a Gateway conversation is shown running', () => {
  it('is Automatic, never the model the Gateway routed to, when the user chose none', () => {
    expect(sessionModelLabel(gateway(null), 'qwen3.8-27b')).toBe('Automatic');
    expect(sessionModelLabel(gateway(null))).toBe('Automatic');
    expect(sessionModelLabel(gateway('glm-5'), 'glm-5')).toBe('glm-5');
  });

  it('reaches the editor as the terminal names it', () => {
    expect(sessionEvent(gateway(null, 'qwen3.8-27b')).modelLabel).toEqual({ model: 'auto', label: 'Automatic' });
    expect(sessionEvent(gateway('glm-5', 'glm-5')).modelLabel).toEqual({ model: 'glm-5', label: 'glm-5' });
  });
});

describe('an agent conversation in the footer', () => {
  const base = {
    id: 's', route: 'gateway' as const, accountId: null, provider: 'gateway', model: null, effort: 'platform-managed',
createdAt: '', updatedAt: '', status: 'active' as const,
  };
  it('names the agent and the model that served its last turn', () => {
    expect(sessionModelLabel({ ...base, gatewayAgentId: 'a1', gatewayAgentName: 'Silas' }, 'claude-opus-5-5')).toBe('Silas · claude-opus-5-5');
  });
  it('names the agent before any turn has said which model served it', () => {
    expect(sessionModelLabel({ ...base, gatewayAgentId: 'a1', gatewayAgentName: 'Silas' }, null)).toBe('Silas');
  });
  it('a Gateway model conversation is unchanged', () => {
    expect(sessionModelLabel({ ...base }, 'deepseek-v4.1-flash')).toBe('Automatic');
  });
});

describe('"free" is a billing tag, not part of a model\'s name', () => {
  it('is not shown, and the id sent is unchanged', async () => {
    const { withoutFreeTag, modelLabel } = await import('./model-label.js');
    expect(withoutFreeTag('mimo-v2.5-free')).toBe('mimo-v2.5');
    expect(withoutFreeTag('qwen/qwen3:free')).toBe('qwen/qwen3');
    expect(withoutFreeTag('nemotron (free)')).toBe('nemotron');
    expect(withoutFreeTag('freebsd-helper')).toBe('freebsd-helper');
    expect(withoutFreeTag('free')).toBe('free');
    expect(modelLabel('opencode/nemotron-3-ultra-free', 'opencode')).toBe('nemotron-3-ultra');
  });
});
