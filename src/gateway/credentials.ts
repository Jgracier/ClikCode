/**
 * Gateway URL + credential resolution — the adapter half of the optional
 * gateway (see constants.ts for the switch and the URL).
 *
 * Single source of truth for "which gateway URL" and "which API key for that
 * URL". Keep the import list tiny: constants + the legacy auth file reader
 * only, so nothing here can reach back into a platform SDK.
 */
import type Conf from 'conf';
import {
  CONFIG_KEYS,
  DEFAULT_GATEWAY_URL,
  GATEWAY_URL_ENV,
  GATEWAY_URL_OVERRIDE_ENV,
  normalizeApiUrl,
  type AuthByUrl,
} from '../constants.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { readCanonicalAuth } from './local-auth.js';

/** Resolve the gateway base URL: env override, then a saved non-local URL, then the default. */
export function getApiUrl(config: Conf): string {
  const explicitOverride =
    process.env[GATEWAY_URL_OVERRIDE_ENV] ||
    process.env[GATEWAY_URL_ENV];
  if (explicitOverride) {
    return normalizeApiUrl(explicitOverride);
  }

  const savedUrl = normalizeApiUrl(String((config.get(CONFIG_KEYS.API_URL) as string) || ''));
  const isLocalSaved =
    savedUrl === 'http://localhost:3000' ||
    savedUrl === 'http://127.0.0.1:3000' ||
    savedUrl.startsWith('http://localhost:') ||
    savedUrl.startsWith('http://127.0.0.1:');

  // The default gateway is the baseline; localhost must be explicit per command/session.
  if (!savedUrl || isLocalSaved) {
    return normalizeApiUrl(DEFAULT_GATEWAY_URL);
  }

  return savedUrl;
}

/**
 * Resolve the stored API key for a platform URL (defaults to the current one).
 * The per-URL map in config is the record. Copies older versions wrote
 * beside it -- the canonical auth file, `~/.clikcode/api-key`, the single
 * `apiKey` setting -- are read only when the map has nothing for this URL,
 * and a key found that way is moved into the map. A key is only ever sent
 * to the URL it was issued for: the canonical file names its URL, and one
 * that names none (the key file, the `apiKey` setting) goes only to the
 * canonical gateway or the URL the user saved, and never to a URL other
 * than one the map already holds it for.
 */
export function getApiKeyForUrl(config: Conf, url?: string): string | undefined {
  const normalized = normalizeApiUrl(url ?? getApiUrl(config));
  const authByUrl = (config.get(CONFIG_KEYS.AUTH_BY_URL) as AuthByUrl | undefined) ?? {};
  const recorded = authByUrl[normalized]?.apiKey;
  if (recorded) return recorded;
  const migrated = legacyApiKeyForUrl(config, normalized, authByUrl);
  if (!migrated) return undefined;
  config.set(CONFIG_KEYS.AUTH_BY_URL, { ...authByUrl, [normalized]: { apiKey: migrated.apiKey, user: migrated.user ?? null } });
  return migrated.apiKey;
}

function legacyApiKeyForUrl(config: Conf, normalized: string, authByUrl: AuthByUrl): { apiKey: string; user?: unknown } | undefined {
  const issuedElsewhere = (apiKey: string): boolean => Object.entries(authByUrl).some(([other, record]) => other !== normalized && record?.apiKey === apiKey);
  const unscopedApplies = (apiKey: string): boolean => {
    if (issuedElsewhere(apiKey)) return false;
    if (normalized === normalizeApiUrl(DEFAULT_GATEWAY_URL)) return true;
    const saved = normalizeApiUrl(String((config.get(CONFIG_KEYS.API_URL) as string) || ''));
    return Boolean(saved) && saved === normalized;
  };
  const canonical = readCanonicalAuth();
  if (canonical?.apiKey) {
    const canonicalUrl = normalizeApiUrl(String(canonical.apiUrl || '').trim());
    if (canonicalUrl ? canonicalUrl === normalized : unscopedApplies(canonical.apiKey)) return canonical;
  }
  const legacy = config.get(CONFIG_KEYS.API_KEY) as string | undefined;
  return legacy && unscopedApplies(legacy) ? { apiKey: legacy, user: config.get('user') } : undefined;
}

/** Persist a verified credential for the current URL: the per-URL record,
 * and nothing else. */
export function saveGatewayAuth(config: Conf, apiKey: string, user: unknown): void {
  const normalized = normalizeApiUrl(getApiUrl(config));
  const authByUrl = (config.get(CONFIG_KEYS.AUTH_BY_URL) as AuthByUrl) || {};
  config.set(CONFIG_KEYS.AUTH_BY_URL, { ...authByUrl, [normalized]: { apiKey, user } });
}

/** The API key for an account whose credential is an `env:NAME` reference. */
export function localApiKey(account: AiHarnessAccount): string {
  if (account.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) {
    throw new Error('this account needs a supported local API-key resolver (env:NAME)');
  }
  const name = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid local environment credential reference');
  const value = process.env[name];
  if (!value) throw new Error(`local credential ${name} is not available in this harness process`);
  return value;
}
