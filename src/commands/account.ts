/**
 * `clikcode account`: listing, adding, signing in and out, and removing the
 * accounts a harness runs as.
 */

import { randomUUID } from 'node:crypto';
import { saveVersionMemo } from '../harness/transport/native/version-memo.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import { emitResult } from '../cli/structured-output.js';
import { captureNativeHarnessOutput } from '../harness/transport/native/command.js';
import { inspectNativeHarness } from '../harness/transport/native/inspect.js';
import { harnessInstallRoute, manualInstallCommand } from '../harness/transport/native/install-route.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { accountVerification, verificationNotice } from '../turn/failover.js';
import { builtInHarnesses, harnessAdapterVersion, harnessIntegrationLevel, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { ADOPTED_TRANSCRIPT_READERS, FS_SESSION_DISCOVERY } from '../session/discovery/registry.js';
import { harnessStatePath } from '../session/state/paths.js';
import { readState } from '../session/state/read.js';
import { accountView } from '../session/state/views.js';
import { writeState } from '../session/state/write.js';
import { accountUsageLabel } from '../harness/accounts/account-usage.js';
import type { AiHarnessAccount, AiHarnessAuthKind, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';
import { deriveAccountLabel, matchingVendorAccount, nameAccount } from '../harness/accounts/labels.js';
import { profileEnvironment, purgeAccountProfile, resolvePurgeableProfile } from '../harness/accounts/profiles.js';
import { authEvidencePresent, harnessCanLogout, hasAuthEvidence, logoutNativeHarness } from '../harness/accounts/auth-files.js';
import { captureMistralVibeCredential } from '../harness/accounts/mistral-vibe-identity.js';

// emitHarnessOutput is defined in ai.ts (the HTTP-server-adjacent JSON/panel
// output helper) -- passed in rather than imported to avoid a circular
// import back to the file this module was extracted from.
type EmitHarnessOutput = (payload: Record<string, unknown>) => void;

let emitHarnessOutput: EmitHarnessOutput = () => {};

export function setEmitHarnessOutput(fn: EmitHarnessOutput): void { emitHarnessOutput = fn; }

export async function aiAccountsList(): Promise<void> {
  const state = await readState();
  const accounts = await Promise.all(state.accounts.map(async (account) => ({
    ...accountView(account), usage: await accountUsageLabel(account, state),
    // An account kept from a harness the catalog has since retired (Crush)
    // can run nothing. Its stored status is the user's, so it stays; this
    // says what it is worth.
    ...(localHarnessForProvider(account.provider) ? {} : {
      supported: false, note: `${account.provider} is no longer a supported tool; remove this account with \`clikcode accounts remove ${account.id}\``,
    }),
  })));
  emitResult({ accounts });
}

/** Lists the normalized local account surfaces without probing provider credentials. */
export async function aiAccountProviders(): Promise<void> {
  emitResult({ harnesses: builtInHarnesses() });
}

/** Read-only compatibility report for every catalog entry. */
/** How `doctor` describes a harness's install: the route choosing it takes,
 * and the same install as a command to run by hand. */
function installSummary(harness: Parameters<typeof harnessInstallRoute>[0]): Record<string, unknown> {
  const route = harnessInstallRoute(harness);
  if (route.kind === 'none') return { kind: 'none', automatic: false, note: route.reason };
  return {
    kind: route.kind, automatic: true,
    ...(route.kind === 'npm' ? { package: route.package } : route.kind === 'script' ? { url: route.step.url } : { package: route.step.package }),
    command: manualInstallCommand(route),
  };
}

export async function aiDoctor(): Promise<void> {
  // One write for the whole sweep: every harness inspected here contributes a
  // version memo, and flushing per harness would be 24 writes for one answer.
  const flush = async (): Promise<void> => { await saveVersionMemo().catch(() => undefined); };
  const harnesses = await Promise.all(builtInHarnesses().map(async (harness) => {
    const inspection = await inspectNativeHarness(harness);
    return {
      command: harness.command,
      displayName: harness.displayName,
      provider: harness.provider,
      surface: harness.surface,
      binary: harness.binary,
      integration: harnessIntegrationLevel(harness),
      install: installSummary(harness),
      ...inspection,
      capabilities: {
        centralizedTurns: Boolean(harness.turn),
        scriptedLogin: Boolean(harness.loginArgv?.length),
        interactiveAuthHandoff: harness.loginArgv !== undefined && harness.loginArgv.length === 0,
        accountAdd: harness.localAuth.includes('api-key') || harness.loginArgv !== undefined,
        accountStatus: Boolean(harness.statusArgv) || hasAuthEvidence(harness),
        logout: harnessCanLogout(harness),
        isolatedProfiles: Boolean(harness.profileEnv),
        modelSelection: harness.modelArgvPrefix !== undefined || Boolean(harness.acp?.listsModels),
        workspaceSelection: Boolean(harness.workspaceArgvPrefix),
        effortSelection: Boolean(harness.effortArgvPrefix),
        permissionModeSelection: (harness.permissionModes?.length ?? 0) > 0,
        permissionModes: harness.permissionModes ?? [],
        exactResume: Boolean(harness.session?.resumeIdPrefix),
        preallocatedSessionIdentity: Boolean(harness.session?.createIdPrefix || harness.session?.createSessionArgv),
        sessionDiscovery: Boolean(harness.session?.discoverArgv || FS_SESSION_DISCOVERY[harness.command]),
        transcriptImport: Boolean(ADOPTED_TRANSCRIPT_READERS[harness.command]),
        continueLatest: Boolean(harness.session?.continueArgv),
      },
    };
  }));
  await flush();
  emitResult({ adapterVersion: harnessAdapterVersion(), harnesses });
}

/**
 * After ANY successful native-CLI login -- not just the explicit "add
 * another account" flow -- checks whether the account's real identity, as
 * the vendor CLI just wrote it, differs from what's on record, and merges
 * or renames accordingly. This exists because a plain provider selection
 * that silently re-triggers its own login (aiHarnessSelect, or the
 * reactive retry-on-auth-failure path) used to only rename an account if
 * its label still looked like the generic "X default" placeholder --
 * missing entirely the case this fixes: re-authenticating as a genuinely
 * DIFFERENT real account, where the label was already a real (just wrong,
 * now-stale) email rather than a placeholder. One real login, one real
 * identity check, everywhere a login can happen -- not two different
 * strengths of the same check depending on which command triggered it.
 */
export async function syncAccountIdentityAfterLogin(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount, state: HarnessState,
): Promise<AiHarnessAccount> {
  // Called right after loginNativeHarness resolved without throwing, so the
  // login itself is known-good regardless of what identity check follows --
  // always mark ready and persist, so a caller never has to separately
  // remember to do either around this call.
  account.status = 'ready';
  account.signedInAt = new Date().toISOString();
  if (harness.command === 'vibe' && account.nativeProfile?.path) {
    if (!await captureMistralVibeCredential(account.nativeProfile.path)) {
      throw new Error('Mistral Vibe login completed, but ClikCode could not save its API key into this account’s isolated profile. The account was not updated.');
    }
  }
  const derived = await deriveAccountLabel(harness, account.nativeProfile?.path);
  if (!derived) {
    await writeState(state);
    return account;
  }
  const existingMatch = await matchingVendorAccount(state.accounts, harness, derived, account.id);
  if (existingMatch) {
    const existingHasNativeSessions = state.sessions.some((session) => session.accountId === existingMatch.id && session.nativeSessionId);
    existingMatch.label = nameAccount(state.accounts.filter((item) => item.id !== account.id), harness, derived, existingMatch.id);
    existingMatch.status = 'ready';
    existingMatch.signedInAt = account.signedInAt;
    if (account.nativeProfile && !existingHasNativeSessions) existingMatch.nativeProfile = account.nativeProfile;
    state.accounts = state.accounts.filter((item) => item.id !== account.id);
    for (const session of state.sessions) if (session.accountId === account.id) session.accountId = existingMatch.id;
    for (const invocation of state.invocations) if (invocation.accountId === account.id) invocation.accountId = existingMatch.id;
    await writeState(state);
    // Old vendor profiles can hold native conversation history. A sign-in
    // merge must never delete that history just because credentials moved.
    return existingMatch;
  }
  account.label = nameAccount(state.accounts, harness, derived, account.id);
  await writeState(state);
  return account;
}

export async function aiAccountLogin(harnessCommandName: string, label?: string): Promise<string> {
  // A sign-in creates its profile before the vendor runs. One that fails, is
  // cancelled, or resolves to an account that keeps its own profile would
  // otherwise leave that directory behind for good, as would the profile an
  // account gives up for a new one.
  const touched = new Set<string>();
  try {
    return await signInAccount(harnessCommandName, label, touched);
  } finally {
    if (touched.size) {
      const { accounts } = await readState({ transcripts: [] });
      for (const path of touched) await purgeAccountProfile({ nativeProfile: { env: '', path } }, accounts);
    }
  }
}

async function signInAccount(harnessCommandName: string, label: string | undefined, touched: Set<string>): Promise<string> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  const state = await readState();
  const explicit = label?.trim();
  let accountLabel = explicit || nameAccount(state.accounts, harness);
  if (!accountLabel) throw new Error('account label cannot be empty');
  // Resolve the signed-in identity before choosing a label. An existing
  // label may belong to this same identity, even when the caller supplied it.
  // A harness with no profileEnv can only ever have one real vendor-cli
  // identity ClikCode can track (there's no isolated directory to give a
  // second one its own credentials) -- but the useful thing to do about
  // that is reauthenticate the one that's already there, not dead-end.
  // This used to just throw here unconditionally, which is exactly what
  // "Antigravity CLI does not publish an isolated configuration-root
  // contract" was: the harness's one slot was already claimed by an
  // account that had never actually been through a real login (created by
  // aiHarnessSelect's own auto-creation, which -- before a companion fix --
  // had no way to know a statusArgv-less harness like this one wasn't
  // really authenticated yet), leaving no path back to authenticate it at
  // all. Re-running login against the same unisolated default profile and
  // updating that existing account in place is the correct "add an
  // account" outcome for this shape of harness.
  const singleSlotExisting = !harness.profileEnv
    ? state.accounts.find((account) => account.provider === harness.provider && account.authKind === 'vendor-cli')
    : undefined;
  if (singleSlotExisting) {
    await loginNativeHarness(harness, {});
    const signedIn = await syncAccountIdentityAfterLogin(harness, singleSlotExisting, state);
    emitHarnessOutput({ status: 'connected', harness: harness.command, account: signedIn.label, credentialBoundary: 'local-only' });
    return signedIn.label;
  }
  const accountId = randomUUID();
  const profilePath = harness.profileEnv
    ? join(harnessStatePath(), '..', 'profiles', harness.command, accountId)
    : undefined;
  if (profilePath) {
    touched.add(profilePath);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
  }
  // Antigravity CLI's own default auth checks the OS-level keyring first --
  // confirmed live it's tied to the login *session* (via D-Bus), not to
  // $HOME, so every isolated profile above silently resolves to the same
  // one shared identity regardless of path. The Application Default
  // Credentials route (via gcloud) was tried and reverted: it genuinely
  // worked, but required installing the Google Cloud SDK and, worse, a
  // real Google Cloud project with billing enabled -- confirmed live by
  // running the actual chain to completion and hitting exactly that wall.
  // The simpler fix, also confirmed live: agy's own auth chain is
  // "keyring lookup, then its own native browser-based sign-in" -- making
  // the keyring genuinely unreachable for just this child process (not
  // the user's real desktop session; these are env vars on one spawned
  // process, nothing global) makes it fall through to that native flow on
  // its own, no gcloud, no project, no billing, ever. Confirmed live: with
  // both vars set, agy printed its own real OAuth URL under its own
  // dedicated client id -- not gcloud's -- instead of silently succeeding
  // via the shared keyring.
  const extraEnv: Record<string, string> = {};
  if (harness.command === 'antigravity' && profilePath) {
    extraEnv.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
    extraEnv.XDG_RUNTIME_DIR = join(profilePath, 'runtime');
  }
  const nativeProfile = profilePath && harness.profileEnv
    ? { env: harness.profileEnv, path: profilePath, ...(Object.keys(extraEnv).length ? { extraEnv } : {}) }
    : undefined;
  if (harness.command === 'vibe' && profilePath) {
    for (const previous of state.accounts.filter((account) => account.provider === harness.provider && !account.nativeProfile)) {
      const previousPath = join(harnessStatePath(), '..', 'profiles', harness.command, previous.id);
      touched.add(previousPath);
      await mkdir(previousPath, { recursive: true, mode: 0o700 });
      if (await captureMistralVibeCredential(previousPath)) previous.nativeProfile = { env: 'VIBE_HOME', path: previousPath };
    }
    await writeState(state);
  }
  let loginError: unknown;
  try {
    await loginNativeHarness(harness, profileEnvironment(harness, { nativeProfile }));
  } catch (error) {
    // Antigravity has no login command; ClikCode signs in by running
    // `-p /help`, which answers locally and stores no conversation (a real
    // 'hi' turn used to leave one per account). Any failure after the sign-in
    // (quota, rate limit, a transient error) still exits non-zero and looks
    // identical to authentication itself having failed.
    // Discarding a login this eagerly threw away real, successful OAuth
    // sessions whenever the account happened to be rate-limited. Hold the
    // error and check independently, via the log Antigravity itself writes
    // on successful auth, whether authentication actually succeeded despite
    // the verification turn failing -- only surface the error if it didn't.
    if (harness.command !== 'antigravity' || !profilePath) throw error;
    loginError = error;
  }
  if (harness.command === 'vibe' && profilePath && !await captureMistralVibeCredential(profilePath)) {
    throw new Error('Mistral Vibe login completed, but ClikCode could not save its API key into this account’s isolated profile. The account was not added.');
  }
  // The vendor's identity decides the account even when the caller supplied
  // a label. Skipping this for explicit labels created duplicate sign-ins of
  // one email under different names.
  const derived = await deriveAccountLabel(harness, profilePath);
  if (!derived && loginError) throw loginError;
  if (derived) {
    const existingMatch = await matchingVendorAccount(state.accounts, harness, derived);
    if (existingMatch) {
      const existingHasNativeSessions = state.sessions.some((session) => session.accountId === existingMatch.id && session.nativeSessionId);
      existingMatch.label = nameAccount(state.accounts, harness, derived, existingMatch.id);
      existingMatch.status = 'ready';
      if (nativeProfile && !existingHasNativeSessions) {
        if (existingMatch.nativeProfile?.path) touched.add(existingMatch.nativeProfile.path);
        existingMatch.nativeProfile = nativeProfile;
      }
      existingMatch.verification = undefined;
      const verifyNotice = recordVerification(existingMatch, loginError);
      await writeState(state);
      emitHarnessOutput({ status: 'connected', harness: harness.command, account: existingMatch.label, credentialBoundary: 'local-only' });
      if (verifyNotice) emitHarnessOutput({ panel: 'error', message: verifyNotice });
      return existingMatch.label;
    }
    accountLabel = nameAccount(state.accounts, harness, derived);
  } else accountLabel = nameAccount(state.accounts, harness, accountLabel);
  let verifyNotice: string | undefined;
  const created: AiHarnessAccount = { id: accountId, provider: harness.provider, label: accountLabel, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${harness.binary}`, ...(nativeProfile ? { nativeProfile } : {}) };
  verifyNotice = recordVerification(created, loginError);
  state.accounts.push(created);
  await writeState(state);
  emitHarnessOutput({ status: 'connected', harness: harness.command, account: accountLabel, credentialBoundary: 'local-only' });
  if (verifyNotice) emitHarnessOutput({ panel: 'error', message: verifyNotice });
  return accountLabel;
}

/** Written directly to the real terminal, not ClikCode's own alt-screen
 * activity log -- an activity() call right before suspend() gets thrown
 * away the instant the alt-screen exits, so it's never actually visible;
 * this writes after suspend() has already switched to the main buffer,
 * where it's the last thing on screen before the child's own output
 * starts. Only for harnesses whose loginArgv is an empty array (currently
 * Gemini CLI, Antigravity CLI): that shape means "launch bare, no
 * dedicated login subcommand exists" -- confirmed live for Antigravity
 * specifically that this drops into its own full interactive session
 * (a real, separate program, not a quick sign-in step) with no way back to
 * ClikCode until the user exits *that* program on its own terms. Every
 * other harness's loginArgv actually targets a real login flow that
 * returns control on its own once finished, so this notice would be noise
 * for those. */
export function announceBareInteractiveLogin(harness: Pick<AiLocalHarnessDefinition, 'displayName' | 'loginArgv' | 'loginHint'>): void {
  // A vendor that signs in only from inside its own session (Pi's /login)
  // says what to type; the rest open straight into their sign-in.
  const hint = harness.loginHint ? ` ${harness.loginHint}, then` : '';
  if (harness.loginArgv?.length === 0 || harness.loginHint) {
    output.write(`\n${chalk.dim(`Opening ${harness.displayName}'s own interactive session to sign in --${hint} exit it (its own quit/Ctrl+C) once done to return here.`)}\n\n`);
  }
}

/** What a vendor sign-in needs from whatever is on screen. A terminal
 * prompter has all of it; headless callers pass nothing and the vendor just
 * runs. */
export interface SignInSurface {
  startWaiting(message: string): void;
  stopWaiting(): void;
  suspend(): Promise<void>;
  resume(): void;
  activity?(message: string): void;
}

/** Runs `work` -- a vendor's own sign-in -- with the terminal handed to it.
 * The one copy of what four call sites each did their own way: a sign-in
 * that needs no terminal (Antigravity's) keeps ClikCode on screen behind a
 * spinner; every other one gets the real terminal, told first what to type
 * where the vendor signs in only from inside its own session. */
export async function withVendorTerminal<T>(
  surface: SignInSurface | undefined,
  harness: Pick<AiLocalHarnessDefinition, 'displayName' | 'loginArgv' | 'loginHint' | 'loginCapturable'>,
  work: () => Promise<T>,
  name = harness.displayName,
): Promise<T> {
  if (!surface) return work();
  // One line in the conversation, written once the sign-in is over and
  // saying how it went. A "signing in to" line written before it stayed
  // there for good, whatever happened, and the vendor's own screen covered
  // it while the sign-in ran anyway.
  const outcome = (error: unknown): void => surface.activity?.(error === undefined
    ? `${chalk.green('signed in to')} ${chalk.dim(name)}`
    : `${chalk.yellow(`sign-in to ${name} did not finish`)}${error instanceof Error && error.message ? chalk.dim(` · ${error.message.split('\n')[0]}`) : ''}`);
  if (harness.loginCapturable) {
    surface.startWaiting(`signing in to ${name}…`);
    try {
      const result = await work();
      surface.stopWaiting();
      outcome(undefined);
      return result;
    } catch (error) {
      surface.stopWaiting();
      outcome(error);
      throw error;
    }
  }
  await surface.suspend();
  try {
    announceBareInteractiveLogin({ ...harness, displayName: name });
    const result = await work();
    surface.resume();
    outcome(undefined);
    return result;
  } catch (error) {
    surface.resume();
    outcome(error);
    throw error;
  }
}

function nativeAccountContext(state: HarnessState, labelOrId: string): { account: AiHarnessAccount; harness: AiLocalHarnessDefinition; environment: Record<string, string> } {
  const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
  if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
  if (account.authKind !== 'vendor-cli') throw new Error(`account "${account.label}" is not owned by a vendor CLI`);
  const harness = localHarnessForProvider(account.provider);
  if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
  const environment = profileEnvironment(harness, account);
  return { account, harness, environment };
}

export async function aiAccountStatus(labelOrId: string): Promise<void> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harness.statusArgv && !hasAuthEvidence(harness)) throw new Error(`${harness.displayName} does not publish a non-destructive account-status command`);
  const nativeStatus = harness.statusArgv
    ? (await captureNativeHarnessOutput(harness, harness.statusArgv, environment)).trim()
    : await authEvidencePresent(harness, environment) ? 'signed in' : 'not signed in';
  // An explicit check of one account: ask the harness now.
  const usage = await accountUsageLabel(account, state, { network: true });
  emitResult({ account: { ...accountView(account), usage }, nativeStatus, credentialBoundary: 'local-only' });
}

export async function aiAccountLogout(labelOrId: string): Promise<void> {
  const account = await signOutAccount(labelOrId);
  emitResult({ account: accountView(account), loggedOut: true, credentialBoundary: 'local-only' });
}

/** The one sign-out: the vendor's own logout in the account's profile, then
 * the account marked as needing a login. Clearing signedInAt retires any
 * live vendor child still holding the old credentials. */
export async function signOutAccount(labelOrId: string): Promise<AiHarnessAccount> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harnessCanLogout(harness)) throw new Error(`${harness.displayName} has no way to sign out from outside its own session.`);
  await logoutNativeHarness(harness, environment);
  account.status = 'needs_login';
  delete account.signedInAt;
  await writeState(state);
  return account;
}

/** A login can succeed while the vendor still refuses to serve the account
 * until it is verified (agy: "Verify your account to continue"). The sign-in
 * is kept, but "connected" alone leaves the user to discover the block on the
 * first turn, so record it on the account and say what to do about it now. */
function recordVerification(account: AiHarnessAccount, loginError: unknown): string | undefined {
  const verification = loginError ? accountVerification(loginError) : undefined;
  if (!verification) return undefined;
  account.verification = { ...verification, at: new Date().toISOString() };
  return verificationNotice(verification);
}

const loginStatusCache = new Map<string, { at: number; needsLogin: boolean }>();
const LOGIN_STATUS_TTL_MS = 60_000;

export function clearLoginStatusCache(harnessCommand?: string): void {
  if (harnessCommand) {
    for (const key of loginStatusCache.keys()) {
      if (key.startsWith(`${harnessCommand}:`)) loginStatusCache.delete(key);
    }
  } else {
    loginStatusCache.clear();
  }
}

/** No status command and no credential location declared: there is no
 * reliable signal, so assume logged in rather than force a prompt on a user
 * who already authenticated outside ClikCode. A non-zero exit is treated as logged-out unconditionally (true for
 * every status command checked against real output: Codex, Claude Code); an
 * explicit `loggedIn`/`isAuthenticated: false` in a JSON body catches the ones
 * that report failure with exit 0 instead (Cursor Agent). */
export async function harnessNeedsLogin(harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>): Promise<boolean> {
  // No status command: the credential the vendor keeps on disk, or an API-key
  // variable, is the answer. Cheap enough to read every time, and never stale
  // after a sign-in the way a cached answer would be.
  if (!harness.statusArgv) return hasAuthEvidence(harness) ? !await authEvidencePresent(harness, environment) : false;
  const envKey = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(';');
  const cacheKey = `${harness.command}:${envKey}`;
  const cached = loginStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LOGIN_STATUS_TTL_MS) {
    return cached.needsLogin;
  }
  let stdout: string;
  try {
    stdout = await captureNativeHarnessOutput(harness, harness.statusArgv, environment, 8_000);
  } catch {
    // fail-open-ok: an unverified account must authenticate before it can be selected safely.
    loginStatusCache.set(cacheKey, { at: Date.now(), needsLogin: true });
    return true;
  }
  let needsLogin = false;
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; isAuthenticated?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (parsed.loggedIn === false || parsed.isAuthenticated === false) needsLogin = true;
    }
  } catch { /* not JSON; exit 0 with no verified false-signal means treat as logged in */ }
  loginStatusCache.set(cacheKey, { at: Date.now(), needsLogin });
  return needsLogin;
}

function requireAuthKind(value: string): AiHarnessAuthKind {
  if (value === 'oauth' || value === 'api-key' || value === 'vendor-cli') return value;
  throw new Error('auth kind must be oauth, api-key, or vendor-cli');
}

export async function aiAccountAdd(options: { provider: string; label: string; auth: string; model?: string[]; credentialRef: string }): Promise<void> {
  const provider = options.provider.trim();
  const label = options.label.trim();
  const credentialRef = options.credentialRef.trim();
  if (!provider || !label || !credentialRef) throw new Error('provider, label, and local credential reference are required');
  const auth = requireAuthKind(options.auth);
  if (auth === 'oauth') {
    throw new Error('OAuth accounts must be created through the harness’s own sign-in flow; manual OAuth credential references are not supported.');
  }
  if (auth === 'api-key' && !/^env:[A-Z][A-Z0-9_]*$/.test(credentialRef)) {
    throw new Error('API-key accounts require an env:VARIABLE credential reference; raw provider keys are never stored');
  }
  if (auth !== 'api-key' && !/^(?:keychain|native):[^\s]+$/.test(credentialRef)) {
    throw new Error(`${auth} accounts require a keychain: or native: credential reference; raw credentials are never stored`);
  }
  const harness = localHarnessForProvider(provider);
  if (harness && !harness.localAuth.includes(auth)) throw new Error(`${harness.displayName} does not support local ${auth} accounts`);
  const state = await readState();
  if (state.accounts.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`a local AI account named "${label}" already exists`);
  }
  if (state.accounts.some((account) => account.provider === provider && account.authKind === auth
    && account.credentialRef === credentialRef)) {
    throw new Error(`this ${provider} credential is already connected`);
  }
  const account: AiHarnessAccount = {
    id: randomUUID(), provider, label, authKind: auth, models: [...new Set(options.model ?? [])],
    status: 'ready', credentialRef,
  };
  state.accounts.push(account);
  await writeState(state);
  emitResult({ account: accountView(account), credentialBoundary: 'local-only' });
}

interface AccountRemoveOptions {
  /** Delete the account's profile directory (its vendor credentials). Defaults
   * to true, and only ever applies to a directory ClikCode created under its
   * own profiles root -- anything else is left exactly where it is. */
  purgeProfile?: boolean;
  /** Run the vendor's own logout first, where the catalog declares one.
   * Defaults to true for an isolated profile (the token is about to be deleted
   * anyway; revoking it is the clean end) and false otherwise: an account on
   * the vendor's shared default profile is the user's own CLI login, and
   * removing it from ClikCode must not sign them out of that tool. */
  logout?: boolean;
}

export async function aiAccountRemove(labelOrId: string, options: AccountRemoveOptions = {}): Promise<void> {
  const state = await readState();
  const index = state.accounts.findIndex((account) => account.id === labelOrId || account.label === labelOrId);
  if (index < 0) throw new Error(`local AI account "${labelOrId}" was not found`);
  const [removed] = state.accounts.splice(index, 1);
  const isolated = Boolean(removed.nativeProfile?.path) && 'path' in await resolvePurgeableProfile(removed.nativeProfile!.path);
  let loggedOut = false;
  if (removed.authKind === 'vendor-cli' && (options.logout ?? isolated)) {
    let harness: AiLocalHarnessDefinition | undefined;
    try { harness = localHarnessForProvider(removed.provider); } catch {
      // fail-open-ok: without the catalog there is no declared logout to run; removal itself must still succeed.
      harness = undefined;
    }
    if (harness && harnessCanLogout(harness)) {
      // Best effort and bounded: an offline or already-expired login must
      // never make an account impossible to remove.
      loggedOut = await logoutNativeHarness(harness, profileEnvironment(harness, removed), 10_000)
        .then(() => true, () => false);
    }
  }
  state.sessions = state.sessions.map((session) => session.accountId === removed.id ? { ...session, accountId: null } : session);
  // The registry first, the directory second: a crash in between leaves an
  // orphan directory, never an account pointing at nothing.
  await writeState(state);
  const purged = options.purgeProfile === false ? undefined : await purgeAccountProfile(removed, state.accounts).catch(() => undefined);
  emitHarnessOutput({ panel: 'account-removed', account: removed.label, loggedOut, ...(purged ? { profileRemoved: purged } : {}) });
}
