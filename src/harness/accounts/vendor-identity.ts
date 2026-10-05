/** Signed-in email for the harnesses whose vendor answers "who is this?" --
 * by a command of its own, a field or a JWT claim in its own login file
 * (Codex, Antigravity, Hermes's Nous login, Droid's decrypted login), its own
 * log (Antigravity fallback), or the same user endpoint its own CLI calls
 * (OpenHands, Mistral Vibe, Auggie's get-models, Command Code's
 * /alpha/whoami, Kimi's /me, MiniMax's /v1/api/user/info). Every reader is
 * read-only: nothing refreshes a token, so Kimi and MiniMax -- whose access
 * tokens live 15 minutes / 1 hour and whose refresh rotates the stored token
 * -- answer only while the token from sign-in is still fresh. Each source was
 * verified live against a real signed-in account, except the email field of
 * Kimi's and MiniMax's endpoints (2026-10-05: route and auth confirmed, but no
 * fresh token existed to read it without rotating the user's). Every reader
 * returns undefined rather than guess: a numbered placeholder beats a wrong
 * name.
 *
 * Checked and not readable: Copilot's token (keyring, `copilot-cli`) has
 * read:user but not user:email, so GET /user shows a private email as null and
 * /user/emails is 404 -- it keeps its GitHub login as its name below. Qwen's
 * API keys name no person. Multi-provider harnesses (OpenCode, Aider, Goose,
 * Pi, OpenClaw, Continue, Crush, Deep Agents) have no single account to name;
 * Hermes is named only by its Nous Portal login. */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { captureMistralVibeCredential, mistralVibeAccountEmail } from './mistral-vibe-identity.js';
import { droidAccountEmail } from './droid-identity.js';
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

/** Kimi Code `GET <base_url>/me` -- the profile call its own CLI makes
 * (`fetchManagedUserInfo`) -- answers {user_id, nickname, ..., email?}. */
export function parseKimiUserInfo(text: string): string | undefined {
  const parsed = json(text) as { user_id?: unknown; email?: unknown } | undefined;
  return typeof parsed?.user_id === 'string' ? email(parsed.email) : undefined;
}

