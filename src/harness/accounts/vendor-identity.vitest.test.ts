import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { matchingVendorAccount } from './labels.js';
import {
  antigravityIdTokenEmail, codexIdTokenEmail, kimiBaseUrl, parseKimiUserInfo, parseAmpUsage, parseClineProviders, parseCommandCodeWhoami, parseDevinAuthStatus,
  parseJunieCredentials, parseKiloProfile, parseKiroWhoami, parseOpenHandsUser, vendorAccountEmail,
} from './vendor-identity.js';

// Shapes copied from each vendor's real output on 2026-09-30, emails replaced.
describe('vendor account email', () => {
  it('uses the email Grok saves after browser consent for the account title', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'clikcode-grok-identity-'));
    try {
      mkdirSync(join(profile, '.grok'));
      writeFileSync(join(profile, '.grok', 'auth.json'), JSON.stringify({
        'https://auth.x.ai::user-id': { email: 'grok@example.com', accessToken: 'redacted' },
      }));
      expect(await vendorAccountEmail({ command: 'grok' } as AiLocalHarnessDefinition, profile)).toBe('grok@example.com');
      expect(await vendorAccountEmail({ command: 'grok' } as AiLocalHarnessDefinition, join(profile, '.grok'))).toBeUndefined();
      writeFileSync(join(profile, '.grok', 'auth.json'), JSON.stringify({
        first: { email: 'grok@example.com' }, second: { email: 'other@example.com' },
      }));
      expect(await vendorAccountEmail({ command: 'grok' } as AiLocalHarnessDefinition, profile)).toBeUndefined();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
  it('recognizes a Grok account whose older label hid its email, without merging an API key', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'clikcode-grok-match-'));
    try {
      mkdirSync(join(profile, '.grok'));
      writeFileSync(join(profile, '.grok', 'auth.json'), JSON.stringify({ user: { email: 'grok@example.com' } }));
      const harness = { command: 'grok', provider: 'xai' } as AiLocalHarnessDefinition;
      const accounts = [
        { id: 'key', provider: 'xai', label: 'grok@example.com', authKind: 'api-key' },
        { id: 'older', provider: 'xai', label: 'Grok Build 2', authKind: 'vendor-cli', nativeProfile: { env: 'HOME', path: profile } },
      ] as never;
      expect((await matchingVendorAccount(accounts, harness, 'GROK@example.com'))?.id).toBe('older');
      expect(await matchingVendorAccount(accounts, harness, 'different@example.com')).toBeUndefined();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
  it('reads file-backed identities from each provider\'s actual profile root', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'clikcode-identities-'));
    try {
      const payload = Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url');
      const files = [
        ['codex', 'auth.json', { tokens: { id_token: `h.${payload}.s` } }, 'codex@example.com'],
        ['gemini', '.gemini/google_accounts.json', { active: 'gemini@example.com' }, 'gemini@example.com'],
        ['copilot', 'config.json', { lastLoggedInUser: { login: 'github-user' } }, 'github-user'],
        ['cline', '.cline/data/settings/providers.json', { providers: { cline: { settings: { auth: { metadata: { userInfo: { email: 'cline@example.com' } } } } } } }, 'cline@example.com'],
        ['junie', '.junie/secure_credentials.json', { secrets: [{ key: 'jb-account-stored', secret: JSON.stringify({ jbAccount: { email: 'junie@example.com' } }) }] }, 'junie@example.com'],
      ] as const;
      for (const [command, relative, data, expected] of files) {
        const root = join(profile, command);
        const file = join(root, relative);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(data));
        expect(await vendorAccountEmail({ command } as AiLocalHarnessDefinition, root), command).toBe(expected);
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
  it('reads Kiro whoami JSON', () => {
    expect(parseKiroWhoami('{"accountType":"SocialGoogle","email":"a@example.com"}')).toBe('a@example.com');
    expect(parseKiroWhoami('{"accountType":"BuilderId"}')).toBeUndefined();
  });

  it('reads Kilo profile JSON', () => {
    expect(parseKiloProfile('{"name":"A","email":"a@example.com","team":"Personal","organizationId":null,"balance":0}')).toBe('a@example.com');
    expect(parseKiloProfile('Not logged in')).toBeUndefined();
  });

  it('reads Amp usage', () => {
    expect(parseAmpUsage('Signed in as a@example.com\n**Individual credits:** $9.05 remaining')).toBe('a@example.com');
    expect(parseAmpUsage('Not signed in')).toBeUndefined();
  });

  it('reads Command Code whoami through ANSI colour', () => {
    const text = '- Fetching user information...\n\u001b[32m√\u001b[39m User information loaded\nUser Information:\ni Name: A\ni Email: a@example.com\ni Username: A\n';
    expect(parseCommandCodeWhoami(text)).toBe('a@example.com');
  });

  it('reads Devin auth status', () => {
    const text = 'Logged in (via Devin).\nUser:\n  Name:              A\n  Email:             a@example.com\n  User ID:           user-1\n';
    expect(parseDevinAuthStatus(text)).toBe('a@example.com');
    expect(parseDevinAuthStatus('Not logged in.')).toBeUndefined();
  });

  it('reads only the Cline account from providers.json', () => {
    const text = JSON.stringify({ providers: {
      openai: { settings: { auth: { metadata: { userInfo: { email: 'other@example.com' } } } } },
      cline: { settings: { auth: { accessToken: 't', metadata: { userInfo: { email: 'a@example.com', name: 'A' } } } } },
    } });
    expect(parseClineProviders(text)).toBe('a@example.com');
    expect(parseClineProviders(JSON.stringify({ providers: { openai: {} } }))).toBeUndefined();
  });

  it('reads the JetBrains account Junie stores', () => {
    const secret = JSON.stringify({ jbAccount: { access_token: 't', name: 'A', email: 'a@example.com' } });
    expect(parseJunieCredentials(JSON.stringify({ secrets: [{ key: 'jb-account-stored', secret }] }))).toBe('a@example.com');
    expect(parseJunieCredentials(JSON.stringify({ secrets: [{ key: 'other', secret }] }))).toBeUndefined();
  });

  it('reads the OpenHands Cloud user', () => {
    expect(parseOpenHandsUser('{"language":"en","email":"a@example.com","email_verified":false}')).toBe('a@example.com');
    expect(parseOpenHandsUser('<!DOCTYPE html>')).toBeUndefined();
  });

  it('reads the email claim of the Codex id_token', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@example.com' })).toString('base64url');
    expect(codexIdTokenEmail(JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }))).toBe('a@example.com');
    expect(codexIdTokenEmail(JSON.stringify({ tokens: {} }))).toBeUndefined();
  });

  it('reads the Google email claim of the Antigravity id_token, expired or not', () => {
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    const file = (idToken?: string) => JSON.stringify({
      token: { access_token: 'redacted', token_type: 'Bearer', refresh_token: 'redacted', expiry: '2026-09-26T21:30:55-06:00' },
      auth_method: 'consumer', ...(idToken ? { id_token: idToken } : {}),
    });
    const google = { iss: 'https://accounts.google.com', email: 'a@example.com', email_verified: true, exp: 1 };
    expect(antigravityIdTokenEmail(file(jwt(google)))).toBe('a@example.com');
    expect(antigravityIdTokenEmail(file(jwt({ ...google, iss: 'https://evil.example' })))).toBeUndefined();
    expect(antigravityIdTokenEmail(file(jwt({ ...google, email_verified: false })))).toBeUndefined();
    expect(antigravityIdTokenEmail(file())).toBeUndefined();
    expect(antigravityIdTokenEmail('not json')).toBeUndefined();
  });

  it('reads the Kimi /me profile and the base_url its config names', () => {
    expect(parseKimiUserInfo('{"user_id":"u1","nickname":"n","email":"a@example.com"}')).toBe('a@example.com');
    expect(parseKimiUserInfo('{"user_id":"u1","nickname":"n"}')).toBeUndefined();
    expect(parseKimiUserInfo('{"email":"a@example.com"}')).toBeUndefined();
    const config = '[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.ai/coding/v1/"\n\n[providers."managed:kimi-code".oauth]\nstorage = "file"\n';
    expect(kimiBaseUrl(config)).toBe('https://api.kimi.ai/coding/v1');
    expect(kimiBaseUrl('[providers.other]\nbase_url = "https://x.example"\n')).toBeUndefined();
  });
  it('never sends an expired Kimi access token anywhere', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'clikcode-kimi-identity-'));
    try {
      mkdirSync(join(profile, '.kimi-code', 'credentials'), { recursive: true });
      writeFileSync(join(profile, '.kimi-code', 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'h.e30.s', expires_at: 1 }));
      const original = globalThis.fetch;
      let called = false;
      globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
      try {
        expect(await vendorAccountEmail({ command: 'kimi' } as AiLocalHarnessDefinition, profile)).toBeUndefined();
      } finally { globalThis.fetch = original; }
      expect(called).toBe(false);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
