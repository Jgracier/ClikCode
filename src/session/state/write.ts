/** Writing a HarnessState back, including the session claim the write
 * intends to take or release. */

import { hostname } from 'node:os';
import type { HarnessSession, HarnessState } from '../../harness/types.js';
import { deleteSessionTranscript, readSessionTranscript, sameData, transcriptOf, transcriptParentOf, withStateLock, writeSessionTranscript } from '../store.js';
import { acquireSessionClaim, heartbeatSessionClaim, releaseSessionClaim } from '../claims.js';
import { HarnessStateVersionError, loadIndex, storeIndex } from './index-file.js';
import { capInvocations } from './invocations.js';
import { BaselinedState, STATE_BASELINE, StateBaselineData, indexFromWorking, mergedIndex, rememberBaseline } from './merge.js';
import { ensureLayoutLocked } from './migrate.js';
import { HARNESS_STATE_VERSION, exists, harnessStatePath } from './paths.js';
import { HarnessSecrets, readSecretsFile, sameSecret, writeSecretsFile } from './secrets.js';

/** Claims are owned by session-claims.ts. A caller that still expresses one by
 * editing `session.claim` and writing state is translated into the real
 * operation -- and only ever for this process's own claim, only ever forwards
 * in time. A snapshot can therefore no longer rewind a heartbeat. */
async function applyClaimIntent(state: HarnessState, baseline: StateBaselineData | undefined): Promise<void> {
  const host = hostname();
  const present = new Set<string>();
  for (const session of state.sessions ?? []) {
    present.add(session.id);
    const before = baseline?.sessions.get(session.id)?.claim;
    const after = session.claim;
    if (sameData(before, after)) continue;
    const mine = (claim: HarnessSession['claim']): boolean => !!claim && claim.pid === process.pid && claim.host === host;
    if (mine(after)) {
      const refreshed = await heartbeatSessionClaim(session.id, { heartbeatAt: after!.heartbeatAt });
      if (!refreshed) await acquireSessionClaim(session.id, { heartbeatAt: after!.heartbeatAt });
    } else if (!after && mine(before)) {
      await releaseSessionClaim(session.id);
    }
  }
  for (const [id, entry] of baseline?.sessions ?? []) {
    if (!present.has(id) && entry.claim?.pid === process.pid && entry.claim.host === host) await releaseSessionClaim(id);
  }
}

/** Applies this process's changes to whatever is on disk now, rather than
 * making the files equal the caller's copy.
 *
 * Callers legitimately hold one state object across a whole turn -- the turn
 * checkpoint rewrites its snapshot every 250ms while a response streams. Each
 * record is diffed against the snapshot the caller last agreed with: untouched
 * records are left alone on disk, a changed transcript rewrites that one
 * session file, and the index is rewritten only if its merged content differs
 * from what is already there. A streamed checkpoint is therefore one small
 * file write regardless of how much history exists. */
export async function writeState(state: HarnessState): Promise<void> {
  const baseline = (state as BaselinedState)[STATE_BASELINE];
  const dirty = new Set<string>();
  await withStateLock(async () => {
    // A legacy file that appeared (or was never migrated) is folded in first so
    // this write merges against everything that exists.
    if (await exists(harnessStatePath())) await ensureLayoutLocked();
    const disk = await loadIndex();
    if (disk && disk.version > HARNESS_STATE_VERSION) throw new HarnessStateVersionError(disk.version);

    const next = baseline && disk ? mergedIndex(baseline, state, disk) : indexFromWorking(state, disk);
    next.version = HARNESS_STATE_VERSION;
    capInvocations(next);

    // 1. Transcripts first: a session must never be listed before it is readable.
    const diskSessionIds = new Set((disk?.sessions ?? []).map((session) => session.id));
    for (const session of state.sessions ?? []) {
      const transcript = transcriptOf(session);
      const before = baseline?.sessions.get(session.id);
      let changed: boolean;
      if (before && diskSessionIds.has(session.id)) changed = !sameData(before.transcript, transcript);
      // New here, or removed elsewhere and re-added by this change: compare
      // with what is actually stored so nothing is written needlessly or lost.
      else changed = !sameData(await readSessionTranscript(session.id), transcript);
      if (!changed) continue;
      await writeSessionTranscript(session.id, transcript, { parentSessionId: transcriptParentOf(session) });
      dirty.add(session.id);
    }

    // 2. The index, only when its content really differs.
    if (!disk || !sameData(next, disk)) await storeIndex(next, { backup: true });

    // 3. Deliberate deletions last, children materialized before the parent goes.
    const remaining = new Set(next.sessions.map((session) => session.id));
    for (const id of baseline?.sessions.keys() ?? []) {
      if (!remaining.has(id)) await deleteSessionTranscript(id);
    }

    // 4. Secrets, only when this caller changed them.
    const tokenChanged = baseline ? !sameSecret(state.localApiToken, baseline.localApiToken) : !!state.localApiToken;
    const keyChanged = baseline ? !sameSecret(state.devicePrivateKeyPem, baseline.devicePrivateKeyPem) : !!state.devicePrivateKeyPem;
    if (tokenChanged || keyChanged) {
      const secrets = await readSecretsFile();
      const updated: HarnessSecrets = {
        localApiToken: tokenChanged ? state.localApiToken || undefined : secrets.localApiToken,
        devicePrivateKeyPem: keyChanged ? state.devicePrivateKeyPem || undefined : secrets.devicePrivateKeyPem,
      };
      if (!sameData(secrets, updated)) await writeSecretsFile(updated);
    }
  });
  await applyClaimIntent(state, baseline);
  // Later writes from this same object must diff from what it looks like now,
  // not from the original read.
  rememberBaseline(state, baseline ? { from: baseline, dirty } : undefined);
}
