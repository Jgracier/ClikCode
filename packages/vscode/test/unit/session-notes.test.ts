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
    const talking = { ...onGrok, messages: [{ role: 'user' as const, content: 'hi' }] };
    expect(applySession(talking, session('opencode', [{ role: 'user', content: 'hi' }])).notes).toEqual([info]);
  });

  it('stay while a turn is running', () => {
    expect(applySession({ ...onGrok, running: true }, session('opencode')).notes).toEqual([info]);
  });
});

describe('a compaction ClikCode ran itself', () => {
  const why = 'Compacted automatically: the context was 670k tokens, over the 250k setting (/settings global compact)';

  it('keeps why with the saved message, so it is drawn as a notice and not as the user\'s /compact', () => {
    const saved = applySession(emptyModel(), session('claude', [{ role: 'user', content: '/compact', automatic: why }, { role: 'assistant', content: 'Compacted.' }]));
    expect(saved.messages[0]).toEqual({ role: 'user', content: '/compact', automatic: why });
    const typed = applySession(emptyModel(), session('claude', [{ role: 'user', content: '/compact' }]));
    expect(typed.messages[0]).toEqual({ role: 'user', content: '/compact' });
  });

  it('draws the running one as its notice in place of the prompt', () => {
    const running = applySession({ ...emptyModel(), running: true }, { ...session('claude'), pendingTurn: { prompt: '/compact', automatic: why, startedAt: '', updatedAt: '', outputStarted: false } } as HarnessSession);
    expect(running.pendingPrompt).toBeUndefined();
    expect(running.pendingNotice).toBe(why);
  });
});
