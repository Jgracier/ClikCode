/** One housekeeping pass over the state directory, at most once a day.
 *
 * Deleting a chat removes everything it had (writeState ->
 * forgetSessionArtifacts). This pass is for what older builds, crashes and
 * other processes left: artifacts of chats that no longer exist, claims of
 * dead processes, temporaries a crash stranded, stored empty chats, and the
 * journals of turns whose process died long ago. Bounded and best-effort:
 * nothing depends on it running, and a failure only means the next one
 * tries again. */

import { stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blankChatSweepable } from '../blank.js';
import { sessionClaimIsLive } from '../claim.js';
import { pruneSessionClaims } from '../claims.js';
import { sessionFromIndex } from '../list-facts.js';
import { liveWorkerSessions } from '../liveness.js';
import type { HarnessSession } from '../model.js';
import { ensurePrivateDirectory } from '../store/files.js';
import { forgetSessionArtifacts, removeStrandedFiles, sessionIdsWithArtifacts } from '../store/forget.js';
import { safeRecordFileName, stateDirectory } from '../store/paths.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { readState } from './read.js';
import { writeState } from './write.js';

const HOUR_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 24 * HOUR_MS;
/** Anything younger may belong to a chat being created right now. */
const ORPHAN_MIN_AGE_MS = HOUR_MS;
/** A turn journal with no process behind it for this long is settled into
 * the conversation, exactly as the chat's next turn would (beginPendingTurn). */
const STALE_TURN_MS = 24 * HOUR_MS;
/** At most this many orphans are removed per pass. */
const MAX_ORPHANS = 500;

export interface SweepReport { orphans: number; claims: number; stranded: number; blank: number; settled: number }

/** A turn journal nothing is running, old enough that no one is waiting on it. */
function staleTurn(session: HarnessSession, workerIsLive: (id: string) => boolean, now: number): boolean {
  const pending = session.pendingTurn;
  if (!pending || session.resumeAt || workerIsLive(session.id) || sessionClaimIsLive(session, now)) return false;
  return now - (Date.parse(pending.updatedAt ?? pending.startedAt) || 0) > STALE_TURN_MS;
}

async function oldEnough(path: string, now: number): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return !info || now - info.mtimeMs > ORPHAN_MIN_AGE_MS;
}

export async function sweepState(now = Date.now()): Promise<SweepReport> {
  const report: SweepReport = { orphans: 0, claims: 0, stranded: 0, blank: 0, settled: 0 };
  report.stranded = await removeStrandedFiles(HOUR_MS, now);

  const state = await readState();
  const workerIsLive = await liveWorkerSessions();
  let changed = false;
  // Empty chats left on disk (with or without a transcript file), under the
  // same rule as every other blank sweep: never one something may be using.
  const kept = state.sessions.filter((session) => !sessionFromIndex(session) || !blankChatSweepable(session, workerIsLive, now));
  report.blank = state.sessions.length - kept.length;
  if (report.blank) { state.sessions = kept; changed = true; }
  for (const session of state.sessions) {
    if (!staleTurn(session, workerIsLive, now)) continue;
    session.messages = sessionTranscriptMessages(session);
    delete session.pendingTurn;
    report.settled += 1;
    changed = true;
  }
  if (changed) await writeState(state);

  const known = new Set(state.sessions.map((session) => session.id));
  report.claims = await pruneSessionClaims(known).catch(() => 0);
  // Every name a live chat's artifacts can have (the stores encode ids).
  const names = new Set(state.sessions.flatMap((session) => [session.id, safeRecordFileName(session.id), session.id.replace(/[^A-Za-z0-9._-]/g, '_')]));
  const root = stateDirectory();
  for (const id of await sessionIdsWithArtifacts()) {
    if (report.orphans >= MAX_ORPHANS) break;
    if (names.has(id)) continue;
    const places = [join(root, 'sessions', id), join(root, 'checkpoints', id), join(root, 'turn-changes', `${id}.json`)];
    if (!(await Promise.all(places.map((path) => oldEnough(path, now)))).every(Boolean)) continue;
    await forgetSessionArtifacts(id);
    report.orphans += 1;
  }
  return report;
}

let running: Promise<SweepReport | undefined> | undefined;

/** sweepState, at most once a day per state directory and once per process.
 * Not under the test runner, whose fixtures are full of old, empty chats a
 * background pass would delete mid-test; tests call sweepState directly. */
export function sweepStateDaily(): Promise<SweepReport | undefined> {
  if (process.env.VITEST) return Promise.resolve(undefined);
  running ??= (async () => {
    await ensurePrivateDirectory(join(stateDirectory(), 'cache'));
    const marker = join(stateDirectory(), 'cache', 'state-sweep');
    const last = await stat(marker).catch(() => undefined);
    if (last && Date.now() - last.mtimeMs < SWEEP_EVERY_MS) return undefined;
    // Claimed before the pass, so two launches at once do not both run it.
    await writeFile(marker, '', { mode: 0o600 }).catch(() => undefined);
    const now = new Date();
    await utimes(marker, now, now).catch(() => undefined);
    return sweepState();
  })();
  return running;
}
