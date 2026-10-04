import { describe, expect, it } from 'vitest';
import { markTranscriptLoaded, stampListFacts } from './list-facts';
import type { HarnessSession } from './model';

function session(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1', conversationId: 'c1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', status: 'active',
    ...overrides,
  } as HarnessSession;
}

describe('stampListFacts', () => {
  it('drops a turn copy an older build stored on the row, and never writes one', () => {
    const row = session({ messages: [{ role: 'user', content: 'go' }] });
    (row as { listTurn?: unknown }).listTurn = { startedAt: 'a', prompt: 'go' };
    markTranscriptLoaded(row);
    expect(stampListFacts(row)).toBe(true);
    expect((row as { listTurn?: unknown }).listTurn).toBeUndefined();
    expect(row.listPreview).toBe('go');

    const running = session({ pendingTurn: { prompt: 'next', startedAt: 'a', updatedAt: 'b', outputStarted: true } });
    markTranscriptLoaded(running);
    stampListFacts(running);
    expect((running as { listTurn?: unknown }).listTurn).toBeUndefined();
  });

  it('previews the last thing the user asked, not a notice ClikCode sent', () => {
    const row = session({ messages: [
      { role: 'user', content: 'deploy it' }, { role: 'assistant', content: 'done' },
      { role: 'user', content: '[ClikCode] Background work you started was stopped: a newer build.' }, { role: 'assistant', content: 'nothing to restart' },
    ] });
    markTranscriptLoaded(row);
    stampListFacts(row);
    expect(row.listPreview).toBe('deploy it');
  });
});
