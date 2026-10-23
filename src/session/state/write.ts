/** Writing a HarnessState back. */

import type { HarnessState } from '../model.js';
import { draftPinned, dropEphemeral, ephemeralSessions, holdEphemeral, sessionForceStored } from '../ephemeral.js';
import { stampListFacts } from '../list-facts.js';
import { isBlankConversation } from '../options.js';
import { sameData } from '../store/data.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { withStateLock } from '../store/locks.js';
import { forgetSessionArtifacts } from '../store/forget.js';
import { deleteSessionTranscript, readSessionTranscript, writeOwnTranscript, writeSessionTranscript } from '../store/transcripts.js';
import { HarnessStateVersionError, indexStructureChanged, loadIndex, storeIndex, type StateIndex } from './index-file.js';
import { capInvocations } from './invocations.js';
import { BaselinedState, DRAFT_BASELINE, STATE_BASELINE, StateBaselineData, baselineOf, baselineSession, indexFromWorking, mergedIndex, rememberBaseline } from './merge.js';
import { HARNESS_STATE_VERSION } from './paths.js';
import { HarnessSecrets, readSecretsFile, sameSecret, writeSecretsFile } from './secrets.js';

/** Applies this process's changes to whatever is on disk now, rather than
 * making the files equal the caller's copy.
 *
 * Callers legitimately hold one state object across a whole turn. Each
 * record is diffed against the snapshot the caller last agreed with:
 * untouched records are left alone on disk, a changed transcript appends to
 * that one conversation's log, and the index is rewritten only if its merged
 * content differs from what is already there. A streaming turn's 250ms
 * checkpoints do not come here at all: they use writeTranscriptCheckpoint,
 * which never touches the index. */
