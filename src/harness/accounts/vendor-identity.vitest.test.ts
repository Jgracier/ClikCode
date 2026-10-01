import { describe, expect, it } from 'vitest';
import {
  codexIdTokenEmail, parseAmpUsage, parseClineProviders, parseCommandCodeWhoami, parseDevinAuthStatus,
  parseJunieCredentials, parseKiloProfile, parseKiroWhoami, parseOpenHandsUser,
} from './vendor-identity.js';

// Shapes copied from each vendor's real output on 2026-09-30, emails replaced.
describe('vendor account email', () => {
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
});
