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

/** How long a claim survives without a heartbeat. Generous enough that a busy
 * turn never looks abandoned, short enough that a killed terminal frees its
 * conversation quickly. */
export const SESSION_CLAIM_TTL_MS = 90_000;

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
  pidAlive: (pid: number) => boolean = livePid,
): boolean {
  const claim = session.claim;
  if (!claim) return false;
  if (now - Date.parse(claim.heartbeatAt) > SESSION_CLAIM_TTL_MS) return false;
  if (claim.host !== host) return true;
  if (claim.pid === process.pid) return false;
  return pidAlive(claim.pid);
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/** Leaving the foreground application is not the same operation as closing a
 * conversation. Touch the current branch so it remains the default branch on
 * the next launch, without changing its provider-owned session identity. */
export function markSessionLeftOpen(session: HarnessSession, now: string): void {
  session.status = 'active';
  delete session.closedAt;
  session.updatedAt = now;
}