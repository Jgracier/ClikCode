/** Three-way merge. A write reconciles the baseline read at load time, the
 * working copy in memory, and whatever is on disk now, so two ClikCode
 * processes editing different sessions do not clobber each other. */

import { randomUUID } from 'node:crypto';
import type { AiHarnessAccount, HarnessDefaultSettings, HarnessSession, HarnessState } from '../../harness/types.js';
import { cloneData, sameData } from '../store/data.js';
import { transcriptOf, type SessionTranscript } from '../store/transcripts.js';
import { StateIndex } from './index-file.js';
import { Invocation, invocationRollups } from './invocations.js';
import { HARNESS_STATE_VERSION } from './paths.js';

export type SessionMeta = Omit<HarnessSession, 'messages' | 'pendingTurn' | 'claim'>;

type Identified = { id: string };

/** Three-way merge of one record's fields: a field this process changed wins,
 * every other field comes from disk. Merging whole records let one stale field
 * in a long-lived snapshot revert another terminal's update to the same record. */
function mergeFields<T extends object>(baseline: T | undefined, working: T, disk: T | undefined): T {
  if (!disk) return working;
  const before = (baseline ?? {}) as Record<string, unknown>;
  const after = (working ?? {}) as Record<string, unknown>;
  const result = { ...(disk as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameData(before[key], after[key])) continue;
    if (after[key] === undefined) delete result[key];
    else result[key] = after[key];
  }
  return result as T;
}

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
  return merged;
}

/** Entity-level three-way merge. Records this process did not touch are taken
 * from disk, so a stale snapshot can never erase another terminal's work.
 * Removing a record is still expressed: present in the baseline and absent
 * from the working copy means a deliberate delete. */
function mergeById<T extends Identified>(
  baseline: readonly T[], working: readonly T[], disk: readonly T[],
  mergeRecordFields: (baseline: T | undefined, working: T, disk: T | undefined) => T = (_before, after) => after,
): T[] {
  const before = new Map(baseline.map((item) => [item.id, item]));
  const workingIds = new Set(working.map((item) => item.id));
  const merged = new Map(disk.map((item) => [item.id, item]));
  for (const id of before.keys()) if (!workingIds.has(id)) merged.delete(id);
  for (const item of working) {
    const previous = before.get(item.id);
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

interface BaselineSession { meta: SessionMeta; transcript: SessionTranscript; claim?: HarnessSession['claim'] }

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
}

/** The snapshot a state object was last known to agree with on disk. Writes
 * diff against it so a process only ever persists what it actually changed. */
export const STATE_BASELINE = Symbol('clikcode.stateBaseline');

export type BaselinedState = HarnessState & { [STATE_BASELINE]?: StateBaselineData };

export function hidden<T extends object>(target: T, key: PropertyKey, value: unknown): T {
  // Non-enumerable so it never reaches JSON.stringify, spreads, equality
  // checks, or any panel that prints state.
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  return target;
}

/** `reuse` carries over entries for sessions known to be unchanged, so the
 * per-checkpoint cost follows what changed rather than total history. */
export function rememberBaseline(state: HarnessState, reuse?: { from: StateBaselineData; dirty: ReadonlySet<string> }): HarnessState {
  const sessions = new Map<string, BaselineSession>();
  for (const session of state.sessions ?? []) {
    const kept = reuse && !reuse.dirty.has(session.id) ? reuse.from.sessions.get(session.id) : undefined;
    const { meta, transcript, claim } = splitSession(session);
    sessions.set(session.id, {
      meta: cloneData(meta),
      transcript: kept ? kept.transcript : cloneData(transcript),
      ...(claim ? { claim: cloneData(claim) } : {}),
    });
  }
  const baseline: StateBaselineData = {
    installationId: state.installationId,
    devicePublicKey: cloneData(state.devicePublicKey),
    localApiToken: state.localApiToken,
    devicePrivateKeyPem: state.devicePrivateKeyPem,
    accounts: cloneData(state.accounts ?? []),
    invocations: cloneData(state.invocations ?? []),
    globalSettings: cloneData(state.globalSettings),
    providerSettings: cloneData(state.providerSettings),
    sessions,
  };
  return hidden(state, STATE_BASELINE, baseline);
}

// ---------------------------------------------------------------------------
// Migration ladder
// ---------------------------------------------------------------------------

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

export function mergedIndex(baseline: StateBaselineData, state: HarnessState, disk: StateIndex): StateIndex {
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
    ),
    invocations: mergeById(baseline.invocations, state.invocations ?? [], disk.invocations ?? []),
    globalSettings: mergeRecord(baseline.globalSettings, state.globalSettings, disk.globalSettings),
    providerSettings: mergeRecord(baseline.providerSettings, state.providerSettings, disk.providerSettings),
  };
}
