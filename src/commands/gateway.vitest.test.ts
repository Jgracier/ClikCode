import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../gateway/local-auth.js', () => ({
  readCanonicalAuth: vi.fn(() => null),
  writeCanonicalAuth: vi.fn(),
}));

import { writeCanonicalAuth, readCanonicalAuth } from '../gateway/local-auth.js';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
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
  delete process.env.CLIKDEPLOY_API_URL;
  delete process.env.CLIKDEPLOY_API_URL_OVERRIDE;
});

describe('gateway-credentials', () => {
  it('defaults to the platform URL and ignores a saved localhost URL', () => {
    expect(getApiUrl(makeConfig())).toBe('https://clikdeploy.com');
    expect(getApiUrl(makeConfig({ apiUrl: 'http://localhost:3000/' }))).toBe('https://clikdeploy.com');
    expect(getApiUrl(makeConfig({ apiUrl: 'https://self.example/' }))).toBe('https://self.example');
  });

  it('prefers the env override', () => {
    process.env.CLIKDEPLOY_API_URL = 'http://localhost:3000/';
    expect(getApiUrl(makeConfig({ apiUrl: 'https://self.example' }))).toBe('http://localhost:3000');
  });

  it('resolves keys: canonical for a matching or unscoped URL, then per-URL, then legacy', () => {
    const config = makeConfig({ authByUrl: { 'https://clikdeploy.com': { apiKey: 'per-url', user: {} } }, apiKey: 'legacy' });
    expect(getApiKeyForUrl(config)).toBe('per-url');
    expect(getApiKeyForUrl(config, 'https://other.example')).toBe('legacy');
    vi.mocked(readCanonicalAuth).mockReturnValue({ apiUrl: 'https://other.example', apiKey: 'canon', updatedAt: '' });
    expect(getApiKeyForUrl(config, 'https://other.example/')).toBe('canon');
    expect(getApiKeyForUrl(config)).toBe('per-url');
    vi.mocked(readCanonicalAuth).mockReturnValue({ apiUrl: '', apiKey: 'canon-any', updatedAt: '' });
    expect(getApiKeyForUrl(config)).toBe('canon-any');
    vi.mocked(readCanonicalAuth).mockReturnValue(null);
  });
});

describe('gatewayLogin (embedded)', () => {
  it('runs the PKCE device flow, verifies the key, and stores it per URL', async () => {
    const config = makeConfig();
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    let polls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
      if (String(url).endsWith('/device/init')) return jsonResponse({ data: { flowId: 'flow-1', authUrl: 'https://clikdeploy.com/auth?flow=flow-1' } });
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

    const user = await gatewayLogin(config, { github: true, embedded: true }, {
      fetch: fetchMock, openBrowser: (u) => opened.push(u), sleep: async () => {}, log: () => {},
    });

    expect(user).toEqual({ email: 'u@x.com' });
    expect(opened).toEqual(['https://clikdeploy.com/auth?flow=flow-1']);
    const init = calls[0]!;
    expect(init.url).toBe('https://clikdeploy.com/api/gate/auth/device/init');
    expect(init.body).toMatchObject({ provider: 'github', codeChallengeMethod: 'S256' });
    const poll = calls[1]!;
    expect(poll.body.flowId).toBe('flow-1');
    expect(createHash('sha256').update(poll.body.codeVerifier, 'ascii').digest('base64url')).toBe(init.body.codeChallenge);
    expect(poll.url).not.toContain(poll.body.codeVerifier);
    expect(calls.at(-1)!.headers.Authorization).toBe('Bearer ck_live');
    expect(config._store.apiKey).toBe('ck_live');
    expect(config._store.authByUrl).toEqual({ 'https://clikdeploy.com': { apiKey: 'ck_live', user: { email: 'u@x.com' } } });
    expect(writeCanonicalAuth).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: 'https://clikdeploy.com', apiKey: 'ck_live' }));
  });

  it('throws AUTH_EXPIRED when the flow expires and stores nothing', async () => {
    const config = makeConfig();
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/device/init')
      ? jsonResponse({ flowId: 'f', authUrl: 'https://a' })
      : jsonResponse({ status: 'expired' })) as never as typeof fetch;
    await expect(gatewayLogin(config, { embedded: true }, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} }))
      .rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(config._store.apiKey).toBeUndefined();
  });

  it('times out', async () => {
    let t = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/device/init')
      ? jsonResponse({ flowId: 'f', authUrl: 'https://a' })
      : jsonResponse({ status: 'pending' })) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), { embedded: true }, {
      fetch: fetchMock, openBrowser: () => {}, sleep: async () => { t += 60_000; }, now: () => t, log: () => {},
    })).rejects.toThrow(/timed out/);
  });

  it('surfaces a failed init', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'provider disabled' } }, 400)) as never as typeof fetch;
    await expect(gatewayLogin(makeConfig(), { embedded: true }, { fetch: fetchMock, openBrowser: () => {}, sleep: async () => {}, log: () => {} }))
      .rejects.toThrow('provider disabled');
  });
});
