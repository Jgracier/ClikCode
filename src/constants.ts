/**
 * The Gateway adapter's configuration — the ONLY place ClikCode names a remote
 * platform.
 *
 * ClikCode is local-first: local harnesses, vendor CLI logins and API keys in
 * the OS keychain all work without touching the gateway. It is used only after
 * you authenticate with `gateway login`, and is reached only through this
 * module. `CLIKCODE_GATEWAY_URL` overrides the endpoint.
 */
export const DEFAULT_GATEWAY_URL = 'https://clikdeploy.com';

/** Per-command override, set by code (not by users) ahead of a single call. */
export const GATEWAY_URL_OVERRIDE_ENV = 'CLIKCODE_GATEWAY_URL_OVERRIDE';

/** User-facing override. */
export const GATEWAY_URL_ENV = 'CLIKCODE_GATEWAY_URL';

/** Persisted key names; existing installs already hold values under them. */
export const CONFIG_KEYS = {
  API_URL: 'apiUrl',
  API_KEY: 'apiKey',
  AUTH_BY_URL: 'authByUrl',
} as const;

/** Auth stored per gateway URL so a self-hosted endpoint and the default can coexist. */
export type AuthByUrl = Record<string, { apiKey: string; user: unknown }>;

export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}