export async function writeState(state: HarnessState): Promise<void> {
  // Transcripts of chats this copy read from disk are written first, each under its own
  // conversation's lock only (writeTranscriptCheckpoint): every other window goes on meanwhile.
  // What is left for the state lock is the index, and the transcripts of chats not listed yet.
  const ownable = new Set<string>();
  if ((state as BaselinedState)[STATE_BASELINE]) {
    for (const session of state.sessions ?? []) {
      if (session.messages === undefined && session.pendingTurn === undefined) continue;
      if (await writeTranscriptCheckpoint(state, session.id, { journalOnly: false })) ownable.add(session.id);
    }
  }
  const baseline = (state as BaselinedState)[STATE_BASELINE];
  let written: StateBaselineData | undefined;
  const deleted: string[] = [];
  const deferred: string[] = [];
  await withStateLock(async (held) => {
    // Where a slow write spends its time (state.write.slow): every window waits while it holds the lock.
    const clock = { start: Date.now(), index: 0, snapshot: 0, transcripts: 0, store: 0, wrote: 0, loaded: 0 };
    const disk = await loadIndex();
    if (disk && disk.version > HARNESS_STATE_VERSION) throw new HarnessStateVersionError(disk.version);
    clock.index = Date.now() - clock.start;

    // What this write stores is taken here, in one synchronous step, and is
    // exactly what it then remembers as stored. The caller may keep changing
    // `state` while the files below are written -- a turn checkpoint does: a
    // message queued mid-write. Remembering the object as it was at the END
    // recorded that change as already on disk, so the write made for it
    // found nothing to store, and the queued message was lost.
    // Summarize onto the index before the snapshot, and only for a transcript
    // this caller actually opened. A light read leaves the summary alone.
    for (const session of state.sessions ?? []) stampListFacts(session);
    const taken = baselineOf(state, baseline);
    clock.snapshot = Date.now() - clock.start - clock.index;
    const sessions = [...(state.sessions ?? [])];
    const diskIds = new Set((disk?.sessions ?? []).map((session) => session.id));
    // A draft is not a conversation. It stays off disk until it is used, or
    // until a worker in another process has to read it (force). One already
    // on disk stays until this process drops it from its working copy, which
    // is how an empty chat an older build stored gets removed.
    const writing = new Set(sessions.map((session) => session.id));
    for (const session of ephemeralSessions()) {
      if (!writing.has(session.id) && !draftPinned(session.id)) dropEphemeral(session.id);
    }
    for (const session of sessions) {
      if (isBlankConversation(session) && !diskIds.has(session.id) && !sessionForceStored(session.id)) holdEphemeral(session);
      else dropEphemeral(session.id);
    }
    const persisted = sessions.filter((session) => !isBlankConversation(session) || diskIds.has(session.id) || sessionForceStored(session.id));
    const persistedState = { ...state, sessions: persisted };
    const drafts = (state as BaselinedState)[DRAFT_BASELINE];
    const next = baseline && disk ? mergedIndex(baseline, persistedState, disk, drafts) : indexFromWorking(persistedState, disk);
    next.version = HARNESS_STATE_VERSION;
    capInvocations(next);

    // 1. Transcripts first: a session must never be listed before it is readable.
    for (const session of persisted) {
      const transcript = taken.sessions.get(session.id)!.transcript;
      const before = baseline?.sessions.get(session.id);
      // Stored when this copy read it and gone now: deleted elsewhere. The
      // index merge drops it (mergeById); its transcript stays gone too.
      if (before && disk && !diskIds.has(session.id)) continue;
      const draft = diskIds.has(session.id) ? drafts?.get(session.id) : undefined;
      let changed: boolean;
      // baselineOf shares an unchanged transcript with the baseline.
      if (before && diskIds.has(session.id)) changed = before.transcript !== transcript;
      // A draft stored elsewhere since this copy read it: only a transcript
      // this process changed is its to write; the stored one is newer.
      else if (draft) changed = !sameData(draft.transcript, transcript);
      // New here: compare with what is actually stored so nothing is
      // written needlessly or lost.
      else changed = !sameData(await readSessionTranscript(session.id), transcript);
      if (!changed) continue;
      // This conversation's file was just written on its own lock, and the turn
      // kept changing it. Another copy does not belong under the state lock.
      // The baseline stays on what is already stored; the rest is written after
      // this lock, on the conversation's lock again. Remembering `transcript`
      // here would record that later change as stored, and the write made for
      // it would find nothing to store.
      if (ownable.has(session.id) && before) {
        const entry = taken.sessions.get(session.id);
        if (entry) {
          const { messagesFrom: _from, ...rest } = entry;
          taken.sessions.set(session.id, { ...rest, transcript: before.transcript, ...(before.messagesFrom ? { messagesFrom: before.messagesFrom } : {}) });
        }
        deferred.push(session.id);
        continue;
      }
      // Merged with what another process stored since this copy agreed with
      // disk, so neither side's appended messages are lost. This is a transcript
      // the conversation lock cannot store alone (a shared history, a parent
      // reference, an empty delete, a session not stored yet).
      const base = before && diskIds.has(session.id) ? before.transcript : draft?.transcript;
      await writeSessionTranscript(held, session.id, transcript, base ? { base } : {});
      clock.wrote += 1;
    }
    clock.transcripts = Date.now() - clock.start - clock.index - clock.snapshot;
    clock.loaded = persisted.filter((session) => session.messages !== undefined).length;

    // 2. The index, only when its content really differs. A change that is only
    // when a chat was touched, or the usage it last reported, is not fsynced:
    // those two fields were most of state.write.slow, and losing the last one
    // costs a sort order, not the conversation.
    const cache = Boolean(disk && indexWriteIsCache(disk, next));
    if (!disk || !sameData(next, disk)) await storeIndex(next, { backup: indexStructureChanged(disk, next), durable: !cache });
    clock.store = Date.now() - clock.start - clock.index - clock.snapshot - clock.transcripts;
    const total = Date.now() - clock.start;
    if (total >= 300) lifecycle('state.write.slow', { ms: total, indexMs: clock.index, snapshotMs: clock.snapshot, transcriptsMs: clock.transcripts, storeMs: clock.store, wrote: clock.wrote, loaded: clock.loaded, sessions: persisted.length, ...(clock.store > 100 && disk ? { changed: indexChanges(disk, next) } : {}) });

    // 3. Deliberate deletions last, children materialized before the parent goes.
    const remaining = new Set(next.sessions.map((session) => session.id));
    for (const id of baseline?.sessions.keys() ?? []) {
      if (remaining.has(id)) continue;
      await deleteSessionTranscript(held, id);
      deleted.push(id);
    }

    // 4. Secrets, only when this caller changed them.
    const tokenChanged = baseline ? !sameSecret(taken.localApiToken, baseline.localApiToken) : !!taken.localApiToken;
    const keyChanged = baseline ? !sameSecret(taken.devicePrivateKeyPem, baseline.devicePrivateKeyPem) : !!taken.devicePrivateKeyPem;
    if (tokenChanged || keyChanged) {
      const secrets = await readSecretsFile();
      const updated: HarnessSecrets = {
        localApiToken: tokenChanged ? taken.localApiToken || undefined : secrets.localApiToken,
        devicePrivateKeyPem: keyChanged ? taken.devicePrivateKeyPem || undefined : secrets.devicePrivateKeyPem,
      };
      if (!sameData(secrets, updated)) await writeSecretsFile(updated);
    }
    const kept = new Set(persisted.map((session) => session.id));
    for (const id of [...taken.sessions.keys()]) if (!kept.has(id)) taken.sessions.delete(id);
    written = taken;
  });
  // Later writes from this same object diff from what this one stored, not
  // from the original read -- nor from the object as it looks now. Before the
  // deferred transcripts: those move the baseline forward only as far as they
  // actually write.
  rememberBaseline(state, written);
  for (const id of deferred) await writeDeferredTranscript(state, id);
  // What else the deleted chats left (agent history, checkpoints):
  // outside the lock, since a checkpoint directory can be large.
  for (const id of deleted) await forgetSessionArtifacts(id);
}

