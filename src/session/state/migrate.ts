/** Getting from an older layout to the current one: the single-file v1 state,
 * and creating the split layout from nothing. */

import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessSession, HarnessState } from '../model.js';
import { cloneData, sameData } from '../store/data.js';
import { withStateLock } from '../store/locks.js';
import { stateDirectory } from '../store/paths.js';
import { readSessionTranscript, writeSessionTranscript } from '../store/transcripts.js';
import { acquireSessionClaim, claimIsHeld } from '../claims.js';
import { HarnessStateVersionError, StateIndex, loadIndex, resetHarnessStateCaches, storeIndex } from './index-file.js';
import { capInvocations, invocationRollups, totalsOf } from './invocations.js';
import { splitSession } from './merge.js';
import { HARNESS_STATE_VERSION, exists, harnessIndexPath, harnessStatePath, isoStamp } from './paths.js';
import { HarnessSecrets, readSecretsFile, writeSecretsFile } from './secrets.js';
import { HARNESS_DEFAULT_SETTINGS } from './settings.js';

async function readLegacyFile(): Promise<HarnessState> {
  const path = harnessStatePath();
  let parsed: Partial<HarnessState>;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HarnessState>;
  } catch (error) {
    // Version 1 recovered a damaged primary from the private backup beside it.
    try {
      parsed = JSON.parse(await readFile(`${path}.bak`, 'utf8')) as Partial<HarnessState>;
    } catch {
      throw error;
    }
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
    throw new Error('unsupported local AI harness state');
  }
  return parsed as HarnessState;
}

/** Step 1 -> 2: the single file becomes the split layout.
 *
 * Crash-safe by ordering: transcripts, claims and secrets are written first,
 * `index.json` last -- its existence is the commit point. The result is
 * re-read from disk and compared with the source before the legacy file is
 * renamed aside (never deleted). Running it again -- after a crash at any
 * point, or because an older build still running in another terminal wrote a
 * new legacy file -- imports only what the split layout does not already have
 * newer, so it is idempotent. Caller holds the state lock. */
