import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../gateway/local-auth.js', () => ({
  readCanonicalAuth: vi.fn(() => null),
}));

import { readCanonicalAuth } from '../gateway/local-auth.js';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
import { DEFAULT_GATEWAY_URL } from '../constants.js';
import { gatewayLogin } from './gateway.js';

function makeConfig(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => { store[k] = v; },
    delete: (k: string) => { delete store[k]; },
    _store: store,
  } as never as import('conf').default & { _store: Record<string, unknown> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLIKCODE_GATEWAY_URL;
  delete process.env.CLIKCODE_GATEWAY_URL_OVERRIDE;
});

describe('gateway-credentials', () => {
  it('defaults to the platform URL and ignores a saved localhost URL', () => {
    expect(getApiUrl(makeConfig())).toBe(DEFAULT_GATEWAY_URL);
    expect(getApiUrl(makeConfig({ apiUrl: 'http://localhost:3000/' }))).toBe(DEFAULT_GATEWAY_URL);
    expect(getApiUrl(makeConfig({ apiUrl: 'https://self.example/' }))).toBe('https://self.example');
  });

  it('prefers the env override', () => {
    process.env.CLIKCODE_GATEWAY_URL = 'http://localhost:3000/';
    expect(getApiUrl(makeConfig({ apiUrl: 'https://self.example' }))).toBe('http://localhost:3000');
  });

  it('resolves keys from the per-URL record, moving a legacy copy into it once', () => {
    const config = makeConfig({ authByUrl: { [DEFAULT_GATEWAY_URL]: { apiKey: 'per-url', user: {} } }, apiKey: 'legacy' });
    expect(getApiKeyForUrl(config)).toBe('per-url');
    const legacy = makeConfig({ apiKey: 'legacy' });
    expect(getApiKeyForUrl(legacy)).toBe('legacy');
    expect(legacy._store.authByUrl).toEqual({ [DEFAULT_GATEWAY_URL]: { apiKey: 'legacy', user: null } });
    expect(getApiKeyForUrl(makeConfig({ apiKey: 'legacy', apiUrl: 'https://self.example/' }), 'https://self.example')).toBe('legacy');
    vi.mocked(readCanonicalAuth).mockReturnValue({ apiUrl: 'https://other.example', apiKey: 'canon', updatedAt: '' });
    expect(getApiKeyForUrl(config, 'https://other.example/')).toBe('canon');
    expect(getApiKeyForUrl(config)).toBe('per-url');
    // The record wins over a stale file copy once it holds the URL.
    vi.mocked(readCanonicalAuth).mockReturnValue({ apiUrl: '', apiKey: 'canon-any', updatedAt: '' });
    expect(getApiKeyForUrl(config)).toBe('per-url');
    expect(getApiKeyForUrl(makeConfig())).toBe('canon-any');
    vi.mocked(readCanonicalAuth).mockReturnValue(null);
  });

  it('never sends a key to a URL it was not issued for', () => {
    const config = makeConfig({ authByUrl: { [DEFAULT_GATEWAY_URL]: { apiKey: 'per-url', user: {} } }, apiKey: 'legacy' });
    process.env.CLIKCODE_GATEWAY_URL = 'https://attacker.example';
    expect(getApiKeyForUrl(config)).toBeUndefined();
    expect(getApiKeyForUrl(config, 'https://other.example')).toBeUndefined();
    vi.mocked(readCanonicalAuth).mockReturnValue({ apiUrl: '', apiKey: 'canon-any', updatedAt: '' });
    expect(getApiKeyForUrl(config)).toBeUndefined();
    expect(getApiKeyForUrl(makeConfig(), DEFAULT_GATEWAY_URL)).toBe('canon-any');
    vi.mocked(readCanonicalAuth).mockReturnValue(null);
  });

  it('keeps a URL-less legacy key issued for a custom gateway away from the default one', () => {
    const config = makeConfig({ authByUrl: { 'https://self.example': { apiKey: 'custom', user: {} } }, apiKey: 'custom' });
    expect(getApiKeyForUrl(config, DEFAULT_GATEWAY_URL)).toBeUndefined();
    expect(getApiKeyForUrl(config, 'https://self.example')).toBe('custom');
  });
});

