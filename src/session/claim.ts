/**
 * Who has a conversation open.
 *
 * One conversation, one terminal: a claim records the process holding it and
 * is refreshed while that process lives, so a second terminal can tell a live
 * chat from one left behind by a crash and never attaches to the same
 * conversation twice.
 */
import { hostname } from 'node:os';
import type { HarnessSession } from './model.js';
import { SESSION_CLAIM_TTL_MS } from './claims.js';
import { pidIsAlive } from './store/locks.js';

export { SESSION_CLAIM_TTL_MS };

/** Is another terminal driving this conversation right now?
 *
 * A pid is only meaningful on the machine that recorded it, so a claim from a
 * different host is judged on its heartbeat alone. On this host a dead pid
 * releases the claim immediately, which is what makes a crashed terminal's
 * conversation available again without waiting out the TTL. */
export function sessionClaimIsLive(
  session: HarnessSession,
  now = Date.now(),
  host = hostname(),
  pidAlive: (pid: number) => boolean = pidIsAlive,
): boolean {
  const claim = session.claim;
  if (!claim) return false;
  if (now - Date.parse(claim.heartbeatAt) > SESSION_CLAIM_TTL_MS) return false;
  if (claim.host !== host) return true;
  if (claim.pid === process.pid) return false;
  return pidAlive(claim.pid);
}

export function claimSession(session: HarnessSession, now = new Date().toISOString()): void {
  session.claim = {
    pid: process.pid, host: hostname(),
    startedAt: session.claim?.pid === process.pid ? session.claim.startedAt : now,
    heartbeatAt: now,
  };
}

/** Only the owner releases a claim, so a crash-recovered stale claim is never
 * cleared by a terminal that does not own the conversation. */
export function releaseSession(session: HarnessSession): void {
  if (session.claim?.pid === process.pid && session.claim.host === hostname()) delete session.claim;
}