async function migrateSingleFileToSplitLayout(): Promise<void> {
  const legacy = await readLegacyFile();
  const existing = await loadIndex();
  if (existing && existing.version > HARNESS_STATE_VERSION) throw new HarnessStateVersionError(existing.version);
  const index: StateIndex = existing ? cloneData(existing) : {
    version: HARNESS_STATE_VERSION,
    installationId: legacy.installationId || randomUUID(),
    ...(legacy.devicePublicKey ? { devicePublicKey: legacy.devicePublicKey } : {}),
    accounts: [], sessions: [], invocations: [], invocationRollups: {},
    globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...legacy.globalSettings },
    providerSettings: legacy.providerSettings && typeof legacy.providerSettings === 'object' ? legacy.providerSettings : {},
  };
  index.version = HARNESS_STATE_VERSION;

  const knownSessions = new Map(index.sessions.map((session) => [session.id, session]));
  const imported: HarnessSession[] = [];
  for (const session of legacy.sessions) {
    const present = knownSessions.get(session.id);
    if (present && !(String(session.updatedAt) > String(present.updatedAt))) continue;
    const { meta, transcript } = splitSession(session);
    await writeSessionTranscript(session.id, transcript);
    if (present) index.sessions[index.sessions.indexOf(present)] = meta;
    else index.sessions.push(meta);
    imported.push(session);
  }
  for (const session of legacy.sessions) {
    const claim = session.claim;
    if (!claim || !claimIsHeld({ ...claim, sessionId: session.id, nonce: '' })) continue;
    await acquireSessionClaim(session.id, { pid: claim.pid, host: claim.host, heartbeatAt: claim.heartbeatAt }).catch(() => undefined);
  }
  const knownAccounts = new Set(index.accounts.map((account) => account.id));
  for (const account of legacy.accounts) if (!knownAccounts.has(account.id)) index.accounts.push(account);
  const knownInvocations = new Set(index.invocations.map((invocation) => invocation.id));
  for (const invocation of Array.isArray(legacy.invocations) ? legacy.invocations : []) {
    if (knownInvocations.has(invocation.id)) continue;
    // Anything at or before this point was already counted into a rollup.
    if (index.rolledThrough && !(String(invocation.at) > index.rolledThrough)) continue;
    index.invocations.push(invocation);
  }
  const expectedTotals = totalsOf(index.invocations, index.invocationRollups);
  capInvocations(index);

  const secrets = await readSecretsFile();
  const nextSecrets: HarnessSecrets = {
    localApiToken: secrets.localApiToken || legacy.localApiToken || undefined,
    devicePrivateKeyPem: secrets.devicePrivateKeyPem || legacy.devicePrivateKeyPem || undefined,
  };
  if (!sameData(secrets, nextSecrets)) await writeSecretsFile(nextSecrets);

  const hadIndex = !!existing;
  await storeIndex(index, { backup: true });

  // Verify from disk, not from memory.
  resetHarnessStateCaches();
  const problems: string[] = [];
  const written = await loadIndex();
  if (!written) problems.push('index.json is missing');
  else {
    const writtenSessions = new Map(written.sessions.map((session) => [session.id, session]));
    for (const session of imported) {
      const { meta, transcript } = splitSession(session);
      if (!sameData(writtenSessions.get(session.id), meta)) problems.push(`session ${session.id} metadata`);
      if (!sameData(await readSessionTranscript(session.id), transcript)) problems.push(`session ${session.id} transcript`);
    }
    for (const account of legacy.accounts) {
      if (!written.accounts.some((item) => item.id === account.id)) problems.push(`account ${account.id}`);
      else if (!hadIndex && !sameData(written.accounts.find((item) => item.id === account.id), account)) problems.push(`account ${account.id} fields`);
    }
    if (!sameData(totalsOf(written.invocations, written.invocationRollups), expectedTotals)) problems.push('invocation totals');
    const writtenSecrets = await readSecretsFile();
    if (legacy.localApiToken && !writtenSecrets.localApiToken) problems.push('local API token');
    if (legacy.devicePrivateKeyPem && !writtenSecrets.devicePrivateKeyPem) problems.push('device key');
  }
  if (problems.length) {
    // Leave the legacy file authoritative so the next start retries cleanly.
    if (!hadIndex) await unlink(harnessIndexPath()).catch(() => undefined);
    resetHarnessStateCaches();
    throw new Error(`ClikCode state migration could not be verified (${problems.slice(0, 5).join(', ')}). The original ${harnessStatePath()} was left untouched.`);
  }

  const stamp = isoStamp();
  const legacyPath = harnessStatePath();
  const aside = join(stateDirectory(), `harness-state.legacy-${stamp}.json`);
  if (await exists(legacyPath)) {
    await rename(legacyPath, aside);
    await chmod(aside, 0o600).catch(() => undefined);
  }
  if (await exists(`${legacyPath}.bak`)) {
    await rename(`${legacyPath}.bak`, `${aside}.bak`);
    await chmod(`${aside}.bak`, 0o600).catch(() => undefined);
  }
}

/** One function per step, keyed by the version it upgrades FROM. */
const MIGRATIONS: Record<number, () => Promise<void>> = {
  1: migrateSingleFileToSplitLayout,
};

async function createFreshLayout(): Promise<void> {
  const index: StateIndex = {
    version: HARNESS_STATE_VERSION,
    installationId: randomUUID(),
    accounts: [], sessions: [], invocations: [], invocationRollups: {},
    globalSettings: { ...HARNESS_DEFAULT_SETTINGS },
    providerSettings: {},
  };
  await storeIndex(index, { backup: true });
}

/** Brings whatever is on disk up to the current layout. Two `stat`s on the
 * common path; everything else happens once, under the state lock. */
export async function ensureLayout(): Promise<void> {
  const [hasIndex, hasLegacy] = await Promise.all([exists(harnessIndexPath()), exists(harnessStatePath())]);
  if (hasIndex && !hasLegacy) return;
  await withStateLock(() => ensureLayoutLocked());
}

export async function ensureLayoutLocked(): Promise<void> {
  const [hasIndex, hasLegacy] = await Promise.all([exists(harnessIndexPath()), exists(harnessStatePath())]);
  if (hasLegacy) {
    const index = hasIndex ? await loadIndex() : undefined;
    // A newer layout owns this directory; do not fold anything into it.
    if (index && index.version > HARNESS_STATE_VERSION) return;
    await MIGRATIONS[1]!();
    return;
  }
  if (!hasIndex) await createFreshLayout();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
