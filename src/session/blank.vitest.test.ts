import { describe, expect, it } from 'vitest';
import type { HarnessSession } from './model.js';
import { chatNamed, isBlankConversation, sessionPickerOptions } from './options.js';

const now = new Date().toISOString();
const chat = (extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'blank', conversationId: 'blank', route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet',
  effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
  nativeHarness: 'claude', ...extra,
} as HarnessSession);

describe('a chat nothing happened in', () => {
  it('is blank when opened and left alone', () => {
    expect(isBlankConversation(chat())).toBe(true);
  });

  it('is not blank once anything of the user\'s is in it', () => {
    const cases: Array<[string, Partial<HarnessSession>]> = [
      ['a message', { messages: [{ role: 'user', content: 'hi' }] }],
      ['a turn in flight', { pendingTurn: { prompt: 'hi', startedAt: now, updatedAt: now, outputStarted: false } }],
      ['a queued message', { queuedTurns: [{ id: 'q', text: 'hi', submittedAt: now }] }],
      ['an attached file', { attachments: ['/tmp/shot.png'] }],
      ['a name the user gave it', { name: 'Keep me', nameSource: 'user' }],
      ['a vendor thread it was adopted from', { nativeSessionId: 'abc' }],
    ];
    for (const [what, extra] of cases) expect(isBlankConversation(chat(extra)), what).toBe(false);
  });

  it('is not offered in /resume -- except the one open now', () => {
    const used = chat({ id: 'used', conversationId: 'used', messages: [{ role: 'user', content: 'hi' }] });
    const stranded = chat({ id: 'stranded', conversationId: 'stranded' });
    const open = chat({ id: 'open', conversationId: 'open' });
    const listed = sessionPickerOptions([used, stranded, open], 'open', () => 'Claude Code').map((option) => option.value);
    expect(listed).toContain('used');
    expect(listed).toContain('open');
    // One a killed process left behind is as invisible as one never made.
    expect(listed).not.toContain('stranded');
  });
});

describe('/resume <name>', () => {
  const named = (id: string, name: string, updatedAt = now) => chat({ id, conversationId: id, name, updatedAt, messages: [{ role: 'user', content: 'x' }] });
  const sessions = [
    named('a', 'Prod Disk Cleanup'), named('b', 'Scroll Fix'), named('c', 'Scroll Regression'),
    chat({ id: 'blank', conversationId: 'blank', name: 'Untitled' }),
  ];

  it('opens the one conversation a name picks out', () => {
    expect(chatNamed(sessions, 'prod disk cleanup', 'x')).toBe('a');
    expect(chatNamed(sessions, 'disk', 'x')).toBe('a');
  });

  it('opens the list when two conversations match, rather than guessing', () => {
    expect(chatNamed(sessions, 'scroll', 'x')).toBeUndefined();
    expect(chatNamed(sessions, 'scroll fix', 'x')).toBe('b');
  });

  it('never picks the chat already open, or one nothing happened in', () => {
    expect(chatNamed(sessions, 'prod disk', 'a')).toBeUndefined();
    expect(chatNamed(sessions, 'untitled', 'x')).toBeUndefined();
  });
});
