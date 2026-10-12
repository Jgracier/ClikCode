import { describe, expect, it } from 'vitest';
import { applySession, emptyModel, type Note } from '../../src/model';
import type { HarnessSession } from '../../../../src/session/model';

const session = (nativeHarness: string, messages: unknown[] = []): HarnessSession => ({ id: 's1', route: 'native', nativeHarness, messages } as unknown as HarnessSession);
const info: Note = { after: 0, kind: 'notice', level: 'info', text: 'Sign-in to Grok Build cancelled' };

describe('notes when a chat moves to another provider', () => {
  const onGrok = { ...applySession(emptyModel(), session('grok')), notes: [info] };

  it('are dropped while the chat is still empty: they were about the provider it left', () => {
    const moved = applySession(onGrok, session('opencode'));
    expect(moved.providerId).toBe('opencode');
    expect(moved.notes).toEqual([]);
  });

  it('stay while the same provider is still the chat\'s, so a cancelled sign-in is seen', () => {
    expect(applySession(onGrok, session('grok')).notes).toEqual([info]);
  });

  it('stay once the chat has a conversation in it', () => {
    const talking = { ...onGrok, messages: [{ role: 'user', content: 'hi' }] };
    expect(applySession(talking, session('opencode', [{ role: 'user', content: 'hi' }])).notes).toEqual([info]);
  });

  it('stay while a turn is running', () => {
    expect(applySession({ ...onGrok, running: true }, session('opencode')).notes).toEqual([info]);
  });
});
