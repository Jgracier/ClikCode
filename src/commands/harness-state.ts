/** Local ClikCode state persistence -- the on-disk harness-state.json
 * lifecycle (read/write/migrate/backup), the device signing identity, and
 * the resolved per-provider default settings. No terminal UI, no CLI
 * command wiring -- just "what's on disk and how do we safely change it." */

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount, HarnessDefaultSettings, HarnessSession, HarnessState } from './types.js';

export const HARNESS_STATE_VERSION = 1;
export const LOCAL_HARNESS_PROTOCOL = 1;


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

export function newDeviceSigningIdentity(): Pick<HarnessState, 'devicePrivateKeyPem' | 'devicePublicKey'> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    devicePrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    devicePublicKey: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  };
}

/** The snapshot a state object was last known to agree with on disk. Writes
 * diff against it so a process only ever persists what it actually changed. */
const STATE_BASELINE = Symbol('clikcode.stateBaseline');
type BaselinedState = HarnessState & { [STATE_BASELINE]?: HarnessState };

function rememberBaseline(state: HarnessState, baseline: HarnessState): HarnessState {
  // Non-enumerable so it never reaches JSON.stringify, equality checks, or disk.
  Object.defineProperty(state, STATE_BASELINE, {
    value: JSON.parse(JSON.stringify(baseline)) as HarnessState,
    configurable: true, writable: true, enumerable: false,
  });
  return state;
}

type Identified = { id: string };

/** Entity-level three-way merge. Records this process did not touch are taken
 * from disk, so a stale snapshot can never erase another terminal's work.
 * Removing a record is still expressed: present in the baseline and absent
 * from the working copy means a deliberate delete. */
