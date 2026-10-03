/** Assembling one HarnessState from the index, the secrets file and the
 * per-session transcripts. */

import { normalizeLearning } from '../../harness/accounts/usage-learning.js';
import type { HarnessSession, HarnessState } from '../model.js';
import { ephemeralSessions } from '../ephemeral.js';
import { markFromIndex, markTranscriptLoaded, sessionFromIndex, transcriptWasLoaded } from '../list-facts.js';
import { cloneData, sameData } from '../store/data.js';
import { withStateLock } from '../store/locks.js';
import { readSessionTranscript } from '../store/transcripts.js';
import { readSessionClaims, type SessionClaim } from '../claims.js';
import { StateIndex, loadIndex } from './index-file.js';
import { InvocationRollup, STATE_ROLLUPS } from './invocations.js';
import { BaselinedState, DRAFT_BASELINE, STATE_BASELINE, baselineOf, rememberBaseline } from './merge.js';
import { hidden } from '../store/data.js';
import { ensureLayout, ensureLayoutLocked } from './migrate.js';
import { HARNESS_STATE_VERSION } from './paths.js';
import { HarnessSecrets, readLocalApiToken, readSecretsFile } from './secrets.js';
import { HARNESS_DEFAULT_SETTINGS, normalizedConversation, normalizedPermissionMode, normalizedSessionPermission } from './settings.js';
import { writeState } from './write.js';

function sessionClaimView(claim: SessionClaim): NonNullable<HarnessSession['claim']> {
  return { pid: claim.pid, host: claim.host, startedAt: claim.startedAt, heartbeatAt: claim.heartbeatAt };
}

async function assembleState(index: StateIndex, secrets: HarnessSecrets, transcripts: 'all' | ReadonlySet<string>): Promise<HarnessState> {
  const claims = await readSessionClaims();
  const sessions = await Promise.all(index.sessions.map(async (meta): Promise<HarnessSession> => {
    const load = transcripts === 'all' || transcripts.has(meta.id);
    const transcript = load ? await readSessionTranscript(meta.id) : undefined;
    const claim = claims.get(meta.id);
    const session: HarnessSession = {
      ...cloneData(meta as HarnessSession),
      ...(transcript ?? {}),
      ...(claim ? { claim: sessionClaimView(claim) } : {}),
    };
    // After the object exists: a spread would drop these, and a later write
    // tells "not opened" from "opened and empty" by them.
    markFromIndex(session);
    if (load) markTranscriptLoaded(session);
    return session;
  }));
  const state = {
    version: index.version,
    installationId: index.installationId,
    devicePublicKey: cloneData(index.devicePublicKey ?? {}),
    accounts: cloneData(index.accounts),
    sessions,
    invocations: cloneData(index.invocations),
    globalSettings: cloneData(index.globalSettings),
    providerSettings: cloneData(index.providerSettings ?? {}),
  } as HarnessState;
  return attachHidden(state, secrets, index.invocationRollups);
}

function attachHidden(state: HarnessState, secrets: HarnessSecrets, rollups: Record<string, InvocationRollup>): HarnessState {
  // Secrets are reachable as properties for the code that needs them, but are
  // not enumerable: they never appear in a serialized or printed state.
  hidden(state, 'localApiToken', secrets.localApiToken ?? '');
  hidden(state, 'devicePrivateKeyPem', secrets.devicePrivateKeyPem ?? '');
  hidden(state, STATE_ROLLUPS, rollups);
  return state;
}

