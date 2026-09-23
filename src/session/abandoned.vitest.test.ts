import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { SESSION_IDLE_WINDOW_MS, closeAbandonedSessions } from './abandoned';
import type { HarnessSession, HarnessState } from './model';

const NOW = Date.parse('2026-09-22T18:00:00.000Z');
const HOST = hostname();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const noWorkers = () => false;

function session(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'session-1', conversationId: 'c1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never',
    createdAt: ago(SESSION_IDLE_WINDOW_MS * 2), updatedAt: ago(SESSION_IDLE_WINDOW_MS * 2),
    status: 'active', ...overrides,
  } as HarnessSession;
}
const stateWith = (...sessions: HarnessSession[]) => ({ sessions } as unknown as HarnessState);

describe('closing sessions nothing is running any more', () => {
  it('closes an active session with no claim, no worker and no recent activity', () => {
    // The shape found live: 75 of 83 sessions `active`, three workers running.
    const state = stateWith(session());
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual(['session-1']);
    expect(state.sessions[0]!.status).toBe('closed');
    expect(state.sessions[0]!.closedAt).toBe(new Date(NOW).toISOString());
  });

  it('leaves a session whose worker is still alive', () => {
    // A worker sitting idle for 29 minutes is not abandoned -- and it will
    // close its own session when it does give up.
    const state = stateWith(session());
    expect(closeAbandonedSessions(state, (id) => id === 'session-1', NOW, HOST)).toEqual([]);
    expect(state.sessions[0]!.status).toBe('active');
  });

  it('leaves a session an interactive client still claims', () => {
    // pid 1 stands in for another live process: sessionClaimIsLive answers
    // "is someone ELSE holding this", and so reports false for the calling
    // process's own claim -- which is why this cannot use process.pid.
    const state = stateWith(session({
      claim: { pid: 1, host: HOST, startedAt: ago(1_000), heartbeatAt: ago(1_000) },
    }));
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual([]);
  });

  it('closes a session whose claim is stale, which is the crashed-terminal case', () => {
    const state = stateWith(session({
      claim: { pid: 1, host: HOST, startedAt: ago(SESSION_IDLE_WINDOW_MS), heartbeatAt: ago(SESSION_IDLE_WINDOW_MS) },
    }));
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual(['session-1']);
  });

  it('leaves a session touched recently, which is what makes the other two checks safe', () => {
    // A session between creation and its first turn has no claim and no
    // worker yet. Without the age check this swept it away mid-setup.
    const state = stateWith(session({ updatedAt: ago(60_000) }));
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual([]);
    expect(state.sessions[0]!.status).toBe('active');
  });

  it('does not touch sessions that are already closed or archived', () => {
    const state = stateWith(
      session({ id: 'a', status: 'closed', closedAt: ago(SESSION_IDLE_WINDOW_MS * 3) }),
      session({ id: 'b', status: 'archived' }),
    );
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual([]);
    expect(state.sessions.map((s) => s.status)).toEqual(['closed', 'archived']);
  });

  it('treats a missing or unreadable timestamp as no evidence of abandonment', () => {
    const state = stateWith(
      session({ id: 'a', updatedAt: undefined as unknown as string }),
      session({ id: 'b', updatedAt: 'not a date' }),
    );
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual([]);
  });

  it('will not judge a session abandoned sooner than its worker would have', () => {
    // Exactly at the boundary is still alive: the worker has only just then
    // decided to give up, and it closes its own session when it does.
    const state = stateWith(session({ updatedAt: ago(SESSION_IDLE_WINDOW_MS) }));
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual([]);
    const past = stateWith(session({ updatedAt: ago(SESSION_IDLE_WINDOW_MS + 1) }));
    expect(closeAbandonedSessions(past, noWorkers, NOW, HOST)).toEqual(['session-1']);
  });

  it('closes every abandoned session in one pass and reports them all', () => {
    const state = stateWith(
      session({ id: 'a' }), session({ id: 'b' }),
      session({ id: 'kept', updatedAt: ago(1_000) }),
    );
    expect(closeAbandonedSessions(state, noWorkers, NOW, HOST)).toEqual(['a', 'b']);
    expect(state.sessions.map((s) => s.status)).toEqual(['closed', 'closed', 'active']);
  });
});
