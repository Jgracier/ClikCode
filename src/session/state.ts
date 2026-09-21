/** Local ClikCode state persistence -- what is on disk and how it is safely
 * changed. No terminal UI, no CLI command wiring.
 *
 * Layout under the state directory (version 2):
 *
 *   index.json            accounts, settings, session METADATA, recent invocations
 *   sessions/<id>.json    one conversation's transcript and pending turn
 *   claims/<id>.json      which terminal is driving a conversation (session-claims.ts)
 *   secrets.json          loopback bearer token and any device private key (0600)
 *
 * Version 1 kept all of that in one `harness-state.json` that was re-read,
 * re-serialized and rewritten in full for every streamed checkpoint, so the
 * cost of one keystroke's worth of output grew with total history forever.
 * `readState`/`writeState` keep their original contract -- callers still see
 * one in-memory `HarnessState` with materialized messages -- but a write now
 * touches only the records that actually changed. */

import { generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount, HarnessDefaultSettings, HarnessSession, HarnessState } from '../harness/types.js';
import {
  atomicWriteFile, cloneData, deleteSessionTranscript, readSessionTranscript, resetSessionStoreCache,
  sameData, stateDirectory, transcriptOf, transcriptParentOf, withStateLock, writeSessionTranscript,
  type SessionTranscript,
} from './store.js';
import {
  acquireSessionClaim, claimIsHeld, heartbeatSessionClaim, readSessionClaims, releaseSessionClaim, type SessionClaim,
} from './claims.js';

export { forkTranscript, writeSessionCheckpoint, StateLockTimeoutError, type SessionTranscript, type TranscriptRef } from './store.js';
export {
  acquireSessionClaim, claimIsHeld, heartbeatSessionClaim, readSessionClaim, readSessionClaims, releaseSessionClaim,
  type ClaimOptions, type ClaimResult, type SessionClaim,
} from './claims.js';

/** On-disk layout version. 1 = single harness-state.json, 2 = split layout. */
export const HARNESS_STATE_VERSION = 2;
export const LOCAL_HARNESS_PROTOCOL = 1;
/** Individual invocation records kept; older ones fold into per-day totals. */
export const INVOCATION_KEEP = 1000;

