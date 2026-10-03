/** Signed-in email for the harnesses whose vendor answers "who is this?" --
 * by a command of its own, a field in its own login file, its own log
 * (Antigravity), or (OpenHands, Mistral Vibe) the same user endpoint its own
 * CLI calls. Each source below was verified live against a real signed-in
 * account. Every reader returns
 * undefined rather than guess: a numbered placeholder beats a wrong name.
 *
 * Harnesses with no entry here were checked too and keep no email anywhere
 * ClikCode can reach: Copilot keeps only a GitHub login (used as its name
 * below), Kimi's token carries a
 * user id only, MiniMax and Qwen store bare tokens, Droid keeps its login in
 * the OS keyring, and Auggie's account status names a plan, not a person.
 * Multi-provider harnesses (OpenCode, Aider, Goose, Pi, Hermes, OpenClaw,
 * Continue, Deep Agents) have no single account to name. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { mistralVibeAccountEmail } from './mistral-vibe-identity.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANSI = /\u001b\[[0-9;]*m/g;

function email(value: unknown): string | undefined {
  return typeof value === 'string' && EMAIL.test(value.trim()) ? value.trim() : undefined;
}

/** First `<label> <email>` line in human-readable status output. */
function emailAfter(text: string, label: RegExp): string | undefined {
  for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
    const match = label.exec(line);
    if (match) return email(line.slice(match.index + match[0].length).trim().split(/\s+/)[0]);
  }
  return undefined;
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The email field of a vendor record. Reject malformed values instead of
 * making them account names or deduplication keys. */
function text(value: unknown): string | undefined {
  return email(value);
}

/** `kiro-cli whoami --format json` -> {"accountType":"SocialGoogle","email":...}.
 * Builder ID and IAM Identity Center logins may answer without one. */
export function parseKiroWhoami(text: string): string | undefined {
  return email((json(text) as { email?: unknown } | undefined)?.email);
}

/** `kilo profile --json` -> {"name","email","team","organizationId","balance"}. */
export function parseKiloProfile(text: string): string | undefined {
  return email((json(text) as { email?: unknown } | undefined)?.email);
}

/** `amp usage` opens with "Signed in as <email>". */
export function parseAmpUsage(text: string): string | undefined {
  return emailAfter(text, /Signed in as\s+/i);
}

/** `cmdc whoami` prints "i Email: <email>" among Name/Username lines. */
export function parseCommandCodeWhoami(text: string): string | undefined {
  return emailAfter(text, /\bEmail:\s*/);
}

/** `devin auth status` prints a User section with "Email: <email>". */
export function parseDevinAuthStatus(text: string): string | undefined {
  return emailAfter(text, /^\s*Email:\s*/);
}

/** ~/.cline/data/settings/providers.json: the Cline account's own OAuth
 * metadata carries userInfo.email. Other providers configured in the same
 * file are model keys, not the Cline login, so only `cline` is read. */
export function parseClineProviders(text: string): string | undefined {
  const parsed = json(text) as { providers?: { cline?: { settings?: { auth?: { metadata?: { userInfo?: { email?: unknown } } } } } } } | undefined;
  return email(parsed?.providers?.cline?.settings?.auth?.metadata?.userInfo?.email);
}

/** ~/.junie/secure_credentials.json: secrets[] holds `jb-account-stored`,
 * whose secret is itself JSON carrying the JetBrains account's email. */
export function parseJunieCredentials(text: string): string | undefined {
  const parsed = json(text) as { secrets?: { key?: unknown; secret?: unknown }[] } | undefined;
  const stored = parsed?.secrets?.find((item) => item?.key === 'jb-account-stored')?.secret;
  if (typeof stored !== 'string') return undefined;
  return email((json(stored) as { jbAccount?: { email?: unknown } } | undefined)?.jbAccount?.email);
}

/** COPILOT_HOME/config.json (comment lines allowed): the GitHub user this
 * profile signed in as. Copilot keeps no email anywhere local -- its token is
 * in the system keyring -- so the account is named by its GitHub login, which
 * still tells two accounts apart and merges a repeat sign-in of the same one. */
export function parseCopilotConfig(text: string): string | undefined {
  const parsed = json(text.replace(/^\s*\/\/.*$/gm, '')) as { lastLoggedInUser?: { login?: unknown; host?: unknown } } | undefined;
  const login = parsed?.lastLoggedInUser?.login;
  if (typeof login !== 'string' || !login.trim()) return undefined;
  const host = parsed?.lastLoggedInUser?.host;
  if (typeof host !== 'string' || !host.trim()) return login.trim();
  try {
    const name = new URL(host).hostname.toLowerCase();
    return name === 'github.com' ? login.trim() : `${login.trim()}@${name}`;
  } catch { return undefined; }
}

/** OpenHands Cloud `GET /api/v1/users/me` -- the endpoint openhands_cli's own
 * api_client calls -- returns the user's settings including `email`. */
export function parseOpenHandsUser(text: string): string | undefined {
  return email((json(text) as { email?: unknown } | undefined)?.email);
}

async function capture(harness: AiLocalHarnessDefinition, profilePath: string | undefined, argv: readonly string[]): Promise<string> {
  const env = profilePath && harness.profileEnv ? nativeProfileEnvironment({ env: harness.profileEnv, path: profilePath }) : {};
  return captureNativeHarnessOutput(harness, argv, env, 15_000);
}

