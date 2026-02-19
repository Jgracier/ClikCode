/**
 * Central defaults for the CLI. Change these to point at a different
 * platform or adjust behavior without editing multiple files.
 *
 * User-level overrides: clikdeploy config api-url <url> or env CLICKDEPLOY_API_URL.
 */
export const DEFAULT_API_URL = 'https://clikdeploy.com';

export const CONFIG_KEYS = {
  API_URL: 'apiUrl',
  API_KEY: 'apiKey',
  AUTH_BY_URL: 'authByUrl',
} as const;

/** Auth stored per API URL so localhost and clikdeploy.com can each have a session. */
export type AuthByUrl = Record<string, { apiKey: string; user: unknown }>;

export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}
