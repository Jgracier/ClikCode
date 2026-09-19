/** Which terminal is driving a conversation right now.
 *
 * A claim used to be a field on the session record. The record is merged as a
 * unit, so a long turn's snapshot -- read before the 30s heartbeat ran -- kept
 * writing the *old* heartbeat back over the refreshed one. After the TTL the
 * conversation looked abandoned and a second terminal could attach mid-turn.
 *
 * Claim truth now lives in `claims/<sessionId>.json`, outside every snapshot:
 * acquired with create-exclusive semantics, refreshed only by its owner, and
 * overlaid onto `session.claim` when state is read. */

import { randomBytes } from 'node:crypto';
import { link, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, ensurePrivateDirectory, pidIsAlive, safeRecordFileName, stateDirectory } from './session-store.js';

/** Matches ai.ts's SESSION_CLAIM_TTL_MS; the heartbeat runs at a third of it. */
export const SESSION_CLAIM_TTL_MS = 90_000;
/** A live local pid keeps its claim through a stalled heartbeat (suspended
 * laptop, SIGSTOP, a blocked event loop) but not forever: pids get reused. */
export const SESSION_CLAIM_LIVE_PID_MAX_MS = 10 * SESSION_CLAIM_TTL_MS;

export interface SessionClaim {
  sessionId: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  /** Distinguishes two claims by the same pid number (pid reuse, or two
   * conversations in one process). */
  nonce: string;
  /** The controlling terminal when one is known, for diagnostics. */
  terminalId?: string;
}

export interface ClaimOptions {
  now?: number;
  host?: string;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  terminalId?: string;
  /** Heartbeat to record; defaults to `now`. Never moves a heartbeat backwards. */
  heartbeatAt?: string;
}

export type ClaimResult =
  | { acquired: true; claim: SessionClaim }
  | { acquired: false; claim: SessionClaim };

export function claimsDirectory(): string {
  return join(stateDirectory(), 'claims');
}

export function claimFilePath(sessionId: string): string {
  return join(claimsDirectory(), `${safeRecordFileName(sessionId)}.json`);
}

function currentTerminalId(): string | undefined {
  return process.env.CLIKCODE_TERMINAL_ID?.trim() || process.env.TERM_SESSION_ID?.trim() || process.env.WINDOWID?.trim() || undefined;
}

function parseClaim(raw: string | undefined): SessionClaim | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionClaim>;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string' && typeof parsed.heartbeatAt === 'string'
      && typeof parsed.sessionId === 'string'
      ? { startedAt: parsed.heartbeatAt, nonce: '', ...parsed } as SessionClaim
      : undefined;
  } catch {
    return undefined;
  }
}

/** Does this claim still hold?
 *
 * Where the pid can be checked (same host) it is checked first: a dead owner
 * frees the conversation immediately, and a live owner keeps it even if its
 * heartbeat stalled. The TTL alone decides only for another machine's claim. */
export function claimIsHeld(claim: SessionClaim, options: ClaimOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const age = now - Date.parse(claim.heartbeatAt);
  if (claim.host === (options.host ?? hostname())) {
    if (!(options.pidAlive ?? pidIsAlive)(claim.pid)) return false;
    return !(age > SESSION_CLAIM_LIVE_PID_MAX_MS);
  }
  return !(age > SESSION_CLAIM_TTL_MS);
}

function ownedBy(claim: SessionClaim, options: ClaimOptions): boolean {
  return claim.pid === (options.pid ?? process.pid) && claim.host === (options.host ?? hostname());
}

async function readRaw(sessionId: string): Promise<string | undefined> {
  return readFile(claimFilePath(sessionId), 'utf8').catch(() => undefined);
}

/** Removes `path` only if it still holds exactly `observedRaw`. Rename is
 * atomic, so of any number of contenders one takes the file; if what it took is
 * not what it judged (a fresh claim landed in between) it is put back. */
async function removeIfUnchanged(path: string, observedRaw: string): Promise<boolean> {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  const taken = await readFile(aside, 'utf8').catch(() => undefined);
  const matched = taken === observedRaw;
  if (!matched) await link(aside, path).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  return matched;
}

export async function readSessionClaim(sessionId: string): Promise<SessionClaim | undefined> {
  return parseClaim(await readRaw(sessionId));
}

