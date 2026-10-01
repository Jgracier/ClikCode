import { describe, expect, it } from 'vitest';
import { listedPending, markTranscriptLoaded, reconcileListTurns, stampListFacts } from './list-facts';
import type { HarnessSession } from './model';

function session(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1', conversationId: 'c1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', status: 'active',
    ...overrides,
  } as HarnessSession;
}

describe('reconcileListTurns', () => {
  const turn = { startedAt: '2026-09-01T00:00:00.000Z', prompt: 'go' };

  it('drops an index turn when no worker is alive', async () => {
    const row = session({ listTurn: turn });
    expect(await reconcileListTurns([row], () => false, async () => undefined)).toBe(true);
    expect(row.listTurn).toBeUndefined();
  });

  it('drops an index turn when the worker is idle and the journal has no turn', async () => {
    const row = session({ listTurn: turn });
    expect(await reconcileListTurns([row], () => true, async () => undefined)).toBe(true);
    expect(row.listTurn).toBeUndefined();
  });

  it('keeps an index turn while the journal still has one', async () => {
    const row = session({ listTurn: turn });
    const pending = { prompt: 'go', startedAt: turn.startedAt, updatedAt: turn.startedAt, outputStarted: true };
    expect(await reconcileListTurns([row], () => true, async () => pending)).toBe(false);
    expect(row.listTurn).toEqual(turn);
  });

  it('leaves a live pendingTurn alone', async () => {
    const pending = { prompt: 'go', startedAt: turn.startedAt, updatedAt: turn.startedAt, outputStarted: true };
    const row = session({ pendingTurn: pending, listTurn: turn });
    expect(await reconcileListTurns([row], () => true, async () => undefined)).toBe(false);
    expect(row.listTurn).toEqual(turn);
  });
});

describe('listedPending', () => {
  it('prefers the live journal, then the index copy', () => {
    const pending = { prompt: 'live', startedAt: 'a', updatedAt: 'b', outputStarted: true };
    expect(listedPending(session({ pendingTurn: pending }))).toEqual(pending);
    expect(listedPending(session({ listTurn: { startedAt: 'a', prompt: 'index' } }), 'mtime'))
      .toMatchObject({ prompt: 'index', updatedAt: 'mtime' });
  });
});

describe('stampListFacts', () => {
  it('clears listTurn when the transcript has no pending turn', () => {
    const row = session({ listTurn: { startedAt: 'a', prompt: 'go' }, messages: [{ role: 'user', content: 'go' }] });
    markTranscriptLoaded(row);
    expect(stampListFacts(row)).toBe(true);
    expect(row.listTurn).toBeUndefined();
    expect(row.listPreview).toBe('go');
  });
});
