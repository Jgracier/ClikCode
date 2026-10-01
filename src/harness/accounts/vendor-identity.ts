/** Signed-in email for the harnesses whose vendor answers "who is this?" --
 * by a command of its own, a field in its own login file, or (OpenHands) the
 * same user endpoint its own CLI calls. Each source below was verified live
 * against a real signed-in account on 2026-09-30. Every reader returns
 * undefined rather than guess: a numbered placeholder beats a wrong name.
 *
 * Harnesses with no entry here were checked too and keep no email anywhere
 * ClikCode can reach: Copilot keeps only a GitHub login (used as its name
 * below), Kimi's token carries a
 * user id only, MiniMax and Qwen store bare tokens, Droid keeps its login in
 * the OS keyring, and Auggie's account status names a plan, not a person.
 * Multi-provider harnesses (OpenCode, Aider, Goose, Pi, Hermes, OpenClaw,
 * Continue, Deep Agents) have no single account to name. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
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
  const parsed = json(text.replace(/^\s*\/\/.*$/gm, '')) as { lastLoggedInUser?: { login?: unknown } } | undefined;
  const login = parsed?.lastLoggedInUser?.login;
  return typeof login === 'string' && login.trim() ? login.trim() : undefined;
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

/** The signed-in email for one of the harnesses above, or undefined. */
export async function vendorAccountEmail(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  const home = profilePath ?? homedir();
  try {
    switch (harness.command) {
      case 'kiro': return parseKiroWhoami(await capture(harness, profilePath, ['whoami', '--format', 'json']));
      case 'kilo': return parseKiloProfile(await capture(harness, profilePath, ['profile', '--json']));
      case 'amp': return parseAmpUsage(await capture(harness, profilePath, ['usage']));
      case 'command': return parseCommandCodeWhoami(await capture(harness, profilePath, ['whoami']));
      case 'devin': return parseDevinAuthStatus(await capture(harness, profilePath, ['auth', 'status']));
      case 'cline': return parseClineProviders(await readFile(join(home, '.cline', 'data', 'settings', 'providers.json'), 'utf8'));
      case 'junie': return parseJunieCredentials(await readFile(join(home, '.junie', 'secure_credentials.json'), 'utf8'));
      case 'openhands': return await openHandsEmail(profilePath);
      case 'copilot': return parseCopilotConfig(await readFile(join(profilePath ?? join(homedir(), '.copilot'), 'config.json'), 'utf8'));
      default: return undefined;
    }
  } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  return undefined;
}
