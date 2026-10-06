/** Three-way merge. A write reconciles the baseline read at load time, the
 * working copy in memory, and whatever is on disk now, so two ClikCode
 * processes editing different sessions do not clobber each other. */

import { randomUUID } from 'node:crypto';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessDefaultSettings, HarnessSession, HarnessState } from '../model.js';
import { cloneData, hidden, mergeFields, sameData } from '../store/data.js';
import { mergeLearning } from '../../harness/accounts/usage-learning.js';
import { transcriptOf, type SessionTranscript } from '../store/transcripts.js';
import type { StateIndex } from './index-file.js';
import type { Invocation } from './invocations.js';
import { HARNESS_STATE_VERSION } from './paths.js';

export type SessionMeta = Omit<HarnessSession, 'messages' | 'pendingTurn' | 'claim'>;

type Identified = { id: string };

function mergeAccount(baseline: AiHarnessAccount | undefined, working: AiHarnessAccount, disk: AiHarnessAccount | undefined): AiHarnessAccount {
  const merged = mergeFields(baseline, working, disk);
  if (!disk) return merged;
  // The profile is several independent facts (path, env, extraEnv), not one.
  if (working.nativeProfile && disk.nativeProfile) {
    merged.nativeProfile = mergeFields(baseline?.nativeProfile, working.nativeProfile, disk.nativeProfile);
  }
  // A usage reading is a timestamped observation: the newest one is the truth
  // no matter which terminal happened to write last.
  if (working.usage && disk.usage) {
    merged.usage = (Date.parse(working.usage.at) || 0) >= (Date.parse(disk.usage.at) || 0) ? working.usage : disk.usage;
  }
  // Learned usage is observations, not a value: both sides' are kept.
  if (working.usageLearning && disk.usageLearning && !sameData(working.usageLearning, disk.usageLearning)) {
    merged.usageLearning = mergeLearning(working.usageLearning, disk.usageLearning);
  }
  return merged;
}

/** Entity-level three-way merge. Records this process did not touch are taken
 * from disk, so a stale snapshot can never erase another terminal's work.
 * Removing a record is still expressed: present in the baseline and absent
 * from the working copy means a deliberate delete -- and present in the
 * baseline but absent from disk means someone else deleted it, which stands. */
function mergeById<T extends Identified>(
  baseline: readonly T[], working: readonly T[], disk: readonly T[],
  mergeRecordFields: (baseline: T | undefined, working: T, disk: T | undefined) => T = (_before, after) => after,
  /** Records this writer read as drafts (not on disk then). One that is on
   * disk now was stored by someone else meanwhile: it merges against the
   * draft as read, like any record, instead of replacing what was stored. */
  drafts?: ReadonlyMap<string, T>,
): T[] {
  const before = new Map(baseline.map((item) => [item.id, item]));
  const workingIds = new Set(working.map((item) => item.id));
  const merged = new Map(disk.map((item) => [item.id, item]));
  for (const id of before.keys()) if (!workingIds.has(id)) merged.delete(id);
  for (const item of working) {
    // Present in the baseline and gone from disk: deleted elsewhere. A stale
    // copy changing a field of it must not bring it back.
    if (before.has(item.id) && !merged.has(item.id)) continue;
    const previous = before.get(item.id) ?? (merged.has(item.id) ? drafts?.get(item.id) : undefined);
    if (previous === undefined) merged.set(item.id, item);
    else if (!sameData(previous, item)) merged.set(item.id, mergeRecordFields(previous, item, merged.get(item.id)));
  }
  return [...merged.values()];
}

/** Same rule, per key, for the settings maps. */
function mergeRecord<T extends object>(baseline: T, working: T, disk: T): T {
  return mergeFields(baseline ?? ({} as T), working ?? ({} as T), disk ?? ({} as T));
}