/** Every claim on disk, keyed by session id. Small files, one directory read. */
export async function readSessionClaims(): Promise<Map<string, SessionClaim>> {
  const claims = new Map<string, SessionClaim>();
  const names = await readdir(claimsDirectory()).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    const claim = parseClaim(await readFile(join(claimsDirectory(), name), 'utf8').catch(() => undefined));
    if (claim) claims.set(claim.sessionId, claim);
  }));
  return claims;
}

/** Compare-and-swap acquisition.
 *
 * Succeeds only when no claim exists (create-exclusive), when this process
 * already owns it (refresh), or when the existing claim is no longer held. A
 * dead claim is removed by renaming it to a private name -- atomic, so of any
 * number of contenders exactly one takes it -- and the winner of the following
 * exclusive create owns the conversation. */
export async function acquireSessionClaim(sessionId: string, options: ClaimOptions = {}): Promise<ClaimResult> {
  await ensurePrivateDirectory(claimsDirectory());
  const path = claimFilePath(sessionId);
  const nowIso = options.heartbeatAt ?? new Date(options.now ?? Date.now()).toISOString();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const mine: SessionClaim = {
      sessionId, pid: options.pid ?? process.pid, host: options.host ?? hostname(),
      startedAt: nowIso, heartbeatAt: nowIso, nonce: randomBytes(9).toString('hex'),
      ...(options.terminalId ?? currentTerminalId() ? { terminalId: options.terminalId ?? currentTerminalId() } : {}),
    };
    try {
      // Written to a private name first and hard-linked into place: the claim
      // appears under its real name complete or not at all, and `link` fails
      // with EEXIST exactly like an exclusive create.
      const staging = `${path}.${process.pid}.${mine.nonce}.new`;
      const handle = await open(staging, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(mine), 'utf8'); } finally { await handle.close(); }
      try {
        await link(staging, path);
      } finally {
        await unlink(staging).catch(() => undefined);
      }
      return { acquired: true, claim: mine };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const raw = await readRaw(sessionId);
    if (raw === undefined) continue; // Released between the two calls; try again.
    const existing = parseClaim(raw);
    if (existing && ownedBy(existing, options)) {
      const refreshed = await heartbeatSessionClaim(sessionId, options);
      if (refreshed) return { acquired: true, claim: refreshed };
      continue;
    }
    if (existing && claimIsHeld(existing, options)) return { acquired: false, claim: existing };
    // Dead (or unreadable) claim: take it aside, confirming it is the one judged.
    await removeIfUnchanged(path, raw);
  }
  const existing = await readSessionClaim(sessionId);
  if (existing) return { acquired: false, claim: existing };
  throw new Error(`Could not settle the claim for conversation ${sessionId}.`);
}

/** Refreshes this process's claim. Returns undefined when the conversation is
 * not (or no longer) ours -- the caller must then stop writing to it. */
export async function heartbeatSessionClaim(sessionId: string, options: ClaimOptions = {}): Promise<SessionClaim | undefined> {
  const existing = await readSessionClaim(sessionId);
  if (!existing || !ownedBy(existing, options)) return undefined;
  const heartbeatAt = options.heartbeatAt ?? new Date(options.now ?? Date.now()).toISOString();
  // A snapshot taken before the last refresh must not rewind it.
  if (Date.parse(heartbeatAt) <= Date.parse(existing.heartbeatAt)) return existing;
  const next: SessionClaim = { ...existing, heartbeatAt };
  await atomicWriteFile(claimFilePath(sessionId), JSON.stringify(next));
  return next;
}

/** Only the owner releases, so a terminal can never free another's conversation. */
export async function releaseSessionClaim(sessionId: string, options: ClaimOptions = {}): Promise<boolean> {
  const existing = await readSessionClaim(sessionId);
  if (!existing || !ownedBy(existing, options)) return false;
  await unlink(claimFilePath(sessionId)).catch(() => undefined);
  return true;
}

/** Drops claims whose owner is gone, and claims for conversations that no
 * longer exist. Housekeeping only; correctness never depends on it. */
export async function pruneSessionClaims(knownSessionIds?: ReadonlySet<string>, options: ClaimOptions = {}): Promise<number> {
  let removed = 0;
  for (const [sessionId, claim] of await readSessionClaims()) {
    if (claimIsHeld(claim, options) && (!knownSessionIds || knownSessionIds.has(sessionId))) continue;
    const raw = await readRaw(sessionId);
    if (raw === undefined || parseClaim(raw)?.nonce !== claim.nonce) continue;
    if (await removeIfUnchanged(claimFilePath(sessionId), raw)) removed += 1;
  }
  return removed;
}
