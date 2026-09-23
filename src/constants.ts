/**
 * The optional Gateway adapter's configuration — the ONLY place ClikCode names
 * a remote platform.
 *
 * ClikCode is local-first: local harnesses, vendor CLI logins and API keys in
 * the OS keychain all work with no gateway at all. The gateway is one
 * replaceable remote model provider, reached only through this module, so a
 * different host is a URL change and no host at all is a flag:
 *
 *   CLIKCODE_GATEWAY=off        remove the `gateway` command surface entirely
 *   CLIKCODE_GATEWAY_URL=<url>  point it at any compatible endpoint
 *
 * The default is only a default; nothing above this file depends on which
 * host answers.
 */
export const DEFAULT_GATEWAY_URL = 'https://clikdeploy.com';

/** Per-command override, set by code (not by users) ahead of a single call. */
export const GATEWAY_URL_OVERRIDE_ENV = 'CLIKCODE_GATEWAY_URL_OVERRIDE';

/** User-facing override. */
export const GATEWAY_URL_ENV = 'CLIKCODE_GATEWAY_URL';

/** `off`/`0`/`false` removes the gateway surface; anything else leaves it on. */
export function isGatewayEnabled(): boolean {
  const setting = String(process.env.CLIKCODE_GATEWAY ?? '').trim().toLowerCase();
  return !(setting === 'off' || setting === '0' || setting === 'false' || setting === 'no');
}

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