export function splitSession(session: HarnessSession): { meta: SessionMeta; transcript: SessionTranscript; claim: HarnessSession['claim'] } {
  const { messages: _messages, pendingTurn: _pendingTurn, claim, ...meta } = session;
  return { meta, transcript: transcriptOf(session), claim };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export interface BaselineSession {
  meta: SessionMeta;
  transcript: SessionTranscript;
  claim?: HarnessSession['claim'];
  /** The working array `transcript.messages` was copied from. */
  messagesFrom?: ListSource<NonNullable<HarnessSession['messages']>[number]>;
}

/** Which working list a baseline copy was taken from, and how it looked. */
interface ListSource<T> { list: readonly T[]; length: number; last: T | undefined }

/** A deep copy of `working` for a baseline, reusing `kept` when nothing in
 * it can have changed: the same array, as long as it was, ending in the same
 * element with the same contents. That takes the cost of an unchanged list
 * from its whole length to its last entry -- a conversation's history, or
 * the invocation log, on every 250 ms checkpoint of a streaming turn. Lists
 * here only ever grow or are replaced: nothing rewrites an entry in the
 * middle of one in place. Any other change falls back to comparing the whole
 * list, and a copy only when it really differs. */
function baselineList<T>(
  working: readonly T[] | undefined, kept: readonly T[] | undefined, from: ListSource<T> | undefined,
): { copy: T[] | undefined; from: ListSource<T> | undefined } {
  if (!working) return { copy: undefined, from: undefined };
  const source = { list: working, length: working.length, last: working[working.length - 1] };
  const unchanged = kept !== undefined && (
    (from?.list === working && from.length === working.length && from.last === source.last
      && sameData(kept[kept.length - 1], source.last))
    || sameData(kept, working));
  return { copy: unchanged ? kept as T[] : cloneData(working as T[]), from: source };
}

export interface StateBaselineData {
  installationId: string;
  devicePublicKey?: Record<string, unknown>;
  localApiToken?: string;
  devicePrivateKeyPem?: string;
  accounts: AiHarnessAccount[];
  invocations: Invocation[];
  globalSettings: HarnessDefaultSettings;
  providerSettings: HarnessState['providerSettings'];
  sessions: Map<string, BaselineSession>;
  /** The working array `invocations` was copied from (baselineList). */
  invocationsFrom?: ListSource<Invocation>;
}

/** The snapshot a state object was last known to agree with on disk. Writes
 * diff against it so a process only ever persists what it actually changed. */
export const STATE_BASELINE = Symbol('clikcode.stateBaseline');
/** The drafts a read added (withDrafts), each as it was then. Not part of the
 * baseline -- a draft was never on disk, so dropping one is not a delete --
 * but the baseline its record merges against if it is stored meanwhile. */
export const DRAFT_BASELINE = Symbol('clikcode.draftBaseline');

export type BaselinedState = HarnessState & { [STATE_BASELINE]?: StateBaselineData; [DRAFT_BASELINE]?: Map<string, BaselineSession> };

/** One session as it is at this instant, sharing whatever `kept` already
 * holds unchanged (see baselineOf). */
export function baselineSession(session: HarnessSession, kept: BaselineSession | undefined): BaselineSession {
  const { meta, claim } = splitSession(session);
  // Messages left unset were not opened. That is not an empty transcript:
  // reuse the one this baseline already holds so a later write cannot
  // replace the file with nothing. A transcript that was opened and cleared
  // has `messages: []`, which still takes the path below.
  if (session.messages === undefined && session.pendingTurn === undefined && kept) {
    return {
      meta: cloneData(meta),
      transcript: kept.transcript,
      ...(claim ? { claim: cloneData(claim) } : {}),
      ...(kept.messagesFrom ? { messagesFrom: kept.messagesFrom } : {}),
    };
  }
  const messages = baselineList(session.messages, kept?.transcript.messages, kept?.messagesFrom);
  const pendingTurn = kept && sameData(kept.transcript.pendingTurn, session.pendingTurn) ? kept.transcript.pendingTurn : cloneData(session.pendingTurn);
  const transcript: SessionTranscript = kept && messages.copy === kept.transcript.messages && pendingTurn === kept.transcript.pendingTurn
    ? kept.transcript
    : { ...(messages.copy !== undefined ? { messages: messages.copy } : {}), ...(pendingTurn !== undefined ? { pendingTurn } : {}) };
  return {
    meta: cloneData(meta),
    transcript,
    ...(claim ? { claim: cloneData(claim) } : {}),
    ...(messages.from ? { messagesFrom: messages.from } : {}),
  };
}

/** `state` exactly as it is at this instant. Whatever `previous` already
 * holds unchanged is shared with it rather than copied: history that did not
 * change is neither compared in full nor copied again, so a checkpoint's cost
 * follows what changed (the pending turn) rather than total history -- and
 * an unchanged transcript, or its unchanged history, is recognisable by
 * identity (see writeState and writeSessionTranscript). */
export function baselineOf(state: HarnessState, previous?: StateBaselineData): StateBaselineData {
  const sessions = new Map<string, BaselineSession>();
  for (const session of state.sessions ?? []) sessions.set(session.id, baselineSession(session, previous?.sessions.get(session.id)));
  const invocations = baselineList(state.invocations ?? [], previous?.invocations, previous?.invocationsFrom);
  return {
    installationId: state.installationId,
    devicePublicKey: cloneData(state.devicePublicKey),
    localApiToken: state.localApiToken,
    devicePrivateKeyPem: state.devicePrivateKeyPem,
    accounts: cloneData(state.accounts ?? []),
    invocations: invocations.copy ?? [],
    globalSettings: cloneData(state.globalSettings),
    providerSettings: cloneData(state.providerSettings),
    sessions,
    ...(invocations.from ? { invocationsFrom: invocations.from } : {}),
  };
}

export function rememberBaseline(state: HarnessState, baseline: StateBaselineData = baselineOf(state)): HarnessState {
  return hidden(state, STATE_BASELINE, baseline);
}

export function indexFromWorking(state: HarnessState, disk: StateIndex | undefined): StateIndex {
  return {
    version: HARNESS_STATE_VERSION,
    installationId: state.installationId || disk?.installationId || randomUUID(),
    ...(state.devicePublicKey && Object.keys(state.devicePublicKey).length ? { devicePublicKey: state.devicePublicKey } : {}),
    accounts: state.accounts ?? [],
    sessions: (state.sessions ?? []).map((session) => splitSession(session).meta),
    invocations: state.invocations ?? [],
    // Rollups are derived on disk under the lock and never come from a snapshot.
    invocationRollups: disk?.invocationRollups ?? {},
    ...(disk?.rolledThrough ? { rolledThrough: disk.rolledThrough } : {}),
    globalSettings: state.globalSettings,
    providerSettings: state.providerSettings ?? {},
  };
}

export function mergedIndex(baseline: StateBaselineData, state: HarnessState, disk: StateIndex, drafts?: ReadonlyMap<string, BaselineSession>): StateIndex {
  const changed = <T>(before: T, after: T, onDisk: T): T => (!sameData(before, after) ? after : onDisk);
  const devicePublicKey = changed(baseline.devicePublicKey, state.devicePublicKey, disk.devicePublicKey);
  const { devicePublicKey: _previousKey, ...rest } = disk;
  return {
    ...rest,
    // Never stamp this writer's version over what is on disk.
    version: disk.version,
    installationId: disk.installationId || state.installationId,
    ...(devicePublicKey && Object.keys(devicePublicKey).length ? { devicePublicKey } : {}),
    accounts: mergeById(baseline.accounts, state.accounts ?? [], disk.accounts ?? [], mergeAccount),
    sessions: mergeById(
      [...baseline.sessions.values()].map((entry) => entry.meta),
      (state.sessions ?? []).map((session) => splitSession(session).meta),
      disk.sessions ?? [], mergeFields,
      drafts && new Map([...drafts].map(([id, entry]) => [id, entry.meta])),
    ),
    invocations: mergeById(baseline.invocations, state.invocations ?? [], disk.invocations ?? []),
    globalSettings: mergeRecord(baseline.globalSettings, state.globalSettings, disk.globalSettings),
    providerSettings: mergeRecord(baseline.providerSettings, state.providerSettings, disk.providerSettings),
  };
}
