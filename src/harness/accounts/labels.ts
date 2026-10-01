/** What an account is called: the email its sign-in reveals, read once, when
 * it signs in. Nothing renames an account afterwards -- opening a list of
 * accounts never does. A harness that reveals no email keeps a numbered
 * placeholder ("Kiro CLI 1") or the name the user gave. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { mistralVibeAccountEmail } from './mistral-vibe-identity.js';
import { vendorAccountEmail } from './vendor-identity.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

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
  if (harness.command === 'vibe') return mistralVibeAccountEmail(profilePath);
  const vendorEmail = await vendorAccountEmail(harness, profilePath);
  if (vendorEmail) return vendorEmail;
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
    // No token to decode, no API call: cli-config.json carries a plain
    // authInfo.email. Cursor keeps it under XDG_CONFIG_HOME when that is set
    // -- which every ClikCode account profile sets, so a second account's is
    // <profile>/.config/cursor/cli-config.json -- and in ~/.cursor otherwise.
    // Reading only ~/.cursor left every added account on its placeholder.
    const home = profilePath ?? homedir();
    const config = profilePath ? join(profilePath, '.config') : process.env.XDG_CONFIG_HOME || join(home, '.config');
    for (const path of [join(config, 'cursor', 'cli-config.json'), join(home, '.cursor', 'cli-config.json')]) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { authInfo?: { email?: string } };
        const email = parsed.authInfo?.email;
        if (typeof email === 'string' && email) return email;
      } catch { /* fail-open-ok: try the other place; no derivable info beats a fabricated name. */ }
    }
  }
  if (harness.command === 'gemini') {
    // ~/.gemini/google_accounts.json names the signed-in Google account
    // directly in `active`. Verified against this machine's own file.
    // The profile root keeps the account lookup scoped to this login.
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

/** The one naming rule, applied only when an account signs in or is
 * created: a label is unique among one provider's accounts, ignoring case
 * (the same person's email on two harnesses is two real accounts).
 * `preferred` is the email the sign-in revealed or the name the user gave; a
 * taken one gets " (2)", " (3)", ... Without one, the harness's numbered
 * placeholder: "Codex 2" after removing "Codex 1" of two used to collide with
 * the surviving "Codex 2" (the number was just count + 1), so it is the first
 * number nobody holds. */
export function nameAccount(
  accounts: readonly Pick<AiHarnessAccount, 'id' | 'provider' | 'label'>[],
  harness: Pick<AiLocalHarnessDefinition, 'provider' | 'displayName'>,
  preferred?: string, exceptId?: string,
): string {
  const used = (label: string): boolean => accounts.some((account) => account.id !== exceptId
    && account.provider === harness.provider && account.label.toLowerCase() === label.toLowerCase());
  if (preferred && !used(preferred)) return preferred;
  for (let number = preferred ? 2 : 1; ; number += 1) {
    const candidate = preferred ? `${preferred} (${number})` : `${harness.displayName} ${number}`;
    if (!used(candidate)) return candidate;
  }
}
