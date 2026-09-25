import { describe, expect, it } from 'vitest';
import type { HarnessSession } from './model';
import { chatNamed, latestChat } from './options';

const chat = (id: string, fields: Partial<HarnessSession> = {}): HarnessSession => ({
  id, conversationId: id, route: 'local', accountId: null, provider: 'anthropic', model: null, effort: '', permissionMode: 'ask',
  accountFailover: 'on-quota-exhausted', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', status: 'active',
  messages: [{ role: 'user', content: 'hi' }], ...fields,
} as HarnessSession);

describe('finding a chat', () => {
  const sessions = [
    chat('aaaa1111-0000', { name: 'Billing fix', updatedAt: '2026-09-02T00:00:00Z', workspace: '/w/a' }),
    chat('bbbb2222-0000', { updatedAt: '2026-09-05T00:00:00Z', workspace: '/w/b' }),
    chat('cccc3333-0000', { messages: [], updatedAt: '2026-09-09T00:00:00Z', workspace: '/w/a' }),
  ];

  it('by the start of its id, even unnamed', () => {
    expect(chatNamed(sessions, 'bbbb', 'x')).toBe('bbbb2222-0000');
    expect(chatNamed(sessions, 'bbb', 'x'), 'too short to be an id').toBeUndefined();
  });

  it('by name, and `last` for the latest chat that has content', () => {
    expect(chatNamed(sessions, 'billing', 'x')).toBe('aaaa1111-0000');
    expect(chatNamed(sessions, 'last', 'x')).toBe('bbbb2222-0000');
  });

  it('--continue reopens the latest chat in this folder, else the latest anywhere', () => {
    expect(latestChat(sessions, '/w/a')?.id).toBe('aaaa1111-0000');
    expect(latestChat(sessions, '/w/elsewhere')?.id).toBe('bbbb2222-0000');
  });
});
