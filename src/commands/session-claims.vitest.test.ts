import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_CLAIM_LIVE_PID_MAX_MS, SESSION_CLAIM_TTL_MS, acquireSessionClaim, claimIsHeld, claimsDirectory,
  heartbeatSessionClaim, pruneSessionClaims, readSessionClaim, releaseSessionClaim,
} from './session-claims';

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clikcode-claims-'));
  previousHome = process.env.CLIKCODE_HOME;
  process.env.CLIKCODE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const alive = () => true;
const dead = () => false;
const terminal = (pid: number, extra: Record<string, unknown> = {}) => ({ pid, host: hostname(), now: NOW, pidAlive: alive, ...extra });

describe('session claim compare-and-swap', () => {
  it('gives a free conversation to exactly one of many contenders', async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = `chat-${round}`;
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) => acquireSessionClaim(id, terminal(1000 + index))));
      const winners = results.filter((result) => result.acquired);
      expect(winners, `round ${round}`).toHaveLength(1);
      const owner = await readSessionClaim(id);
      expect(owner?.pid).toBe(winners[0]!.claim.pid);
      for (const loser of results.filter((result) => !result.acquired)) expect(loser.claim.pid).toBe(owner?.pid);
    }
  });

  it('gives a dead terminal_s conversation to exactly one contender', async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = `crashed-${round}`;
      await acquireSessionClaim(id, terminal(4242));
      const pidAlive = (pid: number): boolean => pid !== 4242;
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) => acquireSessionClaim(id, terminal(2000 + index, { pidAlive }))));
      expect(results.filter((result) => result.acquired), `round ${round}`).toHaveLength(1);
      expect((await readSessionClaim(id))?.pid).not.toBe(4242);
    }
    // No staging or aside files are left behind.
    expect((await readdir(claimsDirectory())).filter((name) => !name.endsWith('.json'))).toEqual([]);
  });

  it('refuses a conversation a live terminal holds, even past the heartbeat TTL', async () => {
    await acquireSessionClaim('chat', terminal(4242));
    const later = NOW + SESSION_CLAIM_TTL_MS + 5_000;
    const attempt = await acquireSessionClaim('chat', terminal(5555, { now: later }));
    expect(attempt.acquired, 'a busy turn with a late heartbeat was taken over').toBe(false);
    expect(attempt.claim.pid).toBe(4242);
  });

  it('checks the pid before the TTL: a dead owner frees it at once', async () => {
    await acquireSessionClaim('chat', terminal(4242));
    const attempt = await acquireSessionClaim('chat', terminal(5555, { pidAlive: dead }));
    expect(attempt).toMatchObject({ acquired: true, claim: { pid: 5555 } });
  });

  it('judges another machine on its heartbeat alone', async () => {
    await acquireSessionClaim('chat', { pid: 4242, host: 'another-machine', now: NOW });
    expect((await acquireSessionClaim('chat', terminal(5555, { pidAlive: dead }))).acquired).toBe(false);
    const expired = await acquireSessionClaim('chat', terminal(5555, { now: NOW + SESSION_CLAIM_TTL_MS + 1, pidAlive: dead }));
    expect(expired.acquired).toBe(true);
  });

  it('does not trust a recycled pid forever', () => {
    const claim = { sessionId: 'c', pid: 1, host: hostname(), startedAt: '', heartbeatAt: new Date(NOW).toISOString(), nonce: 'n' };
    expect(claimIsHeld(claim, { now: NOW + SESSION_CLAIM_LIVE_PID_MAX_MS - 1, pidAlive: alive })).toBe(true);
    expect(claimIsHeld(claim, { now: NOW + SESSION_CLAIM_LIVE_PID_MAX_MS + 1, pidAlive: alive })).toBe(false);
  });
});

describe('claim ownership', () => {
  it('refreshes forwards only and keeps the start time', async () => {
    const first = await acquireSessionClaim('chat', terminal(4242));
    const beat = await heartbeatSessionClaim('chat', terminal(4242, { now: NOW + 30_000 }));
    expect(beat).toMatchObject({ startedAt: first.claim.startedAt, heartbeatAt: new Date(NOW + 30_000).toISOString(), nonce: first.claim.nonce });
    // A stale snapshot's heartbeat cannot rewind it.
    const stale = await heartbeatSessionClaim('chat', terminal(4242, { now: NOW + 1_000 }));
    expect(stale?.heartbeatAt).toBe(new Date(NOW + 30_000).toISOString());
    // Re-acquiring your own claim is a refresh, not a new claim.
    const again = await acquireSessionClaim('chat', terminal(4242, { now: NOW + 60_000 }));
    expect(again).toMatchObject({ acquired: true, claim: { startedAt: first.claim.startedAt, nonce: first.claim.nonce } });
  });

  it('never refreshes or releases a claim belonging to another terminal', async () => {
    await acquireSessionClaim('chat', terminal(4242));
    expect(await heartbeatSessionClaim('chat', terminal(5555, { now: NOW + 1 }))).toBeUndefined();
    expect(await releaseSessionClaim('chat', terminal(5555))).toBe(false);
    expect((await readSessionClaim('chat'))?.pid).toBe(4242);
    expect(await releaseSessionClaim('chat', terminal(4242))).toBe(true);
    expect(await readSessionClaim('chat')).toBeUndefined();
  });

  it('addresses hostile ids without leaving the claims directory', async () => {
    const result = await acquireSessionClaim('../../escape', terminal(4242));
    expect(result.acquired).toBe(true);
    expect(await readdir(claimsDirectory())).toHaveLength(1);
    expect((await readSessionClaim('../../escape'))?.sessionId).toBe('../../escape');
  });

  it('prunes claims whose owner is gone', async () => {
    await acquireSessionClaim('live', terminal(4242));
    await acquireSessionClaim('gone', terminal(4343));
    const removed = await pruneSessionClaims(undefined, { now: NOW, host: hostname(), pidAlive: (pid) => pid === 4242 });
    expect(removed).toBe(1);
    expect(await readSessionClaim('live')).toBeDefined();
    expect(await readSessionClaim('gone')).toBeUndefined();
  });
});
