import { describe, expect, it } from 'vitest';
import { modelChoicesFor } from './model-choices.js';

const ACCOUNTS = [
  { id: 'a1', label: 'work', provider: 'anthropic', models: ['claude-opus-5', 'claude-sonnet-5'] },
  { id: 'a2', label: 'spare', provider: 'anthropic', models: ['claude-haiku-4-5'] },
  { id: 'o1', label: 'personal', provider: 'openai', models: ['gpt-5'] },
];

describe('what /model may choose from', () => {
  it('is this account, when the session has one', () => {
    expect(modelChoicesFor({ accountId: 'a1', provider: 'anthropic' }, ACCOUNTS).map((item) => item.model))
      .toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('is this provider, when the session has no account yet', () => {
    expect(modelChoicesFor({ provider: 'anthropic' }, ACCOUNTS).map((item) => item.model))
      .toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('never another provider, which is the whole point', () => {
    // Asking for a model with a provider already chosen is not asking about
    // providers. /models is the cross-provider list.
    for (const session of [{ accountId: 'a1', provider: 'anthropic' }, { provider: 'anthropic' }]) {
      expect(modelChoicesFor(session, ACCOUNTS).some((item) => item.provider !== 'anthropic')).toBe(false);
    }
  });

  it('is empty rather than everything when there is no provider at all', () => {
    expect(modelChoicesFor({}, ACCOUNTS)).toEqual([]);
  });
});
