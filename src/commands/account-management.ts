/** Local account lifecycle: list/add/remove/login/logout, deriving a
 * human-readable label from each vendor's own credential/profile data where
 * a real, verified way exists (never guessed), and the reactive
 * "does this look like it needs a login?" check used before giving up on a
 * failed turn. No terminal UI -- writes go straight to stdout/emitJson, the
 * same as every other headless-callable ai* function. */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import { emitJson } from '../utils/structured-output.js';
import {
  captureNativeHarnessOutput, ensureNativeHarness, inspectNativeHarness, loginNativeHarness, runNativeHarnessCommand,
} from './native-harness.js';
import { localHarnessForCommand, localHarnessForProvider, localRouter, nativeProfileEnvironment } from './native-harness-protocol.js';
import { accountView, harnessCommand, harnessStatePath, readState, writeState } from './harness-state.js';
import { accountUsageLabel } from './native-account-data.js';
import type { AiHarnessAccount, AiHarnessAuthKind, AiLocalHarnessDefinition, HarnessState } from './types.js';

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
  })));
  emitJson({ accounts });
}

/** Lists the normalized local account surfaces without probing provider credentials. */
export async function aiAccountProviders(): Promise<void> {
  emitJson({ harnesses: localRouter().AI_LOCAL_HARNESSES });
}

/** Read-only compatibility report for every catalog entry. */
export async function aiDoctor(): Promise<void> {
  const harnesses = await Promise.all(localRouter().AI_LOCAL_HARNESSES.map(async (harness) => {
    const inspection = await inspectNativeHarness(harness);
    return {
      command: harness.command,
      displayName: harness.displayName,
      provider: harness.provider,
      surface: harness.surface,
      binary: harness.binary,
      install: harness.npmPackage
        ? { kind: 'npm' as const, package: harness.npmPackage, automatic: true }
        : { kind: 'vendor-managed' as const, automatic: false, note: `ClikCode has no publisher to install from; put a \`${harness.binary}\` binary on PATH using ${harness.displayName}'s own installer.` },
      ...inspection,
      capabilities: {
        centralizedTurns: Boolean(harness.turn),
        login: Boolean(harness.loginArgv),
        accountStatus: Boolean(harness.statusArgv),
        logout: Boolean(harness.logoutArgv),
        isolatedProfiles: Boolean(harness.profileEnv),
        modelSelection: Boolean(harness.modelArgvPrefix),
        workspaceSelection: Boolean(harness.workspaceArgvPrefix),
        effortSelection: Boolean(harness.effortArgvPrefix),
        permissionModeSelection: (harness.permissionModes?.length ?? 0) > 0,
        permissionModes: harness.permissionModes ?? [],
        exactResume: Boolean(harness.session?.resumeIdPrefix),
        automaticSessionIdentity: Boolean(harness.session?.createIdPrefix || harness.session?.createSessionArgv || harness.session?.discoverArgv),
        continueLatest: Boolean(harness.session?.continueArgv),
      },
    };
  }));
  emitJson({ adapterVersion: localRouter().AI_LOCAL_HARNESS_ADAPTER_VERSION, harnesses });
}

/** Reads real account info out of a harness's own credential storage right
 * after login -- verified so far only for Claude Code, whose
 * ~/.claude/.credentials.json (or the isolated profile path, if this
 * harness supports multiple accounts) carries a real `subscriptionType`
 * field (checked directly against a live file earlier: no email/name field
 * exists there, but the subscription tier does, and it's real account
 * info, not a guess). Returns undefined -- never a fabricated name -- for
 * every harness without a confirmed credential shape to read, which is
 * every other one right now; the numbered placeholder below covers those.
 */