describe('gatewayLogin', () => {
  it('runs the PKCE device flow, verifies the key, and stores it per URL', async () => {
    const config = makeConfig();
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    let polls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
      if (String(url).endsWith('/device/init')) return jsonResponse({ data: { flowId: 'flow-1', authUrl: `${DEFAULT_GATEWAY_URL}/auth?flow=flow-1` } });
      if (String(url).endsWith('/device/poll')) {
        polls += 1;
        if (polls === 1) return jsonResponse({ status: 'pending' });
        if (polls === 2) return jsonResponse({ error: 'boom' }, 502);
        return jsonResponse({ status: 'complete', data: { apiKey: 'ck_live' } });
      }
      if (String(url).endsWith('/api/gate/auth/me')) return jsonResponse({ data: { user: { email: 'u@x.com' } } });
      throw new Error(`unexpected ${String(url)}`);
    }) as never as typeof fetch;
    const opened: string[] = [];

    const user = await gatewayLogin(config, { github: true }, {
      fetch: fetchMock, openBrowser: (u) => opened.push(u), sleep: async () => {}, log: () => {},
    });

    expect(user).toEqual({ email: 'u@x.com' });
    expect(opened).toEqual([`${DEFAULT_GATEWAY_URL}/auth?flow=flow-1`]);
    const init = calls[0]!;
    expect(init.url).toBe(`${DEFAULT_GATEWAY_URL}/api/gate/auth/device/init`);
    expect(init.body).toMatchObject({ provider: 'github', codeChallengeMethod: 'S256' });
    const poll = calls[1]!;
    expect(poll.body.flowId).toBe('flow-1');
    expect(createHash('sha256').update(poll.body.codeVerifier, 'ascii').digest('base64url')).toBe(init.body.codeChallenge);
    expect(poll.url).not.toContain(poll.body.codeVerifier);
    expect(calls.at(-1)!.headers.Authorization).toBe('Bearer ck_live');
    // The per-URL record only: no copy that names no URL.
    expect(config._store.apiKey).toBeUndefined();
    expect(config._store.authByUrl).toEqual({ [DEFAULT_GATEWAY_URL]: { apiKey: 'ck_live', user: { email: 'u@x.com' } } });
  });

  it('throws AUTH_EXPIRED when the flow expires and stores nothing', async () => {
    const config = makeConfig();
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/device/init')
      ? jsonResponse({ flowId: 'f', authUrl: 'https://a' })
      : jsonResponse({ status: 'expired' })) as never as typeof fetch;
    await expect(gatewayLogin(config, {}, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} }))
      .rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(config._store.apiKey).toBeUndefined();
  });

  it('times out', async () => {
    let t = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/device/init')
      ? jsonResponse({ flowId: 'f', authUrl: 'https://a' })
      : jsonResponse({ status: 'pending' })) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), {}, {
      fetch: fetchMock, openBrowser: () => {}, sleep: async () => { t += 60_000; }, now: () => t, log: () => {},
    })).rejects.toThrow(/timed out/);
  });

  it('surfaces a failed init', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'provider disabled' } }, 400)) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), {}, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} }))
      .rejects.toThrow('provider disabled');
  });

  it('stops at the first poll the Gateway refuses for good (400, 404), instead of polling out the five minutes', async () => {
    for (const status of [400, 404]) {
      let polls = 0;
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/device/init')) return jsonResponse({ flowId: 'f', authUrl: 'https://a' });
        polls += 1;
        return jsonResponse({ error: 'unknown flow' }, status);
      }) as never as typeof fetch;
      await expect(gatewayLogin(makeConfig(), {}, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} })).rejects.toThrow('unknown flow');
      expect(polls).toBe(1);
    }
  });

  it('keeps polling through no answer, a 5xx and a 429, and stops at a verify the Gateway refuses', async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/device/init')) return jsonResponse({ flowId: 'f', authUrl: 'https://a' });
      if (String(url).endsWith('/auth/me')) return jsonResponse({ error: 'key revoked' }, 403);
      polls += 1;
      if (polls === 1) throw new TypeError('fetch failed');
      if (polls === 2) return jsonResponse({}, 503);
      if (polls === 3) return jsonResponse({}, 429);
      return jsonResponse({ status: 'complete', apiKey: 'k' });
    }) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), {}, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} })).rejects.toThrow('key revoked');
    expect(polls).toBe(4);
  });

  it('a refused sign-in says which Gateway to check, and throws for the command error handler instead of exiting', async () => {
    const exit = vi.spyOn(process, 'exit');
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401)) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), {}, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} })).rejects.toThrow(/bad key \(CLIKCODE_GATEWAY_URL/);
    expect(exit).not.toHaveBeenCalled();
  });
});
