import { describe, expect, it } from 'vitest';
import { newConversationSession } from './conversations.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';

const now = new Date().toISOString();
const state = {
  version: 1, installationId: 't', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
  accounts: [], sessions: [], invocations: [],
  globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
  providerSettings: {},
} as unknown as HarnessState;

const source = {
  id: 'old', conversationId: 'old', route: 'local', accountId: 'acct', provider: 'anthropic', model: 'opus',
  nativeHarness: 'claude', effort: 'xhigh', permissionMode: 'bypass', accountFailover: 'never',
  harnessOptions: { verbose: true }, workspace: '/work', createdAt: now, updatedAt: now, status: 'active',
  messages: [{ role: 'user', content: 'the old conversation' }], nativeSessionId: 'thread-1',
} as unknown as HarnessSession;

describe('/new', () => {
  it('keeps the provider, harness and model -- it clears the conversation, not the setup', () => {
    const fresh = newConversationSession(state, source);
    expect(fresh).toMatchObject({
      provider: 'anthropic', nativeHarness: 'claude', model: 'opus', accountId: 'acct',
      effort: 'xhigh', permissionMode: 'bypass', accountFailover: 'never', workspace: '/work',
      harnessOptions: { verbose: true },
    });
  });

  it('carries none of the old conversation', () => {
    const fresh = newConversationSession(state, source);
    expect(fresh.id).not.toBe(source.id);
    expect(fresh.messages ?? []).toEqual([]);
    expect(fresh.nativeSessionId).toBeUndefined();
  });

  it('does not share the options object, so changing one chat cannot change the other', () => {
    const fresh = newConversationSession(state, source);
    (fresh.harnessOptions as Record<string, unknown>).verbose = false;
    expect(source.harnessOptions).toEqual({ verbose: true });
  });
});