async function openHandsEmail(profilePath: string | undefined): Promise<string | undefined> {
  const dir = process.env.OPENHANDS_PERSISTENCE_DIR && !profilePath
    ? process.env.OPENHANDS_PERSISTENCE_DIR
    : join(profilePath ?? homedir(), '.openhands');
  const key = (await readFile(join(dir, 'cloud', 'api_key.txt'), 'utf8')).trim();
  if (!key) return undefined;
  const base = (process.env.OPENHANDS_CLOUD_URL || 'https://app.all-hands.dev').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseOpenHandsUser(await response.text()) : undefined;
}

/** Codex's auth.json id_token is a standard OIDC JWT whose payload carries an
 * `email` claim. Decoding the payload to read a claim is not verifying the
 * signature, and need not be: this is display of a claim from a credential
 * file already trusted to authenticate real requests, profile-scoped by
 * CODEX_HOME like the rest of the file. */
export function codexIdTokenEmail(authJson: string): string | undefined {
  const payload = (json(authJson) as { tokens?: { id_token?: string } } | undefined)?.tokens?.id_token?.split('.')[1];
  if (!payload) return undefined;
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return text((json(Buffer.from(padded, 'base64url').toString('utf8')) as { email?: unknown } | undefined)?.email);
}

/** Antigravity keeps no email in any file of its config tree (settings.json,
 * jetski_state.pbtxt and the project id file are byte-identical across
 * accounts). Its identity surfaces only in its own log: `server_oauth.go`
 * logs "OAuth: authenticated successfully as <email>" on every sign-in. A
 * profile path IS the isolated $HOME, and agy writes under $HOME/.gemini
 * either way. The log is flushed by a background server after the awaited
 * client exits -- measured live needing several seconds -- so the newest few
 * logs are re-read for a while rather than once. */
async function antigravityEmail(profilePath: string | undefined): Promise<string | undefined> {
  const logDir = join(profilePath ?? homedir(), '.gemini', 'antigravity-cli', 'log');
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
  return undefined;
}

type IdentitySource = (harness: AiLocalHarnessDefinition, profilePath: string | undefined) => Promise<string | undefined>;

/** Ask the harness itself, under the account's own profile variable. */
const ask = (argv: readonly string[], parse: (output: string) => string | undefined): IdentitySource =>
  async (harness, profilePath) => parse(await capture(harness, profilePath, argv));

/** Read the harness's own file -- the first of `paths` that parses to a name. */
const read = (paths: (profilePath: string | undefined) => string[], parse: (contents: string) => string | undefined): IdentitySource =>
  async (_harness, profilePath) => {
    for (const path of paths(profilePath)) {
      const found = await readFile(path, 'utf8').then(parse, () => undefined);
      if (found) return found;
    }
    return undefined;
  };

/** `profilePath` when the account has one, else the vendor's default directory. */
const under = (profilePath: string | undefined, fallback: string): string => profilePath ?? join(homedir(), fallback);

const IDENTITY: Readonly<Partial<Record<string, IdentitySource>>> = {
  // `claude auth status` prints JSON with this profile's own email.
  claude: ask(['auth', 'status'], (output) => text((json(output) as { email?: unknown } | undefined)?.email)),
  kiro: ask(['whoami', '--format', 'json'], parseKiroWhoami),
  kilo: ask(['profile', '--json'], parseKiloProfile),
  amp: ask(['usage'], parseAmpUsage),
  command: ask(['whoami'], parseCommandCodeWhoami),
  devin: ask(['auth', 'status'], parseDevinAuthStatus),
  codex: read((profilePath) => [join(under(profilePath, '.codex'), 'auth.json')], codexIdTokenEmail),
  // google_accounts.json names the signed-in Google account in `active`.
  gemini: read((profilePath) => [join(profilePath ?? homedir(), '.gemini', 'google_accounts.json')],
    (contents) => text((json(contents) as { active?: unknown } | undefined)?.active)),
  // auth.json is keyed by issuer::uuid; each entry carries a plain `email`.
  grok: read((profilePath) => [join(profilePath ?? homedir(), '.grok', 'auth.json')], (contents) => {
    const entries = Object.values((json(contents) ?? {}) as Record<string, { email?: unknown } | null>);
    const emails = [...new Set(entries.map((entry) => text(entry?.email)?.toLowerCase()).filter((value): value is string => Boolean(value)))];
    return emails.length === 1 ? emails[0] : undefined;
  }),
  // cli-config.json's authInfo.email, under XDG_CONFIG_HOME when that is set
  // -- which every ClikCode account profile sets -- and in ~/.cursor otherwise.
  cursor: read((profilePath) => {
    const home = profilePath ?? homedir();
    const config = profilePath ? join(profilePath, '.config') : process.env.XDG_CONFIG_HOME || join(home, '.config');
    return [join(config, 'cursor', 'cli-config.json'), join(home, '.cursor', 'cli-config.json')];
  }, (contents) => text((json(contents) as { authInfo?: { email?: unknown } } | undefined)?.authInfo?.email)),
  cline: read((profilePath) => [join(profilePath ?? homedir(), '.cline', 'data', 'settings', 'providers.json')], parseClineProviders),
  junie: read((profilePath) => [join(profilePath ?? homedir(), '.junie', 'secure_credentials.json')], parseJunieCredentials),
  copilot: read((profilePath) => [join(under(profilePath, '.copilot'), 'config.json')], parseCopilotConfig),
  openhands: (_harness, profilePath) => openHandsEmail(profilePath),
  vibe: (_harness, profilePath) => mistralVibeAccountEmail(profilePath),
  antigravity: (_harness, profilePath) => antigravityEmail(profilePath),
};

/** The signed-in email for one of the harnesses above, or undefined. */
export async function vendorAccountEmail(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  try {
    return await IDENTITY[harness.command]?.(harness, profilePath);
  } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  return undefined;
}
