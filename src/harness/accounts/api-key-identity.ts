/** The email behind an API key, for naming an API-key account when it is
 * added -- read with that key through a read-only "who am I" call, where the
 * key's vendor has one. Which vendor issued the key is told first by the
 * environment variable holding it (an Aider account on OPENAI_API_KEY holds
 * an OpenAI key), then by the account's provider (a key under a name the user
 * chose). Every reader returns undefined rather than guess -- no name is made
 * from an org, team or user id -- and the account keeps its placeholder.
 * What was checked per vendor is recorded in vendor-identity.ts's header. */

import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { parseAmpUsage, parseCommandCodeApiWhoami, parseKimiUserInfo } from './vendor-identity.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value: unknown): string | undefined {
  return typeof value === 'string' && EMAIL.test(value.trim()) ? value.trim() : undefined;
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** OpenAI `GET /v1/me` (OpenAI help article 9132009: "view the users or
 * organizations associated with an API key") -> {object:"user", id, email,
 * name, orgs}. A service-account key has no user and names no one. */
export function parseOpenAiMe(text: string): string | undefined {
  const parsed = json(text) as { object?: unknown; email?: unknown } | undefined;
  return parsed?.object === undefined || parsed.object === 'user' ? email(parsed?.email) : undefined;
}

/** Mistral `GET /v1/users/me` -> {id, email, first_name, workspace,
 * organization, api_key} -- the call mistral-vibe-identity.ts already makes. */
export function parseMistralMe(text: string): string | undefined {
  return email((json(text) as { email?: unknown } | undefined)?.email);
}

/** Cursor `GET https://api.cursor.com/v1/me` (API key info) -> {apiKeyName,
 * createdAt, userId, userEmail, ...}; a service-account key omits the user
 * fields, so it names no one. */
export function parseCursorMe(text: string): string | undefined {
  return email((json(text) as { userEmail?: unknown } | undefined)?.userEmail);
}

/** Cline `GET https://api.cline.bot/api/v1/users/me` -- the account call its
 * own CLI makes (`fetchMe`) -- answers {success, data:{id, email, ...}}. */
export function parseClineMe(text: string): string | undefined {
  const parsed = json(text) as { success?: unknown; data?: { email?: unknown }; email?: unknown } | undefined;
  if (parsed?.success === false) return undefined;
  return email(parsed?.data?.email ?? parsed?.email);
}

/** Fireworks `GET /v1/accounts` -> {accounts:[{name, email, ...}]}. A key
 * that reaches more than one account names none of them. */
export function parseFireworksAccounts(text: string): string | undefined {
  const accounts = (json(text) as { accounts?: unknown } | undefined)?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined;
  return email((accounts[0] as { email?: unknown } | undefined)?.email);
}

type KeyReader = (key: string, harness: AiLocalHarnessDefinition | undefined) => Promise<string | undefined>;

/** GET `url` with the key as a bearer token; the parsed email, or undefined. */
const bearer = (url: string, parse: (text: string) => string | undefined): KeyReader => async (key) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parse(await response.text()) : undefined;
};

const READERS = {
  openai: bearer('https://api.openai.com/v1/me', parseOpenAiMe),
  mistral: bearer('https://api.mistral.ai/v1/users/me', parseMistralMe),
  cursor: bearer('https://api.cursor.com/v1/me', parseCursorMe),
  'command-code': bearer('https://api.commandcode.ai/alpha/whoami', parseCommandCodeApiWhoami),
  cline: bearer('https://api.cline.bot/api/v1/users/me', parseClineMe),
  fireworks: bearer('https://api.fireworks.ai/v1/accounts', parseFireworksAccounts),
  // Kimi Code's own profile call (see vendor-identity.ts); a Moonshot
  // platform key is refused there and names no one.
  kimi: bearer('https://api.kimi.com/coding/v1/me', parseKimiUserInfo),
  // Amp publishes no key endpoint; its own `amp usage` reads AMP_API_KEY
  // before its stored login and opens with "Signed in as <email>".
  amp: async (key, harness) => harness?.command === 'amp'
    ? parseAmpUsage(await captureNativeHarnessOutput(harness, ['usage'], { AMP_API_KEY: key }, 15_000))
    : undefined,
} satisfies Record<string, KeyReader>;

type KeyVendor = keyof typeof READERS;

const BY_ENV: Readonly<Record<string, KeyVendor>> = {
  OPENAI_API_KEY: 'openai', MISTRAL_API_KEY: 'mistral', CURSOR_API_KEY: 'cursor',
  COMMAND_CODE_API_KEY: 'command-code', CLINE_API_KEY: 'cline', FIREWORKS_API_KEY: 'fireworks',
  KIMI_API_KEY: 'kimi', AMP_API_KEY: 'amp',
};

const BY_PROVIDER: Readonly<Record<string, KeyVendor>> = {
  openai: 'openai', mistral: 'mistral', 'mistral-vibe': 'mistral', cursor: 'cursor',
  'command-code': 'command-code', cline: 'cline', fireworks: 'fireworks', kimi: 'kimi', amp: 'amp',
};

/** The vendor whose identity call fits this key, if any has one. A known
 * variable of a vendor without one (ANTHROPIC_API_KEY) answers undefined
 * rather than falling through to the account's provider. */
export function apiKeyIdentityVendor(provider: string, envName: string): KeyVendor | undefined {
  if (BY_ENV[envName]) return BY_ENV[envName];
  return KNOWN_KEY_ENV.has(envName) ? undefined : BY_PROVIDER[provider];
}

/** Variables naming a key from a vendor known to expose no email for it. */
const KNOWN_KEY_ENV = new Set([
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'MINIMAX_API_KEY', 'MCODE_PROVIDER_API_KEY', 'ZAI_API_KEY',
  'DASHSCOPE_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY', 'FACTORY_API_KEY', 'LLM_API_KEY',
]);

/** The email behind `key` (held in `envName`) for an account of `provider`,
 * or undefined. Never throws: no name beats a wrong one. */
export async function apiKeyAccountEmail(options: {
  provider: string; envName: string; key: string | undefined; harness?: AiLocalHarnessDefinition;
}): Promise<string | undefined> {
  const key = options.key?.trim();
  const vendor = key ? apiKeyIdentityVendor(options.provider, options.envName) : undefined;
  if (!key || !vendor) return undefined;
  try {
    return await READERS[vendor](key, options.harness);
  } catch { /* fail-open-ok: an unreachable vendor leaves the placeholder. */ }
  return undefined;
}
