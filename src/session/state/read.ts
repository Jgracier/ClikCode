/** Assembling one HarnessState from the index, the secrets file and the
 * per-session transcripts. */

import type { HarnessSession, HarnessState } from '../../harness/types.js';
import { cloneData, readSessionTranscript, sameData, withStateLock } from '../store.js';
import { readSessionClaims, type SessionClaim } from '../claims.js';
import { StateIndex, loadIndex } from './index-file.js';
import { InvocationRollup, STATE_ROLLUPS } from './invocations.js';
import { BaselinedState, STATE_BASELINE, hidden, rememberBaseline } from './merge.js';
import { ensureLayout, ensureLayoutLocked } from './migrate.js';
import { HARNESS_STATE_VERSION } from './paths.js';
import { HarnessSecrets, readLocalApiToken, readSecretsFile } from './secrets.js';
import { HARNESS_DEFAULT_SETTINGS, normalizedConversation, normalizedPermissionMode, normalizedSessionPermission } from './settings.js';
import { writeState } from './write.js';

function sessionClaimView(claim: SessionClaim): NonNullable<HarnessSession['claim']> {
  return { pid: claim.pid, host: claim.host, startedAt: claim.startedAt, heartbeatAt: claim.heartbeatAt };
}

async function assembleState(index: StateIndex, secrets: HarnessSecrets): Promise<HarnessState> {
  const claims = await readSessionClaims();
  const sessions = await Promise.all(index.sessions.map(async (meta): Promise<HarnessSession> => {
    const transcript = await readSessionTranscript(meta.id);
    const claim = claims.get(meta.id);
    return {
      ...cloneData(meta as HarnessSession),
      ...transcript,
      ...(claim ? { claim: sessionClaimView(claim) } : {}),
    };
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
  const sessions: HarnessSession[] = raw.sessions.map((session) => ({
    ...session,
    ...normalizedConversation(session),
    accountFailover: (session.accountFailover === 'never' ? 'never' : 'on-quota-exhausted') as HarnessSession['accountFailover'],
    // Sessions created before lifecycle state existed were still open at the
    // time of upgrade, so preserve their resumability once.
    status: session.status === 'closed' || session.status === 'archived' ? session.status : 'active',
    ...normalizedSessionPermission(session),
  }));
  // Older builds invented a 60-second quota reset. A real limit remains
  // exhausted until the user explicitly retries that account or the provider
  // publishes a trustworthy reset signal.
  const accounts = raw.accounts.map(({ quotaRetryAt: _obsoleteRetryAt, ...account }) => account);
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

export async function readState(): Promise<HarnessState> {
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
  const raw = await assembleState(index, secrets);
  rememberBaseline(raw);
  const normalized = normalizedState(raw);
  hidden(normalized, STATE_BASELINE, (raw as BaselinedState)[STATE_BASELINE]);
  // A newer layout is shown as faithfully as possible and never written to.
  if (index.version > HARNESS_STATE_VERSION) return normalized;
  if (!sameData(normalized, raw)) await writeState(normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