function sameSecret(left: string | undefined, right: string | undefined): boolean {
  const a = Buffer.from(left ?? '', 'utf8');
  const b = Buffer.from(right ?? '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Defaults a brand-new session is built from. Provider-specific overrides win
 * over the global defaults, which win over the hardcoded fallback — replacing
 * the old behavior of silently copying whatever the previous session happened
 * to have (a one-off read-only session would otherwise make the *next* new
 * chat read-only too, with no setting anywhere explaining why). */

export const HARNESS_DEFAULT_SETTINGS: HarnessDefaultSettings = { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' };

function normalizedPermissionMode(value: unknown): HarnessDefaultSettings['permissionMode'] {
  if (value === 'auto' || value === 'bypass' || value === 'ask') return value;
  // Legacy ClikCode releases described sandbox width instead of approval
  // behavior. Both interactive legacy modes become the new explicit Ask.
  if (value === 'read-only' || value === 'workspace-write') return 'ask';
  return HARNESS_DEFAULT_SETTINGS.permissionMode;
}

function normalizedSessionPermission(session: HarnessSession): Pick<HarnessSession, 'permissionMode'> {
  // Gateway authorization is enforced by the authenticated platform and has
  // no local Ask/Bypass/Auto override. Keep that distinction in persisted
  // state too; otherwise every read silently reintroduced `ask` after the
  // Gateway creation/switch paths deliberately removed it.
  return session.route === 'gateway'
    ? { permissionMode: undefined }
    : { permissionMode: normalizedPermissionMode(session.permissionMode) };
}

function normalizedConversation(session: HarnessSession): Pick<HarnessSession, 'conversationId'> {
  // Pre-handoff state had one ClikCode session per conversation. Preserve
  // that exact behavior while giving every existing record a durable root.
  return { conversationId: session.conversationId || session.id };
}

export function resolveDefaultSettings(state: HarnessState, provider?: string | null): HarnessDefaultSettings {
  const overrides = provider ? state.providerSettings[provider] : undefined;
  return {
    effort: overrides?.effort ?? state.globalSettings.effort,
    permissionMode: overrides?.permissionMode ?? state.globalSettings.permissionMode,
    accountFailover: overrides?.accountFailover ?? state.globalSettings.accountFailover,
  };
}


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Path of the version-1 single-file state. Callers use its directory as the
 * state root; since version 2 nothing is stored at this exact path (a file
 * found here is migrated and renamed aside). It held secrets, so it was never
 * "non-secret state" as an earlier comment claimed. */
export function harnessStatePath(): string {
  return join(stateDirectory(), 'harness-state.json');
}

export function harnessIndexPath(): string {
  return join(stateDirectory(), 'index.json');
}

export function harnessSecretsPath(): string {
  return join(stateDirectory(), 'secrets.json');
}

export function harnessCommand(): string {
  return process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode')
    ? 'clikcode'
    : 'clikdeploy ai';
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

interface HarnessSecrets { localApiToken?: string; devicePrivateKeyPem?: string }

async function readSecretsFile(): Promise<HarnessSecrets> {
  const path = harnessSecretsPath();
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600).catch(() => undefined);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as HarnessSecrets;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeSecretsFile(secrets: HarnessSecrets): Promise<void> {
  await atomicWriteFile(harnessSecretsPath(), `${JSON.stringify(cloneData(secrets), null, 2)}\n`);
}

/** Bearer secret for the loopback protocol, created on first use. */
export async function readLocalApiToken(): Promise<string> {
  const existing = (await readSecretsFile()).localApiToken;
  if (existing) return existing;
  return withStateLock(async () => {
    const current = await readSecretsFile();
    if (current.localApiToken) return current.localApiToken;
    const localApiToken = randomBytes(32).toString('base64url');
    await writeSecretsFile({ ...current, localApiToken });
    return localApiToken;
  });
}


// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

type Invocation = HarnessState['invocations'][number];
type SessionMeta = Omit<HarnessSession, 'messages' | 'pendingTurn' | 'claim'>;

export interface InvocationRollup {
  day: string; accountId: string; provider: string; model: string;
  calls: number; inputTokens: number; outputTokens: number; latencyMs: number;
}

interface StateIndex {
  version: number;
  installationId: string;
  devicePublicKey?: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: SessionMeta[];
  invocations: Invocation[];
  invocationRollups: Record<string, InvocationRollup>;
  /** Newest `at` ever folded into a rollup; guards a re-import from double counting. */
  rolledThrough?: string;
  globalSettings: HarnessDefaultSettings;
  providerSettings: HarnessState['providerSettings'];
}

export class HarnessStateVersionError extends Error {
  constructor(found: number) {
    super(`Local ClikCode state is version ${found}, written by a newer ClikCode than this one (supports up to ${HARNESS_STATE_VERSION}). `
      + 'It can be read but not changed from here. Update ClikCode to continue.');
    this.name = 'HarnessStateVersionError';
  }
}

export const HARNESS_STATE_STATS = { indexWrites: 0 };

/** Parsed index keyed by the exact bytes it came from. Comparing bytes rather
 * than mtime means a merge base can never be stale, and an unchanged index
 * (every streamed checkpoint) is never re-parsed. Treated as immutable. */
let indexCache: { directory: string; raw: string; index: StateIndex } | undefined;

function parseIndex(raw: string): StateIndex {
  const parsed = JSON.parse(raw) as Partial<StateIndex>;
  if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
    throw new Error('unsupported local AI harness state');
  }
  return {
    ...parsed,
    invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [],
    invocationRollups: parsed.invocationRollups && typeof parsed.invocationRollups === 'object' ? parsed.invocationRollups : {},
  } as StateIndex;
}

/** The merge base for a write, and the source for a read.
 *
 * Only a genuinely absent file means "nothing there". Any other failure must
 * NOT fall back to the caller's copy: that would replace the registry and erase
 * every other terminal's work. A damaged primary falls back to the backup
 * written beside it; if neither can be read the operation refuses. */
async function loadIndex(): Promise<StateIndex | undefined> {
  const path = harnessIndexPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (indexCache && indexCache.directory === stateDirectory() && indexCache.raw === raw) return indexCache.index;
  try {
    const index = parseIndex(raw);
    indexCache = { directory: stateDirectory(), raw, index };
    return index;
  } catch (error) {
    try {
      return parseIndex(await readFile(`${path}.bak`, 'utf8'));
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw backupError;
    }
  }
}

async function storeIndex(index: StateIndex, options: { backup: boolean }): Promise<void> {
  const path = harnessIndexPath();
  const raw = `${JSON.stringify(index)}\n`;
  await atomicWriteFile(path, raw);
  HARNESS_STATE_STATS.indexWrites += 1;
  indexCache = { directory: stateDirectory(), raw, index: cloneData(index) };
  if (options.backup) await copyFile(path, `${path}.bak`).catch(() => undefined);
}

export function resetHarnessStateCaches(): void {
  indexCache = undefined;
  resetSessionStoreCache();
}

// ---------------------------------------------------------------------------
// Invocation retention
// ---------------------------------------------------------------------------

function rollupKey(invocation: Invocation): string {
  return [String(invocation.at).slice(0, 10), invocation.accountId, invocation.provider, invocation.model].join('|');
}

/** Keeps the newest INVOCATION_KEEP records and folds the rest into per-day,
 * per-account, per-model totals, so usage totals stay exact while the file
 * stops growing with every request ever made. */
function capInvocations(index: StateIndex): void {
  if (index.invocations.length <= INVOCATION_KEEP) return;
  const ordered = index.invocations
    .map((invocation, position) => ({ invocation, position }))
    .sort((left, right) => String(left.invocation.at).localeCompare(String(right.invocation.at)) || left.position - right.position);
  const overflow = ordered.slice(0, ordered.length - INVOCATION_KEEP);
  const rolled = new Set(overflow.map((entry) => entry.invocation));
  const rollups = { ...index.invocationRollups };
  for (const { invocation } of overflow) {
    const key = rollupKey(invocation);
    const previous = rollups[key] ?? {
      day: String(invocation.at).slice(0, 10), accountId: invocation.accountId, provider: invocation.provider, model: invocation.model,
      calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0,
    };
    rollups[key] = {
      ...previous,
      calls: previous.calls + 1,
      inputTokens: previous.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: previous.latencyMs + (invocation.latencyMs ?? 0),
    };
    if (!index.rolledThrough || String(invocation.at) > index.rolledThrough) index.rolledThrough = String(invocation.at);
  }
  index.invocationRollups = rollups;
  index.invocations = index.invocations.filter((invocation) => !rolled.has(invocation));
}

const STATE_ROLLUPS = Symbol('clikcode.invocationRollups');

/** Per-day totals of invocations older than the newest INVOCATION_KEEP. */
export function invocationRollups(state: HarnessState): InvocationRollup[] {
  return Object.values((state as HarnessState & { [STATE_ROLLUPS]?: Record<string, InvocationRollup> })[STATE_ROLLUPS] ?? {});
}

export interface InvocationTotals { calls: number; inputTokens: number; outputTokens: number; latencyMs: number }

/** All-time totals: the retained records plus everything rolled up. `match`
 * narrows by account/provider/model (the dimensions a rollup preserves). */
export function invocationTotals(
  state: HarnessState,
  match: (entry: { accountId: string; provider: string; model: string }) => boolean = () => true,
): InvocationTotals {
  const totals: InvocationTotals = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  for (const invocation of state.invocations ?? []) {
    if (!match(invocation)) continue;
    totals.calls += 1;
    totals.inputTokens += invocation.inputTokens ?? 0;
    totals.outputTokens += invocation.outputTokens ?? 0;
    totals.latencyMs += invocation.latencyMs ?? 0;
  }
  for (const rollup of invocationRollups(state)) {
    if (!match(rollup)) continue;
    totals.calls += rollup.calls;
    totals.inputTokens += rollup.inputTokens;
    totals.outputTokens += rollup.outputTokens;
    totals.latencyMs += rollup.latencyMs;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

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

function splitSession(session: HarnessSession): { meta: SessionMeta; transcript: SessionTranscript; claim: HarnessSession['claim'] } {
  const { messages: _messages, pendingTurn: _pendingTurn, claim, ...meta } = session;
  return { meta, transcript: transcriptOf(session), claim };
}


// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface BaselineSession { meta: SessionMeta; transcript: SessionTranscript; claim?: HarnessSession['claim'] }
interface StateBaselineData {
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
const STATE_BASELINE = Symbol('clikcode.stateBaseline');
type BaselinedState = HarnessState & { [STATE_BASELINE]?: StateBaselineData };

function hidden<T extends object>(target: T, key: PropertyKey, value: unknown): T {
  // Non-enumerable so it never reaches JSON.stringify, spreads, equality
  // checks, or any panel that prints state.
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  return target;
}

/** `reuse` carries over entries for sessions known to be unchanged, so the
 * per-checkpoint cost follows what changed rather than total history. */
function rememberBaseline(state: HarnessState, reuse?: { from: StateBaselineData; dirty: ReadonlySet<string> }): HarnessState {
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

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

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

function totalsOf(invocations: readonly Invocation[], rollups: Record<string, InvocationRollup>): InvocationTotals {
  const state = hidden({ invocations } as unknown as HarnessState, STATE_ROLLUPS, rollups);
  return invocationTotals(state);
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
async function ensureLayout(): Promise<void> {
  const [hasIndex, hasLegacy] = await Promise.all([exists(harnessIndexPath()), exists(harnessStatePath())]);
  if (hasIndex && !hasLegacy) return;
  await withStateLock(() => ensureLayoutLocked());
}

async function ensureLayoutLocked(): Promise<void> {
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

function indexFromWorking(state: HarnessState, disk: StateIndex | undefined): StateIndex {
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

function mergedIndex(baseline: StateBaselineData, state: HarnessState, disk: StateIndex): StateIndex {
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

export function accountView(account: AiHarnessAccount): Omit<AiHarnessAccount, 'credentialRef'> {
  const { credentialRef: _credentialRef, ...safe } = account;
  return safe;
}

export function deviceManifest(state: HarnessState) {
  return {
    protocol: LOCAL_HARNESS_PROTOCOL,
    installationId: state.installationId,
    devicePublicKey: state.devicePublicKey,
    credentialBoundary: 'local-only' as const,
    capabilities: { chat: true, usage: true, sessions: true, gatewayJobs: false },
    accounts: state.accounts.map(accountView),
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id, provider: account.provider, model, status: account.status,
    }))),
  };
}