/** A transcript the state lock left behind because this conversation can store
 * it itself. The conversation lock first; the state lock only if that refuses
 * (shared history, a parent reference, an empty file). The snapshot is taken
 * before the write, and only that snapshot is remembered as stored. */
async function writeDeferredTranscript(state: HarnessState, sessionId: string): Promise<void> {
  if (await writeTranscriptCheckpoint(state, sessionId, { journalOnly: true })) return;
  const session = state.sessions?.find((item) => item.id === sessionId);
  const baseline = (state as BaselinedState)[STATE_BASELINE];
  const before = baseline?.sessions.get(sessionId);
  if (!session || !baseline || !before) return;
  const now = baselineSession(session, before);
  if (now.transcript === before.transcript) return;
  await withStateLock(async (held) => {
    await writeSessionTranscript(held, sessionId, now.transcript, { base: before.transcript });
  });
  const current = (state as BaselinedState)[STATE_BASELINE];
  const entry = current?.sessions.get(sessionId);
  // A full write may have replaced the baseline while this one waited.
  if (entry && current === baseline) {
    const { messagesFrom: _from, ...rest } = entry;
    current.sessions.set(sessionId, { ...rest, transcript: now.transcript, ...(now.messagesFrom ? { messagesFrom: now.messagesFrom } : {}) });
  }
}

/** A streaming turn's checkpoint: one session's transcript, and nothing else.
 *
 * The index is the list -- titles, dates, accounts -- shared by every
 * process, and nothing on it changes while an answer streams. Rewriting it
 * (with a backup) four times a second per worker was most of what ClikCode
 * wrote to disk. Here only the transcript is stored -- and when only the
 * running turn's journal changed, just that journal (store/transcripts.ts
 * says what builds that predate the message log see) -- and only the
 * transcript part of the baseline moves forward: any field of the record the
 * turn changed meanwhile (its date, its last usage) is still a difference the
 * next full writeState stores, at the turn's end at the latest.
 *
 * Returns false, having written nothing, when this is not a plain transcript
 * update -- the session is not stored (yet, or any more), or this copy never
 * read it. The caller then does a full writeState, which handles those. */