/** The managed provider's base_url in Kimi's config.toml, if one is set. */
export function kimiBaseUrl(configToml: string): string | undefined {
  const section = /^\[providers\."managed:kimi-code"\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(configToml)?.[1];
  const url = section && /^\s*base_url\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  return url && /^https:\/\//.test(url) ? url.replace(/\/+$/, '') : undefined;
}

/** Kimi's OAuth access token lives 15 minutes and every refresh rotates the
 * refresh token too, so this only uses an access token still fresh -- which
 * it is right after sign-in, when an account is named -- and never refreshes:
 * a refresh here would spend the token the CLI holds. */
async function kimiEmail(profilePath: string | undefined): Promise<string | undefined> {
  const home = profilePath ? join(profilePath, '.kimi-code') : process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  const dir = join(home, 'credentials');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json'));
  const config = await readFile(join(home, 'config.toml'), 'utf8').catch(() => '');
  const now = Date.now() / 1000;
  for (const name of names) {
    const record = json(await readFile(join(dir, name), 'utf8').catch(() => '')) as { access_token?: unknown; expires_at?: unknown } | undefined;
    const token = record?.access_token;
    if (typeof token !== 'string' || typeof record?.expires_at !== 'number' || record.expires_at < now + 30) continue;
    const region = jwtClaims(token)?.region;
    const base = kimiBaseUrl(config) ?? (region === 'overseas' ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1');
    const response = await fetch(`${base}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const found = response.ok ? parseKimiUserInfo(await response.text()) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** MiniMax Code `GET /v1/api/user/info` -- the account-identity call its own
 * CLI makes (`fetchAccountIdentity`) -- answers {data:{userInfo:{...}}}; the
 * CLI takes the email from any of these four keys, and so does this. */
export function parseMiniMaxUserInfo(text: string): string | undefined {
  const parsed = json(text) as Record<string, any> | undefined;
  const info = parsed?.data?.userInfo ?? parsed?.data?.user_info ?? parsed?.userInfo ?? parsed?.user_info;
  if (!info || typeof info !== 'object') return undefined;
  for (const key of ['userEmail', 'email', 'userMail', 'user_email']) {
    const found = email(info[key]);
    if (found) return found;
  }
  return undefined;
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

/** MiniMax Code keeps its OAuth record under
 * $HOME/.minimax/auth/<env>/<region>/<client>/auth.json. Its access token
 * lives one hour and a refresh bumps the record's generation (rotating it), so
 * like Kimi this uses only a token still fresh -- right after sign-in -- and
 * never refreshes. The request is signed the way the CLI signs it (md5 of the
 * path and time with the CLI's fixed salts); a request it no longer accepts
 * just names no one. */
async function miniMaxEmail(profilePath: string | undefined): Promise<string | undefined> {
  const root = join(profilePath ?? homedir(), '.minimax', 'auth', 'prod');
  for (const region of ['en', 'cn'] as const) {
    const clients = await readdir(join(root, region)).catch(() => [] as string[]);
    for (const client of clients) {
      const file = json(await readFile(join(root, region, client, 'auth.json'), 'utf8').catch(() => '')) as { records?: Record<string, { accessToken?: unknown; expiresAtMs?: unknown }> } | undefined;
      for (const record of Object.values(file?.records ?? {})) {
        const token = record?.accessToken;
        if (typeof token !== 'string' || typeof record.expiresAtMs !== 'number' || record.expiresAtMs < Date.now() + 30_000) continue;
        const now = Date.now();
        const url = new URL('/v1/api/user/info', region === 'cn' ? 'https://agent.minimaxi.com' : 'https://agent.minimax.io');
        const lang = region === 'cn' ? 'zh' : 'en';
        url.search = new URLSearchParams({
          device_platform: 'mcode', biz_id: '3', app_id: '3001', version_code: '22201', unix: String(now),
          timezone_offset: String(-new Date().getTimezoneOffset() * 60), sys_language: lang, lang, device_id: '0',
          os_name: process.platform, browser_name: 'mcode', user_id: '0', client: 'mcode',
        }).toString();
        const seconds = Math.floor(now / 1000);
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json', 'User-Agent': 'MiniMaxCode', Authorization: `Bearer ${token}`,
            yy: md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_{}${md5(String(now))}ooui`),
            'x-timestamp': String(seconds), 'x-signature': md5(`${seconds}I*7Cf%WZ#S&%1RlZJ&C2`),
          },
          signal: AbortSignal.timeout(15_000),
        });
        const found = response.ok ? parseMiniMaxUserInfo(await response.text()) : undefined;
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** Augment `POST <tenantURL>get-models` -- the configuration call Auggie's
 * own CLI makes at every start, a read -- answers {..., user:{id, email,
 * tenant_id, tenant_name}}; Auggie shows that `user.email` in its banner. */
export function parseAugmentModels(text: string): string | undefined {
  return email((json(text) as { user?: { email?: unknown } } | undefined)?.user?.email);
}

/** $HOME/.augment/session.json is {accessToken, tenantURL, scopes}: a
 * long-lived token, nothing to refresh. Only an augmentcode.com tenant is
 * sent the token. */
async function augmentEmail(profilePath: string | undefined): Promise<string | undefined> {
  const session = json(await readFile(join(profilePath ?? homedir(), '.augment', 'session.json'), 'utf8')) as { accessToken?: unknown; tenantURL?: unknown } | undefined;
  if (typeof session?.accessToken !== 'string' || typeof session.tenantURL !== 'string') return undefined;
  const tenant = new URL(session.tenantURL);
  if (tenant.protocol !== 'https:' || !/(^|\.)augmentcode\.com$/.test(tenant.hostname)) return undefined;
  const response = await fetch(new URL('get-models', tenant.href.endsWith('/') ? tenant.href : `${tenant.href}/`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseAugmentModels(await response.text()) : undefined;
}

/** Command Code `GET /alpha/whoami` -- the API its own `cmdc whoami` reads,
 * which prints only the name -- answers {success, user:{id, name, email,
 * userName}, org}. */
export function parseCommandCodeApiWhoami(text: string): string | undefined {
  return email((json(text) as { user?: { email?: unknown } } | undefined)?.user?.email);
}

/** $HOME/.commandcode/auth.json's apiKey: a long-lived key, nothing refreshed. */
async function commandCodeEmail(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  const auth = json(await readFile(join(profilePath ?? homedir(), '.commandcode', 'auth.json'), 'utf8').catch(() => '')) as { apiKey?: unknown } | undefined;
  if (typeof auth?.apiKey === 'string' && auth.apiKey) {
    const response = await fetch('https://api.commandcode.ai/alpha/whoami', {
      headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    const found = response?.ok ? parseCommandCodeApiWhoami(await response.text()) : undefined;
    if (found) return found;
  }
  return parseCommandCodeWhoami(await capture(harness, profilePath, ['whoami']));
}

/** Hermes's auth.json keeps the Nous Portal OAuth login under
 * providers.nous; its access_token is a JWT issued by the portal carrying the
 * account's `email` (read live 2026-10-05). Only the Nous login is read: the
 * other providers Hermes can hold are model keys, not this account. An
 * expired token still names who signed in. */
export function parseHermesNousAuth(authJson: string): string | undefined {
  const nous = (json(authJson) as { providers?: { nous?: { access_token?: unknown } } } | undefined)?.providers?.nous;
  const claims = jwtClaims(nous?.access_token);
  return typeof claims?.iss === 'string' && /^https:\/\/portal\.nousresearch\.com\/?$/.test(claims.iss) ? text(claims.email) : undefined;
}

/** Codex's auth.json id_token is a standard OIDC JWT whose payload carries an
 * `email` claim. Decoding the payload to read a claim is not verifying the
 * signature, and need not be: this is display of a claim from a credential
 * file already trusted to authenticate real requests, profile-scoped by
 * CODEX_HOME like the rest of the file. */
export function codexIdTokenEmail(authJson: string): string | undefined {
  const claims = jwtClaims((json(authJson) as { tokens?: { id_token?: unknown } } | undefined)?.tokens?.id_token);
  return text(claims?.email);
}

/** The payload of a JWT, decoded but (deliberately, see above) not verified. */
function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!payload) return undefined;
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const claims = json(Buffer.from(padded, 'base64url').toString('utf8'));
  return claims && typeof claims === 'object' ? claims as Record<string, unknown> : undefined;
}

/** $HOME/.gemini/antigravity-cli/antigravity-oauth-token is JSON
 * {token:{access_token,token_type,refresh_token,expiry},auth_method,id_token}.
 * `id_token` is Google's OIDC token from the same sign-in; its `email` claim
 * names the account (checked live against every profile's log line: equal,
 * and newer than a stale log line where the profile once held another
 * account). Read regardless of `exp`: an expired token still names who
 * signed in, and the file is replaced on the next sign-in. */
export function antigravityIdTokenEmail(tokenJson: string): string | undefined {
  const claims = jwtClaims((json(tokenJson) as { id_token?: unknown } | undefined)?.id_token);
  if (claims?.iss !== 'https://accounts.google.com' && claims?.iss !== 'accounts.google.com') return undefined;
  return claims.email_verified === false ? undefined : text(claims.email);
}

/** Antigravity: the id_token in its OAuth token file first (above). Its
 * settings.json, jetski_state.pbtxt and project id file are byte-identical
 * across accounts. As a fallback for a token file without an id_token, its
 * own log: `server_oauth.go` logs "OAuth: authenticated successfully as
 * <email>" on a full sign-in -- not when the sign-in stops agy as soon as
 * the token file appears, hence the token file first. A
 * profile path IS the isolated $HOME, and agy writes under $HOME/.gemini
 * either way. The log is flushed by a background server after the awaited
 * client exits -- measured live needing several seconds -- so the newest few
 * logs are re-read for a while rather than once. */
async function antigravityEmail(profilePath: string | undefined): Promise<string | undefined> {
  const tokenFile = join(profilePath ?? homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const fromToken = await readFile(tokenFile, 'utf8').then(antigravityIdTokenEmail, () => undefined);
  if (fromToken) return fromToken;
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
  command: commandCodeEmail,
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
  kimi: (_harness, profilePath) => kimiEmail(profilePath),
  mcode: (_harness, profilePath) => miniMaxEmail(profilePath),
  droid: (_harness, profilePath) => droidAccountEmail(profilePath),
  auggie: (_harness, profilePath) => augmentEmail(profilePath),
  // HERMES_HOME is the profile itself; auth.json sits at its root.
  hermes: read((profilePath) => [join(profilePath ?? (process.env.HERMES_HOME || join(homedir(), '.hermes')), 'auth.json')], parseHermesNousAuth),
};

/** Harnesses whose login can leave the API key outside the account's own
 * profile: this copies it in, true when it did. Mistral Vibe's `--setup` may
 * keep it in the OS keyring, shared by every profile; it is written into the
 * profile's own .env instead. */
const CREDENTIAL_CAPTURE: Readonly<Partial<Record<string, (profilePath: string) => Promise<boolean>>>> = {
  vibe: captureMistralVibeCredential,
};

export function vendorCredentialCapture(harness: AiLocalHarnessDefinition): ((profilePath: string) => Promise<boolean>) | undefined {
  return CREDENTIAL_CAPTURE[harness.command];
}

/** The signed-in email for one of the harnesses in IDENTITY, or undefined. */
export async function vendorAccountEmail(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  try {
    return await IDENTITY[harness.command]?.(harness, profilePath);
  } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  return undefined;
}
