import { describe, expect, it } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { shouldWarmVendorChat } from './warm-policy.js';

const chat = (nativeHarness: string, extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'chat', route: 'local', nativeHarness, accountId: 'account', nativeSessionId: 'thread',
  ...extra,
} as HarnessSession);

describe('vendor warm-up policy', () => {
  it('warms resumable ACP and app-server chats, including a provider handoff with history', () => {
    expect(shouldWarmVendorChat(chat('claude'))).toBe(true);
    expect(shouldWarmVendorChat(chat('codex'))).toBe(true);
    expect(shouldWarmVendorChat(chat('claude', { nativeSessionId: undefined, messages: [{ role: 'user', content: 'earlier' }] }))).toBe(true);
  });

  it('skips empty chats and one-shot CLI threads', () => {
    expect(shouldWarmVendorChat(chat('claude', { nativeSessionId: undefined, messages: [] }))).toBe(false);
    expect(shouldWarmVendorChat(chat('aider'))).toBe(false);
    expect(shouldWarmVendorChat(chat('gemini', { nativeTransport: 'structured-cli' }))).toBe(false);
    expect(shouldWarmVendorChat(chat('claude', { route: 'gateway' }))).toBe(false);
  });
});