export async function deriveAccountLabel(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  if (harness.command === 'claude') {
    try {
      const path = join(profilePath ?? join(homedir(), '.claude'), '.credentials.json');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (!token) return undefined;
      // subscriptionType duplicated the provider's own display name right
      // next to itself ("Claude Code (pro)" sitting beside "Claude Code" in
      // the status line and picker) without actually distinguishing one
      // account from another with the same plan. /api/oauth/profile is a
      // real endpoint (verified directly: returns this exact token's own
      // account.email) -- and since the token itself is already confirmed
      // profile-scoped (it comes from this account's own, possibly
      // CLAUDE_CONFIG_DIR-isolated, credentials file), the email it returns
      // is guaranteed specific to *this* account, not shared across every
      // Claude Code account the way a file outside that isolated directory
      // (~/.claude.json, sibling to the redirectable ~/.claude/ folder --
      // checked, and its own OAuth path isn't confirmed to move with
      // CLAUDE_CONFIG_DIR) would have been.
      const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { account?: { email?: string } };
      return typeof body.account?.email === 'string' && body.account.email ? body.account.email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'codex') {
    try {
      const path = join(profilePath ?? join(homedir(), '.codex'), 'auth.json');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { tokens?: { id_token?: string } };
      const idToken = parsed.tokens?.id_token;
      if (!idToken) return undefined;
      // No API call needed here, unlike Claude: Codex's id_token is a
      // standard OIDC JWT and its payload already carries a real `email`
      // claim directly -- verified against this exact file's own token.
      // Decoding the payload to read a claim isn't the same as verifying
      // the token's signature (not needed here; this is read-only display
      // of a claim from a credential file already trusted enough to
      // authenticate real requests with), and the payload segment is
      // profile-scoped the same way the whole auth.json file is (CODEX_HOME
      // isolation, verified from this catalog entry's own profileEnv).
      const payload = idToken.split('.')[1];
      if (!payload) return undefined;
      const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as { email?: string };
      return typeof claims.email === 'string' && claims.email ? claims.email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'cursor') {
    // Simplest of the three so far: no token to decode, no API call --
    // ~/.cursor/cli-config.json carries a real, plain-text authInfo.email
    // field directly. No profileEnv exists for Cursor (confirmed against
    // its own catalog entry), so this file is always at the one fixed path
    // regardless of account -- meaning, same as Gemini/OpenCode/Amp, only
    // one real Cursor identity can be tracked at a time today; this just
    // means that one identity shows correctly instead of as "Cursor Agent
    // default".
    try {
      const parsed = JSON.parse(await readFile(join(homedir(), '.cursor', 'cli-config.json'), 'utf8')) as { authInfo?: { email?: string } };
      const email = parsed.authInfo?.email;
      return typeof email === 'string' && email ? email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'antigravity') {
    // No credentials file anywhere in its config tree carries an email --
    // checked settings.json, jetski_state.pbtxt, the default project id
    // file, all confirmed byte-identical across accounts. The real,
    // authenticated identity only ever surfaces in its own log output:
    // `server_oauth.go` logs `OAuth: authenticated successfully as
    // <email>` on every successful login, confirmed live against a real
    // one. Reading the most-recently-modified log file (one gets written
    // per invocation) after the login turn just completed is the only way
    // to recover this -- this is also what makes "endless accounts without
    // conflict" actually work here: the aiAccountLogin dedup below already
    // reuses an existing account when a freshly derived label matches one,
    // so a login that resolves to the same real email in a new profile
    // directory collapses back into the one account it actually is,
    // instead of leaving an indistinguishable duplicate behind.
    try {
      // profilePath, when set, IS the isolated $HOME itself (not a
      // pre-built ".../.gemini" root the way the claude/codex branches
      // above use profilePath) -- agy still writes under $HOME/.gemini
      // regardless of what $HOME points to, so .gemini has to be appended
      // here too, not just in the un-isolated fallback. Missed this the
      // first time: the manual verification that "confirmed" this path
      // matched real content had the correct path hardcoded by hand,
      // never actually exercising this line.
      const logDir = join(profilePath ?? homedir(), '.gemini', 'antigravity-cli', 'log');
      // Confirmed live: the CLI process loginNativeHarness awaits exits
      // before this log line is actually flushed to disk -- its own log
      // shows a background daemon/server handling the real login work
      // ("Language server shutting down", "RemoteControl" server) whose
      // lifecycle isn't the same as the thin client process being awaited,
      // so this is a genuine cross-process flush delay, not a logic bug
      // (the identical read succeeded immediately when re-checked by hand
      // a few seconds later). A generous retry window covers that without
      // a fixed sleep on the common case where the write already landed --
      // measured live needing several seconds, not the ~1.6s first tried.
      for (let attempt = 0; attempt < 12; attempt++) {
        const entries = await readdir(logDir, { withFileTypes: true }).catch(() => []);
        const logs = (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.log')).map(async (entry) => {
          const full = join(logDir, entry.name);
          const info = await stat(full).catch(() => undefined);
          return info ? { full, mtime: info.mtimeMs } : undefined;
        }))).filter((item): item is { full: string; mtime: number } => Boolean(item)).sort((left, right) => right.mtime - left.mtime);
        for (const { full } of logs.slice(0, 3)) {
          const content = await readFile(full, 'utf8').catch(() => '');
          const match = /OAuth: authenticated successfully as ([^\s,]+@[^\s,]+)/.exec(content);
          if (match) return match[1];
        }
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 600));
      }
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  return undefined;
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
  const derived = await deriveAccountLabel(harness, account.nativeProfile?.path);
  if (!derived || derived.toLowerCase() === account.label.toLowerCase()) {
    await writeState(state);
    return account;
  }
  const existingMatch = state.accounts.find(
    (item) => item.id !== account.id && item.provider === harness.provider && item.label.toLowerCase() === derived.toLowerCase(),
  );
  if (existingMatch) {
    // The login just completed authenticated as a DIFFERENT real account
    // ClikCode already has a record for -- merge into that one (repoint its
    // nativeProfile at this fresh login, since the old one may be stale)
    // instead of leaving two records for the same real identity.
    existingMatch.status = 'ready';
    if (account.nativeProfile) existingMatch.nativeProfile = account.nativeProfile;
    state.accounts = state.accounts.filter((item) => item.id !== account.id);
    await writeState(state);
    return existingMatch;
  }
  account.label = derived;
  await writeState(state);
  return account;
}

