import { describe, expect, it } from 'vitest';
import { sessionModelLabel } from './output.js';
import { sessionEvent } from '../ide/session-event.js';
import type { HarnessSession } from '../session/model.js';

const gateway = (model: string | null, reported?: string): HarnessSession => ({
  id: 's', route: 'gateway', provider: 'gateway', model, accountId: null, effort: 'platform-managed',
  ...(reported ? { reported: { at: '2026-10-06T00:00:00.000Z', model: reported } } : {}),
} as HarnessSession);

describe('the model a Gateway conversation is shown running', () => {
  it('is the Gateway\'s pick, once one has answered, when the user chose none', () => {
    expect(sessionModelLabel(gateway(null), 'qwen3.8-27b')).toBe('Automatic · qwen3.8-27b');
    expect(sessionModelLabel(gateway(null))).toBeUndefined();
    expect(sessionModelLabel(gateway('glm-5'), 'glm-5')).toBe('glm-5');
  });

  it('reaches the editor as the terminal names it', () => {
    expect(sessionEvent(gateway(null, 'qwen3.8-27b')).modelLabel).toEqual({ model: 'qwen3.8-27b', label: 'Automatic · qwen3.8-27b' });
    expect(sessionEvent(gateway('glm-5', 'glm-5')).modelLabel).toEqual({ model: 'glm-5', label: 'glm-5' });
  });
});
