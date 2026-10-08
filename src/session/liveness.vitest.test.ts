import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { sessionActivity, sessionIsLive } from './liveness';
import type { HarnessSession } from './model';

const NOW = Date.parse('2026-09-22T18:00:00.000Z');
const HOST = hostname();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const noWorkers = () => false;
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
  it('is false for a session with no claim and no worker', () => {
    // The shape that used to be swept: `active` with nothing behind it. It now
    // simply reports as not live, with nothing to correct and no write.
    expect(sessionIsLive(session(), noWorkers, NOW, HOST)).toBe(false);
  });

  it('is true while a worker exists, however old the session is', () => {
    expect(sessionIsLive(session(), workerFor('session-1'), NOW, HOST)).toBe(true);
  });

  it('is true while an interactive client holds a live claim', () => {
    // pid 1 stands in for another live process: sessionClaimIsLive answers
    // "is someone ELSE holding this", so it cannot use process.pid.
    const held = session({ claim: { pid: 1, host: HOST, startedAt: ago(1_000), heartbeatAt: ago(1_000) } });
    expect(sessionIsLive(held, noWorkers, NOW, HOST)).toBe(true);
  });

  it('is false once a claim heartbeat goes stale, which is the crashed-terminal case', () => {
    const crashed = session({ claim: { pid: 1, host: HOST, startedAt: ago(600_000), heartbeatAt: ago(600_000) } });
    expect(sessionIsLive(crashed, noWorkers, NOW, HOST)).toBe(false);
  });

  it('needs only one of the two signals, because neither covers the other', () => {
    // A headless `sessions send` takes no claim but has a worker; an
    // interactive client holds a claim before its worker has been spawned.
    const claimOnly = session({ claim: { pid: 1, host: HOST, startedAt: ago(1_000), heartbeatAt: ago(1_000) } });
    expect(sessionIsLive(claimOnly, noWorkers, NOW, HOST)).toBe(true);
    expect(sessionIsLive(session(), workerFor('session-1'), NOW, HOST)).toBe(true);
  });

  it('never reports a session the user closed or archived as live', () => {
    // User intent outranks a process that happens to still be attached, and
    // no background process gets to overrule it in the other direction either.
    for (const status of ['closed', 'archived'] as const) {
      expect(sessionIsLive(session({ status }), workerFor('session-1'), NOW, HOST)).toBe(false);
    }
  });

  it('answers the same way whenever it is asked, with no write and no window', () => {
    // The property the cache-plus-sweep could not have: asking later cannot
    // change the answer, so there is no interval in which it is wrong.
    const abandoned = session();
    expect(sessionIsLive(abandoned, noWorkers, NOW, HOST)).toBe(false);
    expect(sessionIsLive(abandoned, noWorkers, NOW + 86_400_000, HOST)).toBe(false);
    expect(abandoned.status).toBe('active');
    expect(abandoned.closedAt).toBeUndefined();
  });
});

describe('what a live session is doing', () => {
  const turn = { prompt: 'go', startedAt: ago(5_000), updatedAt: ago(1_000), outputStarted: true };

  it('is working while a live session has a turn in flight', () => {
    expect(sessionActivity(session({ pendingTurn: turn }), workerFor('session-1'), NOW, HOST)).toBe('working');
  });

  it('is working on the transcript turn a list read for it', () => {
    expect(sessionActivity(session(), workerFor('session-1'), NOW, HOST, turn)).toBe('working');
  });

  it('is never working on a claim alone: generating needs the worker', () => {
    const held = session({ claim: { pid: 1, host: HOST, startedAt: ago(1_000), heartbeatAt: ago(1_000) } });
    expect(sessionActivity(held, noWorkers, NOW, HOST, turn)).toBe('idle');
  });

  it('is idle while a live session sits between turns', () => {
    expect(sessionActivity(session(), workerFor('session-1'), NOW, HOST)).toBe('idle');
  });

  it('is nothing for a crashed turn, whose journal outlives its process on purpose', () => {
    expect(sessionActivity(session({ pendingTurn: turn }), noWorkers, NOW, HOST)).toBeUndefined();
  });

  it('is nothing for a chat the user closed, even with a worker still exiting', () => {
    expect(sessionActivity(session({ status: 'closed' }), workerFor('session-1'), NOW, HOST)).toBeUndefined();
  });
});
