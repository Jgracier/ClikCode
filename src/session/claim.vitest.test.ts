import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SESSION_CLAIM_TTL_MS, claimSession, releaseSession, sessionClaimIsLive } from './claim.js';
import type { HarnessSession } from '../harness/types.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const session = (id: string, overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id, conversationId: id, route: 'local', accountId: null, provider: 'anthropic',
  model: null, effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted',
  createdAt: at(-60_000), updatedAt: at(-60_000), status: 'active',
  ...overrides,
});

const claimedBy = (pid: number, heartbeatOffset = 0, host = hostname()) => ({
  pid, host, startedAt: at(-60_000), heartbeatAt: at(heartbeatOffset),
});

const alive = () => true;
const dead = () => false;

describe('session claims', () => {
  it('treats an unclaimed conversation as free', () => {
    expect(sessionClaimIsLive(session('a'), NOW, hostname(), alive)).toBe(false);
  });

  it('treats a heartbeating claim from a live process as busy', () => {
    const busy = session('a', { claim: claimedBy(4242) });
    expect(sessionClaimIsLive(busy, NOW, hostname(), alive)).toBe(true);
  });

  it('frees a conversation whose terminal died', () => {
    // The pid is gone, so the claim is released immediately rather than making
    // the conversation unreachable until the TTL expires.
    const crashed = session('a', { claim: claimedBy(4242) });
    expect(sessionClaimIsLive(crashed, NOW, hostname(), dead)).toBe(false);
  });

  it('frees a conversation whose heartbeat went stale', () => {
    const stale = session('a', { claim: claimedBy(4242, -(SESSION_CLAIM_TTL_MS + 1000)) });
    expect(sessionClaimIsLive(stale, NOW, hostname(), alive)).toBe(false);
  });

  it('never resumes another machine on a pid it cannot check', () => {
    // A pid only means something on the host that recorded it, so a remote
    // claim is judged on its heartbeat alone.
    const remote = session('a', { claim: claimedBy(4242, 0, 'another-machine') });
    expect(sessionClaimIsLive(remote, NOW, hostname(), dead)).toBe(true);
    const remoteStale = session('a', { claim: claimedBy(4242, -(SESSION_CLAIM_TTL_MS + 1000), 'another-machine') });
    expect(sessionClaimIsLive(remoteStale, NOW, hostname(), alive)).toBe(false);
  });

  it('does not treat this terminal as blocking itself', () => {
    const mine = session('a', { claim: claimedBy(process.pid) });
    expect(sessionClaimIsLive(mine, NOW, hostname(), alive)).toBe(false);
  });
});

describe('a busy conversation is not offered for resume', () => {
  // Launching always starts a new conversation, so /resume is the only
  // remaining way into an existing one -- and therefore the only place a second
  // terminal could still land in a chat that is already open somewhere else.
  const resumable = (sessions: HarnessSession[], currentId: string) => sessions
    .filter((item) => item.id === currentId || !sessionClaimIsLive(item, NOW, hostname(), alive))
    .map((item) => item.id);

  it('hides a conversation another terminal is driving', () => {
    const busy = session('busy', { claim: claimedBy(4242) });
    const free = session('free');
    expect(resumable([busy, free], 'current')).toEqual(['free']);
  });

  it('still lists the conversation this terminal is in', () => {
    // This terminal's own chat is claimed by this terminal; hiding it would
    // make the row you are sitting in vanish from its own picker.
    const mine = session('mine', { claim: claimedBy(process.pid) });
    expect(resumable([mine], 'mine')).toEqual(['mine']);
  });

  it('offers a conversation again once its terminal exits', () => {
    const released = session('released');
    expect(resumable([released], 'current')).toEqual(['released']);
  });
});

describe('claim ownership', () => {
  it('round-trips a claim for this process', () => {
    const mine = session('a');
    claimSession(mine, at(0));
    expect(mine.claim).toMatchObject({ pid: process.pid, host: hostname(), heartbeatAt: at(0) });
    releaseSession(mine);
    expect(mine.claim).toBeUndefined();
  });

  it('preserves the original start time across heartbeats', () => {
    const mine = session('a');
    claimSession(mine, at(0));
    claimSession(mine, at(5_000));
    expect(mine.claim).toMatchObject({ startedAt: at(0), heartbeatAt: at(5_000) });
  });

  it('never releases a claim belonging to another terminal', () => {
    const theirs = session('a', { claim: claimedBy(4242) });
    releaseSession(theirs);
    expect(theirs.claim, 'one terminal stole another terminal_s conversation').toBeDefined();
  });
});
