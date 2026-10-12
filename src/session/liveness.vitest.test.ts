import { describe, expect, it } from 'vitest';
import { sessionActivity, sessionIsLive } from './liveness';
import type { HarnessSession } from './model';

const NOW = Date.parse('2026-09-22T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const noWorkers = () => false;
const openFor = (id: string) => (sessionId: string) => sessionId === id;
const workerFor = (id: string) => (sessionId: string) => sessionId === id;

function session(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'session-1', conversationId: 'c1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask',
    // Deliberately ancient: age is not evidence of anything here, which is the
    // whole point of deriving liveness instead of ageing a cached status out.
    createdAt: ago(86_400_000), updatedAt: ago(86_400_000), status: 'active', ...overrides,
  } as HarnessSession;
}

describe('liveness is derived, so it cannot go stale', () => {
  it('is false for a session with no presence record and no worker', () => {
    // The shape that used to be swept: `active` with nothing behind it. It now
    // simply reports as not live, with nothing to correct and no write.
    expect(sessionIsLive(session(), noWorkers)).toBe(false);
  });

  it('is true while a worker exists, however old the session is', () => {
    expect(sessionIsLive(session(), workerFor('session-1'))).toBe(true);
  });

  it('is true while an interactive client is showing it', () => {
    expect(sessionIsLive(session(), noWorkers, openFor('session-1'))).toBe(true);
  });

  it('is false for a chat another client shows that is not this one', () => {
    expect(sessionIsLive(session(), noWorkers, openFor('other'))).toBe(false);
  });

  it('needs only one of the two signals, because neither covers the other', () => {
    // A headless `sessions send` records no presence but has a worker; an
    // interactive client records presence before its worker has been spawned.
    expect(sessionIsLive(session(), noWorkers, openFor('session-1'))).toBe(true);
    expect(sessionIsLive(session(), workerFor('session-1'))).toBe(true);
  });

  it('never reports a session the user closed or archived as live', () => {
    // User intent outranks a process that happens to still be attached, and
    // no background process gets to overrule it in the other direction either.
    for (const status of ['closed', 'archived'] as const) {
      expect(sessionIsLive(session({ status }), workerFor('session-1'))).toBe(false);
    }
  });

  it('answers the same way whenever it is asked, with no write and no window', () => {
    // The property the cache-plus-sweep could not have: asking later cannot
    // change the answer, so there is no interval in which it is wrong.
    const abandoned = session();
    expect(sessionIsLive(abandoned, noWorkers)).toBe(false);
    expect(sessionIsLive(abandoned, noWorkers, () => false)).toBe(false);
    expect(abandoned.status).toBe('active');
    expect(abandoned.closedAt).toBeUndefined();
  });
});

describe('what a live session is doing', () => {
  const turn = { prompt: 'go', startedAt: ago(5_000), updatedAt: ago(1_000), outputStarted: true };

  it('is working while a live session has a turn in flight', () => {
    expect(sessionActivity(session({ pendingTurn: turn }), workerFor('session-1'))).toBe('working');
  });

  it('is working on the transcript turn a list read for it', () => {
    expect(sessionActivity(session(), workerFor('session-1'), turn)).toBe('working');
  });

  it('is never working on presence alone: generating needs the worker', () => {
    expect(sessionActivity(session(), noWorkers, turn, openFor('session-1'))).toBe('idle');
  });

  it('is idle while a live session sits between turns', () => {
    expect(sessionActivity(session(), workerFor('session-1'))).toBe('idle');
  });

  it('is nothing for a crashed turn, whose journal outlives its process on purpose', () => {
    expect(sessionActivity(session({ pendingTurn: turn }), noWorkers)).toBeUndefined();
  });

  it('is nothing for a chat the user closed, even with a worker still exiting', () => {
    expect(sessionActivity(session({ status: 'closed' }), workerFor('session-1'))).toBeUndefined();
  });
});
