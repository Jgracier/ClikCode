/**
 * Gateway URL + credential resolution — the adapter half of the optional
 * gateway (see constants.ts for the switch and the URL).
 *
 * Single source of truth for "which gateway URL" and "which API key for that
 * URL". Keep the import list tiny: constants + the canonical auth file reader
 * only, so nothing here can reach back into a platform SDK.
 */
import type Conf from 'conf';
import {
  CONFIG_KEYS,
  DEFAULT_GATEWAY_URL,
  GATEWAY_URL_ENV,
  GATEWAY_URL_OVERRIDE_ENV,
  LEGACY_GATEWAY_URL_ENV,
  normalizeApiUrl,
  type AuthByUrl,
} from '../constants.js';
import { readCanonicalAuth, writeCanonicalAuth } from './local-auth.js';

/** Resolve the gateway base URL: env override, then a saved non-local URL, then the default. */
export function getApiUrl(config: Conf): string {
  const explicitOverride =
    process.env[GATEWAY_URL_OVERRIDE_ENV] ||
    process.env[GATEWAY_URL_ENV] ||
    process.env[LEGACY_GATEWAY_URL_ENV];
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
 * Order: canonical auth file (when it has no URL or the same URL), then the
 * per-URL map in config, then the legacy single `apiKey`.
 */
export function getApiKeyForUrl(config: Conf, url?: string): string | undefined {
  const normalized = normalizeApiUrl(url ?? getApiUrl(config));
  const canonical = readCanonicalAuth();
  if (canonical?.apiKey) {
    const canonicalUrl = normalizeApiUrl(String(canonical.apiUrl || '').trim());
    if (!canonicalUrl || canonicalUrl === normalized) return canonical.apiKey;
  }
  const authByUrl = config.get(CONFIG_KEYS.AUTH_BY_URL) as AuthByUrl | undefined;
  const key = authByUrl?.[normalized]?.apiKey;
  if (key) return key;
  return config.get(CONFIG_KEYS.API_KEY) as string | undefined;
}

/** Persist a verified credential exactly as AuthService.saveAuthForCurrentUrl does. */
export function saveGatewayAuth(config: Conf, apiKey: string, user: unknown): void {
  const normalized = normalizeApiUrl(getApiUrl(config));
  const authByUrl = (config.get(CONFIG_KEYS.AUTH_BY_URL) as AuthByUrl) || {};
  authByUrl[normalized] = { apiKey, user };
  config.set(CONFIG_KEYS.AUTH_BY_URL, authByUrl);
  config.set('apiKey', apiKey);
  config.set('user', user);
  writeCanonicalAuth({ apiUrl: normalized, apiKey, updatedAt: new Date().toISOString(), user });
}