function mergeById<T extends Identified>(baseline: readonly T[], working: readonly T[], disk: readonly T[]): T[] {
  const before = new Map(baseline.map((item) => [item.id, JSON.stringify(item)]));
  const workingIds = new Set(working.map((item) => item.id));
  const merged = new Map(disk.map((item) => [item.id, item]));
  for (const id of before.keys()) if (!workingIds.has(id)) merged.delete(id);
  for (const item of working) {
    const previous = before.get(item.id);
    if (previous === undefined || previous !== JSON.stringify(item)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

/** Same rule, per key, for the settings maps. */
function mergeRecord<T extends object>(baseline: T, working: T, disk: T): T {
  const before = (baseline ?? {}) as Record<string, unknown>;
  const after = (working ?? {}) as Record<string, unknown>;
  const result = { ...((disk ?? {}) as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (after[key] === undefined) delete result[key];
    else result[key] = after[key];
  }
  return result as T;
}

export function mergeHarnessState(baseline: HarnessState, working: HarnessState, disk: HarnessState): HarnessState {
  const scalar = <K extends keyof HarnessState>(key: K): HarnessState[K] =>
    JSON.stringify(baseline[key]) !== JSON.stringify(working[key]) ? working[key] : disk[key];
  return {
    ...disk,
    version: working.version,
    installationId: disk.installationId || working.installationId,
    localApiToken: scalar('localApiToken'),
    devicePrivateKeyPem: scalar('devicePrivateKeyPem'),
    devicePublicKey: scalar('devicePublicKey'),
    accounts: mergeById(baseline.accounts ?? [], working.accounts ?? [], disk.accounts ?? []),
    sessions: mergeById(baseline.sessions ?? [], working.sessions ?? [], disk.sessions ?? []),
    invocations: mergeById(baseline.invocations ?? [], working.invocations ?? [], disk.invocations ?? []),
    globalSettings: mergeRecord(baseline.globalSettings, working.globalSettings, disk.globalSettings),
    providerSettings: mergeRecord(baseline.providerSettings, working.providerSettings, disk.providerSettings),
  };
}

/** Serializes writes inside this process; the lock file serializes them across
 * terminals. Both are needed: the merge below reads the file and writes it
 * back, and that pair has to be atomic. */
let writeQueue: Promise<unknown> = Promise.resolve();
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

async function withStateLock<T>(run: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(() => withFileLock(run));
  writeQueue = result.catch(() => undefined);
  return result;
}

async function withFileLock<T>(run: () => Promise<T>): Promise<T> {
  const lockPath = `${harnessStatePath()}.lock`;
  await mkdir(join(lockPath, '..'), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle: FileHandle | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => Number.POSITIVE_INFINITY);
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      // Never hang a chat on a lock. The merge still protects the common case,
      // so proceeding is strictly better than refusing to save the turn.
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await run();
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/** The merge base for a write.
 *
 * Only a genuinely absent file means "nothing to merge against". Any other
 * failure must NOT fall back to the caller's copy: that would overwrite the
 * whole file and erase every other terminal's work, the precise bug the merge
 * exists to prevent. A damaged primary falls back to the backup written beside
 * it, which is a valid base; if neither can be read the write refuses rather
 * than clobbering. */
async function readStateFromDisk(): Promise<HarnessState | undefined> {
  const path = harnessStatePath();
  try {
    return JSON.parse(await readFile(path, 'utf8')) as HarnessState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    try {
      return JSON.parse(await readFile(`${path}.bak`, 'utf8')) as HarnessState;
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw backupError;
    }
  }
}

export function harnessStatePath(): string {
  // The caller may relocate non-secret state for testing or portable installs.
  // Provider tokens never live in this file; only opaque local credential refs do.
  const clikCode = process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode');
  const base = process.env.CLIKCODE_HOME?.trim()
    || process.env.CLIKDEPLOY_AI_HOME?.trim()
    || (clikCode ? join(homedir(), '.clikcode') : join(homedir(), '.clikdeploy', 'ai'));
  return join(base, 'harness-state.json');
}

export function harnessCommand(): string {
  return process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode')
    ? 'clikcode'
    : 'clikdeploy ai';
}

export async function readState(): Promise<HarnessState> {
  const path = harnessStatePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HarnessState>;
    if (parsed.version !== HARNESS_STATE_VERSION || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
      throw new Error('unsupported local AI harness state');
    }
    // State written by the metadata-only preview gets a secret lazily on its
    // first secure start, preserving account aliases without exposing a window
    // where they are served unauthenticated.
    if (!parsed.localApiToken || !parsed.devicePrivateKeyPem || !parsed.devicePublicKey) {
      const upgraded = {
        ...parsed,
        ...(parsed.localApiToken ? {} : { localApiToken: randomBytes(32).toString('base64url') }),
        ...(!parsed.devicePrivateKeyPem || !parsed.devicePublicKey ? newDeviceSigningIdentity() : {}),
        globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...parsed.globalSettings, permissionMode: normalizedPermissionMode(parsed.globalSettings?.permissionMode) },
        providerSettings: Object.fromEntries(Object.entries(parsed.providerSettings && typeof parsed.providerSettings === 'object' ? parsed.providerSettings : {}).map(([provider, settings]) => [
          provider,
          { ...settings, ...(settings.permissionMode ? { permissionMode: normalizedPermissionMode(settings.permissionMode) } : {}) },
        ])),
        sessions: (parsed.sessions as HarnessSession[]).map((session) => ({ ...session, ...normalizedConversation(session), ...normalizedSessionPermission(session) })),
      } as HarnessState;
      rememberBaseline(upgraded, parsed as HarnessState);
      await writeState(upgraded);
      return upgraded;
    }
    // Older previews did not include a failover preference. Migrate those
    // sessions to the safe default so a local account does not remain stuck
    // after its known quota window is exhausted.
    const sessions: HarnessSession[] = (parsed.sessions as HarnessSession[]).map((session) => ({
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
    const accounts = (parsed.accounts as AiHarnessAccount[]).map(({ quotaRetryAt: _obsoleteRetryAt, ...account }) => account);
    const normalized = {
      ...(parsed as HarnessState), accounts, sessions, invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [],
      globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...parsed.globalSettings, permissionMode: normalizedPermissionMode(parsed.globalSettings?.permissionMode) },
      providerSettings: Object.fromEntries(Object.entries(parsed.providerSettings && typeof parsed.providerSettings === 'object' ? parsed.providerSettings : {}).map(([provider, settings]) => [
        provider,
        { ...settings, ...(settings.permissionMode ? { permissionMode: normalizedPermissionMode(settings.permissionMode) } : {}) },
      ])),
    };
    rememberBaseline(normalized, parsed as HarnessState);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await writeState(normalized);
    // A migration write refreshes the baseline to the migrated shape; when no
    // migration ran the baseline is already the parsed file.
    return rememberBaseline(normalized, normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Atomic replacement prevents partial writes; the private backup also
      // recovers valid state if the primary was edited or damaged externally.
      try {
        const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8')) as Partial<HarnessState>;
        if (backup.version !== HARNESS_STATE_VERSION || !Array.isArray(backup.accounts) || !Array.isArray(backup.sessions)) throw error;
        const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.recovery`;
        await writeFile(temporary, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, path);
        return readState();
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT' && backupError !== error) throw backupError;
        throw error;
      }
    }
    const fresh: HarnessState = {
      version: HARNESS_STATE_VERSION,
      installationId: randomUUID(),
      localApiToken: randomBytes(32).toString('base64url'),
      ...newDeviceSigningIdentity(),
      accounts: [],
      sessions: [],
      invocations: [],
      globalSettings: { ...HARNESS_DEFAULT_SETTINGS },
      providerSettings: {},
    };
    // The device identity and its loopback bearer must survive the first
    // process exit; otherwise a gateway registration could be valid only for
    // the process that happened to create it.
    await writeState(fresh);
    return rememberBaseline(fresh, fresh);
  }
}

async function persistState(state: HarnessState): Promise<void> {
  const path = harnessStatePath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  // An interrupted write must leave the last complete account/session registry
  // available rather than corrupting every centralized session on next launch.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await copyFile(path, `${path}.bak`).catch(() => undefined);
}

/** Applies this process's changes to whatever is on disk now, rather than
 * making the file equal the caller's copy.
 *
 * Callers legitimately hold one state object across a whole turn -- the turn
 * checkpoint rewrites its snapshot every 250ms while a response streams -- so
 * a blind overwrite meant any second terminal's messages, accounts, and
 * settings were erased several times a second. Diffing against the snapshot
 * the caller last agreed with means untouched records are taken from disk and
 * only real changes are written. */
export async function writeState(state: HarnessState): Promise<void> {
  await withStateLock(async () => {
    const baseline = (state as BaselinedState)[STATE_BASELINE];
    const disk = baseline ? await readStateFromDisk() : undefined;
    const merged = baseline && disk ? mergeHarnessState(baseline, state, disk) : state;
    await persistState(merged);
    // Later writes from this same object must diff from what it looks like
    // now, not from the original read.
    rememberBaseline(state, state);
  });
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
