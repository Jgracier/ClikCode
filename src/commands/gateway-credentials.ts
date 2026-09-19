/**
 * ClikDeploy Gateway URL + credential resolution, free of the deployment tree.
 *
 * This is the single source of truth for "which platform URL" and "which API
 * key for that URL". `ApiClient.getApiUrl` / `ApiClient.getApiKeyForUrl` (and
 * the `getApiKeyForUrl` export of api/client.ts) delegate here. ClikCode
 * imports this module directly so its bundle never pulls in api/client.ts
 * (axios, axios-retry, the deploy/server API surface).
 *
 * Keep the import list tiny: constants + the canonical auth file reader only.
 */
import type Conf from 'conf';
import {
  CLI_API_URL_OVERRIDE_ENV,
  CONFIG_KEYS,
  DEFAULT_API_URL,
  normalizeApiUrl,
  type AuthByUrl,
} from '../constants.js';
import { readCanonicalAuth, writeCanonicalAuth } from '../utils/local-auth.js';

/** Resolve the platform base URL: env override, then a saved non-local URL, then the default. */
export function getApiUrl(config: Conf): string {
  const explicitOverride =
    process.env[CLI_API_URL_OVERRIDE_ENV] || process.env.CLIKDEPLOY_API_URL;
  if (explicitOverride) {
    return normalizeApiUrl(explicitOverride);
  }

  const savedUrl = normalizeApiUrl(String((config.get(CONFIG_KEYS.API_URL) as string) || ''));
  const isLocalSaved =
    savedUrl === 'http://localhost:3000' ||
    savedUrl === 'http://127.0.0.1:3000' ||
    savedUrl.startsWith('http://localhost:') ||
    savedUrl.startsWith('http://127.0.0.1:');

  // Main platform URL is the default baseline; localhost must be explicit per command/session.
  if (!savedUrl || isLocalSaved) {
    return normalizeApiUrl(DEFAULT_API_URL);
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