export async function writeTranscriptCheckpoint(state: HarnessState, sessionId: string, options: { journalOnly: boolean } = { journalOnly: true }): Promise<boolean> {
  const baseline = (state as BaselinedState)[STATE_BASELINE];
  const before = baseline?.sessions.get(sessionId);
  const session = state.sessions?.find((item) => item.id === sessionId);
  if (!baseline || !before || !session) return false;
  const now = baselineSession(session, before);
  if (now.transcript !== before.transcript) {
    // Under this conversation's own lock, not the state lock (writeOwnTranscript): only its file changes.
    const listed = async (): Promise<boolean> => {
      const disk = await loadIndex();
      if (disk && disk.version > HARNESS_STATE_VERSION) throw new HarnessStateVersionError(disk.version);
      return Boolean(disk?.sessions.some((item) => item.id === sessionId));
    };
    if (!await writeOwnTranscript(sessionId, now.transcript, before.transcript, listed, options)) return false;
  }
  {
    // The current baseline object: a full write may have replaced it while
    // this one waited for the lock, and that one is what later writes diff from.
    const current = (state as BaselinedState)[STATE_BASELINE]?.sessions;
    const entry = current?.get(sessionId);
    if (entry) {
      const { messagesFrom: _from, ...rest } = entry;
      current!.set(sessionId, { ...rest, transcript: now.transcript, ...(now.messagesFrom ? { messagesFrom: now.messagesFrom } : {}) });
    }
    return true;
  }
}

const CACHE_SESSION_FIELDS = new Set(['updatedAt', 'lastUsage']);

/** True when the only difference is a session's `updatedAt` or `lastUsage`.
 * Anything else — a new chat, a model, a title, an account — is durable. */
export function indexWriteIsCache(disk: StateIndex, next: StateIndex): boolean {
  const keys = new Set<string>([...Object.keys(disk), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'sessions') {
      if (!sessionRowsAreCache(disk.sessions ?? [], next.sessions ?? [])) return false;
      continue;
    }
    if (!sameData((disk as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function sessionRowsAreCache(before: readonly { id: string }[], after: readonly { id: string }[]): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index] as { id: string } & Record<string, unknown>;
    const right = after[index] as { id: string } & Record<string, unknown>;
    if (left.id !== right.id) return false;
    const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const field of fields) {
      if (sameData(left[field], right[field])) continue;
      if (!CACHE_SESSION_FIELDS.has(field)) return false;
    }
  }
  return true;
}

/** What a write changed on the index, by record and field ("accounts:a1b2.status"), for a slow
 * write's log line: the index is rewritten whole, and this says why it was. */
function indexChanges(disk: StateIndex, next: StateIndex): string[] {
  const out: string[] = [];
  for (const key of Object.keys(next) as Array<keyof StateIndex>) {
    if (key === 'accounts' || key === 'sessions') {
      const before = new Map((disk[key] as Array<{ id: string }> ?? []).map((item) => [item.id, item]));
      for (const item of next[key] as Array<{ id: string } & Record<string, unknown>>) {
        const old = before.get(item.id) as Record<string, unknown> | undefined;
        if (!old) { out.push(`${key}:${item.id.slice(0, 8)}+`); continue; }
        for (const field of Object.keys(item)) if (!sameData(old[field], item[field])) out.push(`${key}:${item.id.slice(0, 8)}.${field}`);
      }
    } else if (!sameData(disk[key], next[key])) out.push(String(key));
  }
  return out.slice(0, 12);
}