/** Starts the vendor-owned login flow and records only a local opaque profile reference.
 * With no explicit label, the final name is decided *after* login completes: a
 * numbered placeholder is picked first (so an explicit-label caller and duplicate
 * checks upfront still behave as before), but if deriveAccountLabel finds real
 * account info once the credential file actually exists, that replaces the
 * placeholder -- removing the old interactive "Account name [...]" prompt this
 * used to require without falling back to an arbitrary made-up name. */
export async function aiAccountLogin(harnessCommandName: string, label?: string): Promise<string> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const placeholder = `${harness.displayName} ${existingForProvider + 1}`;
  const explicit = label?.trim();
  let accountLabel = explicit || placeholder;
  if (!accountLabel) throw new Error('account label cannot be empty');
  const existing = state.accounts.find((account) => account.label.toLowerCase() === accountLabel.toLowerCase());
  if (existing) throw new Error(`a local AI account named "${accountLabel}" already exists`);
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
    if (!explicit) {
      const derived = await deriveAccountLabel(harness, undefined);
      if (derived && !state.accounts.some((account) => account.id !== singleSlotExisting.id && account.label.toLowerCase() === derived.toLowerCase())) {
        singleSlotExisting.label = derived;
      }
    }
    singleSlotExisting.status = 'ready';
    await writeState(state);
    emitHarnessOutput({ status: 'connected', harness: harness.command, account: singleSlotExisting.label, credentialBoundary: 'local-only' });
    return singleSlotExisting.label;
  }
  const accountId = randomUUID();
  const profilePath = harness.profileEnv
    ? join(harnessStatePath(), '..', 'profiles', harness.command, accountId)
    : undefined;
  if (profilePath) await mkdir(profilePath, { recursive: true, mode: 0o700 });
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
  let loginError: unknown;
  try {
    await loginNativeHarness(harness, nativeProfileEnvironment(nativeProfile));
  } catch (error) {
    // Antigravity's login command (-p 'hi' ...) doesn't just verify
    // authentication -- it also runs a real chat turn, so ANY unrelated
    // failure in that turn (quota, rate limit, a transient API error) exits
    // non-zero and looks identical to authentication itself having failed.
    // Discarding a login this eagerly threw away real, successful OAuth
    // sessions whenever the account happened to be rate-limited. Hold the
    // error and check independently, via the log Antigravity itself writes
    // on successful auth, whether authentication actually succeeded despite
    // the verification turn failing -- only surface the error if it didn't.
    if (harness.command !== 'antigravity' || !profilePath) throw error;
    loginError = error;
  }
  // An explicit label means derivation below never runs, so there is no
  // independent way to confirm auth actually succeeded despite the error --
  // surface it rather than silently treat a real failure as success.
  if (explicit && loginError) throw loginError;
  if (!explicit) {
    const derived = await deriveAccountLabel(harness, profilePath);
    if (!derived && loginError) throw loginError;
    if (derived) {
      // A derived identity matching an account that already exists means
      // this is the SAME real account signing in again -- not a new one --
      // even though the login flow just created a brand-new isolated
      // profile directory to get here (there's no way to know who's behind
      // a login before actually completing it). Previously this only
      // skipped renaming to the derived label in that case and fell
      // through to pushing a duplicate anyway under the numbered
      // placeholder -- the exact "logged in with the same email, it
      // created a new one and left the old one" bug. Now it reuses the
      // existing account outright: repoints its nativeProfile at the fresh
      // login (the old profile directory may be stale/expired) instead of
      // creating anything new, and the just-created directory above is
      // simply orphaned rather than referenced by two accounts.
      const existingMatch = state.accounts.find((account) => account.provider === harness.provider && account.label.toLowerCase() === derived.toLowerCase());
      if (existingMatch) {
        existingMatch.status = 'ready';
        if (nativeProfile) existingMatch.nativeProfile = nativeProfile;
        await writeState(state);
        emitHarnessOutput({ status: 'connected', harness: harness.command, account: existingMatch.label, credentialBoundary: 'local-only' });
        return existingMatch.label;
      }
      accountLabel = derived;
    }
  }
  if (!state.accounts.some((account) => account.label.toLowerCase() === accountLabel.toLowerCase())) {
    state.accounts.push({ id: accountId, provider: harness.provider, label: accountLabel, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${harness.binary}`, ...(nativeProfile ? { nativeProfile } : {}) });
    await writeState(state);
  }
  emitHarnessOutput({ status: 'connected', harness: harness.command, account: accountLabel, credentialBoundary: 'local-only' });
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
export function announceBareInteractiveLogin(harness: AiLocalHarnessDefinition): void {
  if (harness.loginArgv?.length === 0) {
    output.write(`\n${chalk.dim(`Opening ${harness.displayName}'s own interactive session to sign in -- exit it (its own quit/Ctrl+C) once done to return here.`)}\n\n`);
  }
}

export function nativeAccountContext(state: HarnessState, labelOrId: string): { account: AiHarnessAccount; harness: AiLocalHarnessDefinition; environment: Record<string, string> } {
  const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
  if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
  if (account.authKind !== 'vendor-cli') throw new Error(`account "${account.label}" is not owned by a vendor CLI`);
  const harness = localHarnessForProvider(account.provider);
  if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
  const environment = nativeProfileEnvironment(account.nativeProfile);
  return { account, harness, environment };
}

export async function aiAccountStatus(labelOrId: string): Promise<void> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harness.statusArgv) throw new Error(`${harness.displayName} does not publish a non-destructive account-status command`);
  const nativeStatus = (await captureNativeHarnessOutput(harness, harness.statusArgv, environment)).trim();
  const usage = await accountUsageLabel(account, state);
  emitJson({ account: { ...accountView(account), usage }, nativeStatus, credentialBoundary: 'local-only' });
}

export async function aiAccountLogout(labelOrId: string): Promise<void> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harness.logoutArgv) throw new Error(`${harness.displayName} does not publish a non-interactive logout command`);
  await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
  account.status = 'needs_login';
  await writeState(state);
  emitJson({ account: accountView(account), loggedOut: true, credentialBoundary: 'local-only' });
}

/** No status command published: there is no reliable signal, so assume logged
 * in rather than force a prompt on a user who already authenticated outside
 * ClikCode. A non-zero exit is treated as logged-out unconditionally (true for
 * every status command checked against real output: Codex, Claude Code); an
 * explicit `loggedIn`/`isAuthenticated: false` in a JSON body catches the ones
 * that report failure with exit 0 instead (Cursor Agent). */
export async function harnessNeedsLogin(harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>): Promise<boolean> {
  if (!harness.statusArgv) return false;
  let stdout: string;
  try {
    stdout = await captureNativeHarnessOutput(harness, harness.statusArgv, environment, 8_000);
  } catch {
    // fail-open-ok: an unverified account must authenticate before it can be selected safely.
    return true;
  }
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; isAuthenticated?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (parsed.loggedIn === false || parsed.isAuthenticated === false) return true;
    }
  } catch { /* not JSON; exit 0 with no verified false-signal means treat as logged in */ }
  return false;
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
  const account: AiHarnessAccount = {
    id: randomUUID(), provider, label, authKind: auth, models: [...new Set(options.model ?? [])],
    status: 'ready', credentialRef,
  };
  state.accounts.push(account);
  await writeState(state);
  emitJson({ account: accountView(account), credentialBoundary: 'local-only' });
}

export async function aiAccountRemove(labelOrId: string): Promise<void> {
  const state = await readState();
  const index = state.accounts.findIndex((account) => account.id === labelOrId || account.label === labelOrId);
  if (index < 0) throw new Error(`local AI account "${labelOrId}" was not found`);
  const [removed] = state.accounts.splice(index, 1);
  state.sessions = state.sessions.map((session) => session.accountId === removed.id ? { ...session, accountId: null } : session);
  await writeState(state);
  emitHarnessOutput({ panel: 'account-removed', account: removed.label });
}
