/** What an account is called. A vendor rarely says, so the label is derived
 * -- sometimes by asking the harness itself, which is why a placeholder can
 * outlive a login and has to be refreshed later. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureNativeHarnessOutput, inspectNativeHarness } from '../transport/native.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition, HarnessState } from '../types.js';

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
/** Whether a label is one ClikCode invented because it could not read a real
 * identity -- the harness's own name, with or without the old " default"
 * suffix. A real label is an email or something the user typed. */
export function isPlaceholderAccountLabel(label: string, harness: AiLocalHarnessDefinition): boolean {
  const name = harness.displayName.toLowerCase();
  const text = label.trim().toLowerCase();
  return text === name || text === `${name} default`;
}

/** Give placeholder-labelled accounts their real names, where the harness can
 * now say what they are. Identity derivation has grown to cover harnesses
 * that had none when their account record was first written, and nothing
 * re-reads it: an account created before its harness was supported keeps the
 * invented name forever otherwise. Returns true when anything changed.
 *
 * Bounded to accounts that still carry a placeholder, so this costs nothing
 * for a state where every account already shows a real identity. */
export async function refreshPlaceholderAccountLabels(state: HarnessState): Promise<boolean> {
  const candidates = state.accounts
    .map((account) => ({ account, harness: localHarnessForProvider(account.provider) }))
    .filter((item): item is { account: AiHarnessAccount; harness: AiLocalHarnessDefinition } =>
      Boolean(item.harness) && isPlaceholderAccountLabel(item.account.label, item.harness!));
  if (!candidates.length) return false;
  // Never install anything to answer a naming question. deriveAccountLabel
  // asks some harnesses (Claude) by running them, and captureNativeHarnessOutput
  // installs a missing binary on the way -- so without this, opening /account
  // could npm-install a harness the user has an old account record for but
  // has not chosen. Installing is for choosing a provider, nothing else.
  const installed = await Promise.all(candidates.map(({ harness }) =>
    inspectNativeHarness(harness, 800).then((item) => item.installed).catch(() => false)));
  const derived = await Promise.all(candidates.map(({ account, harness }, index) =>
    installed[index] ? deriveAccountLabel(harness, account.nativeProfile?.path).catch(() => undefined) : undefined));
  let changed = false;
  for (const [index, { account, harness }] of candidates.entries()) {
    const label = derived[index];
    // Never rename onto a label another account of the SAME provider holds:
    // that would be two records for one identity. Across providers the same
    // email is expected -- one person signs in to Claude and Codex with it --
    // and syncAccountIdentityAfterLogin scopes its own check the same way.
    if (!label || state.accounts.some((item) =>
      item.id !== account.id && item.provider === account.provider && item.label.toLowerCase() === label.toLowerCase())) {
      // Nothing derivable (OpenCode, Copilot, Hermes, Pi, Droid and Amp keep
      // no identity anywhere ClikCode can read). Drop the old " default"
      // suffix anyway: this IS that harness's account, and the suffix made a
      // real connected account read as a placeholder row.
      if (account.label !== harness.displayName) { account.label = harness.displayName; changed = true; }
      continue;
    }
    account.label = label;
    changed = true;
  }
  return changed;
}

export async function deriveAccountLabel(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  if (harness.command === 'claude') {
    try {
      // Asked of the harness, about the account it is running as.
      // `claude auth status` prints JSON carrying this profile's own email
      // (verified live: loggedIn, authMethod, configDirectory, email,
      // orgName, subscriptionType). The catalog already declares this argv as
      // statusArgv, and running it under the account's CLAUDE_CONFIG_DIR is
      // what makes the answer that account's rather than whichever one owns
      // ~/.claude.
      //
      // Earlier versions of this read a credential file directly and then
      // called the vendor's /api/oauth/profile endpoint. The harness answers
      // the same question itself, so neither is needed.
      const status = await captureNativeHarnessOutput(
        harness, ['auth', 'status'], nativeProfileEnvironment(profilePath ? { env: 'CLAUDE_CONFIG_DIR', path: profilePath } : undefined), 15_000,
      );
      const parsed = JSON.parse(status) as { email?: unknown };
      return typeof parsed.email === 'string' && parsed.email ? parsed.email : undefined;
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
  if (harness.command === 'gemini') {
    // ~/.gemini/google_accounts.json names the signed-in Google account
    // directly in `active`. Verified against this machine's own file.
    // Gemini CLI has no profileEnv, so there is one identity at a time --
    // this just makes that one show as itself instead of "Gemini CLI default".
    try {
      const parsed = JSON.parse(await readFile(join(profilePath ?? join(homedir(), '.gemini'), 'google_accounts.json'), 'utf8')) as { active?: unknown };
      return typeof parsed.active === 'string' && parsed.active ? parsed.active : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'grok') {
    // ~/.grok/auth.json is keyed by issuer::uuid, and each entry carries a
    // plain `email` alongside the token. Verified against this machine's own
    // file. Read the entry rather than the key: the key is a user id.
    try {
      const parsed = JSON.parse(await readFile(join(profilePath ?? join(homedir(), '.grok'), 'auth.json'), 'utf8')) as Record<string, { email?: unknown }>;
      for (const entry of Object.values(parsed ?? {})) {
        if (entry && typeof entry.email === 'string' && entry.email) return entry.email;
      }
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

/** Starts the vendor-owned login flow and records only a local opaque profile reference.
 * With no explicit label, the final name is decided *after* login completes: a
 * numbered placeholder is picked first (so an explicit-label caller and duplicate
 * checks upfront still behave as before), but if deriveAccountLabel finds real
 * account info once the credential file actually exists, that replaces the
 * placeholder -- removing the old interactive "Account name [...]" prompt this
 * used to require without falling back to an arbitrary made-up name. */
/** "Codex 2" after removing "Codex 1" of two used to collide with the surviving
 * "Codex 2" (the number was just count + 1) and fail the login with "already
 * exists". The first number nobody holds is always free. */
export function firstUnusedAccountLabel(displayName: string, accounts: readonly Pick<AiHarnessAccount, 'label'>[]): string {
  const taken = new Set(accounts.map((account) => account.label.toLowerCase()));
  for (let number = 1; ; number += 1) {
    const candidate = `${displayName} ${number}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
