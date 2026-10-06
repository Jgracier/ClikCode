import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiKeyAccountEmail, apiKeyIdentityVendor, parseClineMe, parseCursorMe, parseFireworksAccounts, parseMistralMe, parseOpenAiMe,
} from './api-key-identity.js';

// Shapes from each vendor's docs or live response (2026-10-05), emails replaced.
describe('API-key identity parsers', () => {
  it('OpenAI /v1/me names the key owner, not an org or service account', () => {
    expect(parseOpenAiMe(JSON.stringify({ object: 'user', id: 'user-1', email: 'me@example.com', name: 'Me', orgs: { data: [] } }))).toBe('me@example.com');
    expect(parseOpenAiMe(JSON.stringify({ object: 'organization', id: 'org-1', email: 'org@example.com' }))).toBeUndefined();
    expect(parseOpenAiMe(JSON.stringify({ error: { message: 'nope' } }))).toBeUndefined();
    expect(parseOpenAiMe('not json')).toBeUndefined();
  });

  it('Mistral /v1/users/me', () => {
    expect(parseMistralMe(JSON.stringify({ id: 'u', email: 'me@example.com', first_name: 'me', workspace: { id: 'w', name: 'Default Workspace' }, organization: { id: 'o', name: 'Org' } }))).toBe('me@example.com');
    expect(parseMistralMe(JSON.stringify({ id: 'u', email: null }))).toBeUndefined();
  });

  it('Cursor /v1/me: user-scoped keys only', () => {
    expect(parseCursorMe(JSON.stringify({ apiKeyName: 'k', createdAt: '2026-01-01T00:00:00Z', userId: 1, userEmail: 'me@example.com' }))).toBe('me@example.com');
    expect(parseCursorMe(JSON.stringify({ apiKeyName: 'service', createdAt: '2026-01-01T00:00:00Z' }))).toBeUndefined();
  });

  it('Cline /api/v1/users/me envelope', () => {
    expect(parseClineMe(JSON.stringify({ success: true, data: { id: 'usr-1', email: 'me@example.com', displayName: 'Me' } }))).toBe('me@example.com');
    expect(parseClineMe(JSON.stringify({ success: false, error: 'Unauthorized', data: { email: 'me@example.com' } }))).toBeUndefined();
    expect(parseClineMe(JSON.stringify({ success: true, data: { id: 'usr-1' } }))).toBeUndefined();
  });

  it('Fireworks /v1/accounts: exactly one account or nothing', () => {
    expect(parseFireworksAccounts(JSON.stringify({ accounts: [{ name: 'accounts/me', email: 'me@example.com' }] }))).toBe('me@example.com');
    expect(parseFireworksAccounts(JSON.stringify({ accounts: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }))).toBeUndefined();
    expect(parseFireworksAccounts(JSON.stringify({ accounts: [] }))).toBeUndefined();
    expect(parseFireworksAccounts(JSON.stringify({ accounts: [{ name: 'accounts/me', email: 'not-an-email' }] }))).toBeUndefined();
  });
});

describe('API-key identity routing', () => {
  it('the variable names the key vendor before the account provider does', () => {
    expect(apiKeyIdentityVendor('aider', 'OPENAI_API_KEY')).toBe('openai');
    expect(apiKeyIdentityVendor('openai', 'MY_WORK_KEY')).toBe('openai');
    expect(apiKeyIdentityVendor('mistral-vibe', 'MISTRAL_API_KEY')).toBe('mistral');
    expect(apiKeyIdentityVendor('command-code', 'COMMAND_CODE_API_KEY')).toBe('command-code');
    // A vendor with no identity call: never falls through to the provider.
    expect(apiKeyIdentityVendor('cursor', 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(apiKeyIdentityVendor('aider', 'OPENROUTER_API_KEY')).toBeUndefined();
    expect(apiKeyIdentityVendor('anthropic', 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(apiKeyIdentityVendor('factory', 'FACTORY_API_KEY')).toBeUndefined();
    expect(apiKeyIdentityVendor('xai', 'XAI_API_KEY')).toBeUndefined();
  });

  describe('apiKeyAccountEmail', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('sends the key only to its own vendor and reads the email back', async () => {
      const calls: { url: string; auth: string | null }[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
        return new Response(JSON.stringify({ apiKeyName: 'k', userEmail: 'me@example.com' }), { status: 200 });
      });
      expect(await apiKeyAccountEmail({ provider: 'cursor', envName: 'CURSOR_API_KEY', key: 'key_abc' })).toBe('me@example.com');
      expect(calls).toEqual([{ url: 'https://api.cursor.com/v1/me', auth: 'Bearer key_abc' }]);
    });

    it('names no one on a refused key, a network failure, or no key', async () => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ email: 'me@example.com' }), { status: 401 }));
      expect(await apiKeyAccountEmail({ provider: 'mistral', envName: 'MISTRAL_API_KEY', key: 'k' })).toBeUndefined();
      vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
      expect(await apiKeyAccountEmail({ provider: 'mistral', envName: 'MISTRAL_API_KEY', key: 'k' })).toBeUndefined();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      expect(await apiKeyAccountEmail({ provider: 'mistral', envName: 'MISTRAL_API_KEY', key: '  ' })).toBeUndefined();
      expect(await apiKeyAccountEmail({ provider: 'anthropic', envName: 'ANTHROPIC_API_KEY', key: 'k' })).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('Amp is asked only through the amp harness itself', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      expect(await apiKeyAccountEmail({ provider: 'amp', envName: 'AMP_API_KEY', key: 'k' })).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
