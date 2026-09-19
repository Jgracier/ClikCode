/** Local ClikCode state persistence -- the on-disk harness-state.json
 * lifecycle (read/write/migrate/backup), the device signing identity, and
 * the resolved per-provider default settings. No terminal UI, no CLI
 * command wiring -- just "what's on disk and how do we safely change it." */

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await writeState(normalized);
    return normalized;
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
    return fresh;
  }
}

export async function writeState(state: HarnessState): Promise<void> {
  const path = harnessStatePath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  // An interrupted write must leave the last complete account/session registry
  // available rather than corrupting every centralized session on next launch.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await copyFile(path, `${path}.bak`).catch(() => undefined);
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