function normalizedState(raw: HarnessState): HarnessState {
  // Older previews did not include a failover preference. Migrate those
  // sessions to the safe default so a local account does not remain stuck
  // after its known quota window is exhausted.
  const sessions: HarnessSession[] = raw.sessions.map((session) => {
    const next: HarnessSession = {
      ...session,
      ...normalizedConversation(session),
      accountFailover: (session.accountFailover === 'never' ? 'never' : 'on-quota-exhausted') as HarnessSession['accountFailover'],
      // Sessions created before lifecycle state existed were still open at the
      // time of upgrade, so preserve their resumability once.
      status: session.status === 'closed' || session.status === 'archived' ? session.status : 'active',
      ...normalizedSessionPermission(session),
    };
    // The spread above is a new object, so the marks have to be put back.
    if (sessionFromIndex(session)) markFromIndex(next);
    if (transcriptWasLoaded(session)) markTranscriptLoaded(next);
    return next;
  });
  // `quotaRetryAt` is kept: it is when a quota refusal stops holding (the
  // vendor's "resets in" hint, else a default window -- see
  // quotaMarkExpiresAt). The 60-second value older builds wrote is long past,
  // which only means that account is tried again and re-marked if it refuses.
  // A usage reading older builds stored as an estimate (`learned`) is not the
  // vendor's and goes; their learning is brought to the current shape.
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((account) => {
    const usage = (account.usage as { learned?: boolean } | undefined)?.learned ? undefined : account.usage;
    const usageLearning = normalizeLearning(account.usageLearning);
    return { ...account, usage, ...(usageLearning ? { usageLearning } : {}) };
  });
  const normalized = {
    ...raw, accounts, sessions, invocations: Array.isArray(raw.invocations) ? raw.invocations : [],
    globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...raw.globalSettings, permissionMode: normalizedPermissionMode(raw.globalSettings?.permissionMode) },
    providerSettings: Object.fromEntries(Object.entries(raw.providerSettings && typeof raw.providerSettings === 'object' ? raw.providerSettings : {}).map(([provider, settings]) => [
      provider,
      { ...settings, ...(settings.permissionMode ? { permissionMode: normalizedPermissionMode(settings.permissionMode) } : {}) },
    ])),
  } as HarnessState;
  return attachHidden(normalized, { localApiToken: raw.localApiToken, devicePrivateKeyPem: raw.devicePrivateKeyPem },
    (raw as HarnessState & { [STATE_ROLLUPS]?: Record<string, InvocationRollup> })[STATE_ROLLUPS] ?? {});
}

export interface ReadStateOptions {
  /** Which transcripts to open. The default is every one, which is what a
   * turn needs. An empty list reads the index only: titles, previews, dates. */
  transcripts?: 'all' | readonly string[];
}

export async function readState(options?: ReadStateOptions): Promise<HarnessState> {
  const transcripts = options?.transcripts ?? 'all';
  const wanted = transcripts === 'all' ? 'all' as const : new Set(transcripts);
  await ensureLayout();
  let index = await loadIndex();
  if (!index) {
    // Removed between the check and the read (tests, manual cleanup).
    await withStateLock(() => ensureLayoutLocked());
    index = await loadIndex();
    if (!index) throw new Error('local AI harness state could not be created');
  }
  let secrets = await readSecretsFile();
  // The loopback bearer must survive the first process exit; otherwise a
  // runtime registration would be valid only for the process that created it.
  if (!secrets.localApiToken && index.version <= HARNESS_STATE_VERSION) {
    await readLocalApiToken();
    secrets = await readSecretsFile();
  }
  const raw = await assembleState(index, secrets, wanted);
  rememberBaseline(raw);
  const normalized = normalizedState(raw);
  hidden(normalized, STATE_BASELINE, (raw as BaselinedState)[STATE_BASELINE]);
  // A newer layout is shown as faithfully as possible and never written to.
  if (index.version > HARNESS_STATE_VERSION) return withDrafts(normalized);
  if (!sameData(normalized, raw)) await writeState(normalized);
  return withDrafts(normalized);
}

/** Drafts this process has not stored yet. They are not part of the baseline:
 * a later write must not treat them as records that were on disk. */
function withDrafts(state: HarnessState): HarnessState {
  const added: HarnessSession[] = [];
  for (const session of ephemeralSessions()) {
    if (!state.sessions.some((item) => item.id === session.id)) { state.sessions.push(session); added.push(session); }
  }
  // Each as read: should another process store the draft before this copy is
  // written back, the write merges against this, not over the stored record.
  if (added.length) hidden(state, DRAFT_BASELINE, baselineOf({ ...state, sessions: added }).sessions);
  return state;
}
