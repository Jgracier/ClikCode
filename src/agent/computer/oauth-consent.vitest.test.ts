import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTasks } from './work-queue.js';
import { authorizationUrl, classifyStuck, oauthConnect, type ConsentStop, startFailure, callbackState, GENERIC_ACTIONS, nextPress, providerFor, stopReason, type Control } from './oauth-consent.js';

const press = (...names: string[]): Control[] => names.map(name => ({ name, leaf: false }));
const pick = (host: string, controls: Control[], text = '', options: { email?: string; skipAccount?: boolean } = {}): string | undefined => {
  const next = nextPress(host, controls, text, options);
  return next ? controls[next.index]!.name : undefined;
};

describe('provider table', () => {
  it('finds the provider family by host', () => {
    expect(providerFor('accounts.google.com')?.id).toBe('google');
    expect(providerFor('login.microsoftonline.com')?.id).toBe('microsoft');
    expect(providerFor('github.com')?.id).toBe('github');
    expect(providerFor('acme.slack.com')?.id).toBe('slack');
    expect(providerFor('auth.atlassian.com')?.id).toBe('atlassian');
    expect(providerFor('www.notion.so')?.id).toBe('notion');
    expect(providerFor('app.unknown-vendor.io')).toBeUndefined();
  });

  it('Google: the account first, then Advanced, Go to (unsafe), Continue', () => {
    const google = 'accounts.google.com';
    const chooser = press('Use another account', 'Me me@example.com', 'Other other@example.com');
    expect(pick(google, chooser, '', { email: 'me@example.com' })).toBe('Me me@example.com');
    // Once chosen on this page, it is not chosen again.
    expect(pick(google, chooser, '', { email: 'me@example.com', skipAccount: true })).toBeUndefined();
    expect(pick(google, [{ name: 'Advanced', leaf: true }, ...press('Back to safety')])).toBe('Advanced');
    expect(pick(google, press('Go to ClikDeploy (unsafe)', 'Back to safety'))).toBe('Go to ClikDeploy (unsafe)');
    expect(pick(google, press('Cancel', 'Continue'))).toBe('Continue');
    expect(pick(google, press('Cancel', 'Allow'))).toBe('Allow');
  });

  it('never picks the signed-in or switch-account entries as the account', () => {
    expect(pick('accounts.google.com', press('Sign out me@example.com', 'Remove me@example.com'), '', { email: 'me@example.com' })).toBeUndefined();
  });

  it('other families', () => {
    expect(pick('github.com', press('Cancel', 'Authorize ClikDeploy'))).toBe('Authorize ClikDeploy');
    expect(pick('acme.slack.com', press('Cancel', 'Allow'))).toBe('Allow');
    expect(pick('auth.atlassian.com', press('Cancel', 'Accept'))).toBe('Accept');
    expect(pick('www.notion.so', press('Cancel', 'Allow access'))).toBe('Allow access');
    expect(pick('login.microsoftonline.com', press('No', 'Yes'), 'Stay signed in?')).toBe('No');
    expect(pick('login.microsoftonline.com', press('No', 'Yes'), 'Pick an account')).toBeUndefined();
    expect(pick('login.microsoftonline.com', press('Cancel', 'Accept'))).toBe('Accept');
  });

  it('generic vendors: Allow / Authorize / Accept / Grant access, and Continue only on a permission screen', () => {
    for (const label of ['Allow', 'Authorize', 'Accept', 'Grant access', 'Authorize app']) expect(pick('app.vendor.io', press('Deny', label))).toBe(label);
    expect(pick('app.vendor.io', press('Continue'), 'Welcome back, sign in to continue')).toBeUndefined();
    expect(pick('app.vendor.io', press('Continue'), 'Acme wants to access your account')).toBe('Continue');
    expect(GENERIC_ACTIONS.length).toBeGreaterThan(1);
  });

  it('never presses a refusal, a sign-out or a sign-up, or a long sentence that merely contains Allow', () => {
    expect(pick('app.vendor.io', press('Deny', 'Cancel', 'Do not allow', 'Sign up', 'Allow all cookies from partners and advertisers today'))).toBeUndefined();
    expect(pick('app.vendor.io', press('Sign out'))).toBeUndefined();
  });
});

describe('stopReason', () => {
  it('stops at a password box, a code, or a captcha, and not at a plain consent page', () => {
    expect(stopReason('Sign in', true, false)).toContain('login password');
    expect(stopReason('Enter code', false, true)).toContain('verification code');
    expect(stopReason('We sent a text message with a code', false, false)).toContain('verification code');
    expect(stopReason('Please verify you are human. I\'m not a robot', false, false)).toBe('a captcha');
    expect(stopReason('Acme wants to access your Google Account. Allow', false, false)).toBeUndefined();
  });
});

describe('callbackState', () => {
  const redirect = 'https://clikdeploy.example/api/oauth/callback';
  it('knows the landing page, what it says, and other pages', () => {
    expect(callbackState('https://github.com/login/oauth/authorize', redirect, 'Authorize')).toBe('elsewhere');
    expect(callbackState(`${redirect}?code=x&state=y`, redirect, 'Slack connected. You can close this window.')).toBe('connected');
    expect(callbackState(`${redirect}?error=access_denied`, redirect, 'Connection failed: access denied')).toBe('problem');
    expect(callbackState(`${redirect}?code=x`, redirect, 'Loading')).toBe('waiting');
    expect(callbackState('https://x.test/oauth/callback?code=1', undefined, 'Connected')).toBe('connected');
  });
});

describe('authorizationUrl', () => {
  it('reads the URL from JSON or from a plain line', () => {
    expect(authorizationUrl('{"status":"ok","data":{"authorizationUrl":"https://v.example/auth?a=1&b=2"}}')).toBe('https://v.example/auth?a=1&b=2');
    expect(authorizationUrl('Open this URL to authorize:\nhttps://v.example/auth?x=1.\n')).toBe('https://v.example/auth?x=1');
    expect(authorizationUrl('{"status":"error","message":"nope"}')).toBeUndefined();
  });

  it('never takes an error document\'s type address (errors.clikdeploy.com) for the authorization URL', () => {
    const problem = '{"type":"https://errors.clikdeploy.com/VALIDATION_ERROR","title":"Validation failed","status":400,"detail":"Supabase declares no OAuth scopes","instance":"https://clikdeploy.com/api/connectors/supabase/oauth/start"}';
    expect(authorizationUrl(problem)).toBeUndefined();
    expect(authorizationUrl(`Error: ${problem}`)).toBeUndefined();
    expect(authorizationUrl('see https://errors.clikdeploy.com/VALIDATION_ERROR for details')).toBeUndefined();
    expect(authorizationUrl('{"data":{"state":"s","authorizationUrl":"https://v.example/a"},"type":"https://errors.clikdeploy.com/X"}')).toBeUndefined();
  });

  it('prefers the authorizationUrl field over other URLs in the document', () => {
    expect(authorizationUrl('{"data":{"docs":"https://d.example/help","authorizationUrl":"https://v.example/a"}}')).toBe('https://v.example/a');
  });
});

describe('startFailure', () => {
  it('reports the real message of an error document', () => {
    expect(startFailure('{"type":"https://errors.clikdeploy.com/VALIDATION_ERROR","status":400,"detail":"Supabase declares no OAuth scopes, so the request would be rejected."}')).toBe('Supabase declares no OAuth scopes, so the request would be rejected.');
    expect(startFailure('{"success":false,"error":"OAuth client not configured for x"}')).toBe('OAuth client not configured for x');
    expect(startFailure('boom\nline two')).toBe('boom line two');
  });
});

describe('a stuck page is reported with its words', () => {
  const stuck = async (text: string, options: { stateDir?: string; controls?: Control[] } = {}): Promise<Error> => {
    const page = {
      url: () => 'https://api.vendor.example/v1/oauth/authorize?client_id=abc&state=zzz',
      isClosed: () => false,
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      // readControls passes an argument; the page-text read does not.
      evaluate: async (_fn: unknown, arg?: unknown) => (arg === undefined ? text : (options.controls ?? [])),
      locator: () => ({ count: async () => 0 }),
    } as unknown as import('playwright-core').Page;
    const error = await oauthConnect('vendor', page, { start: async () => ({ url: 'https://api.vendor.example/v1/oauth/authorize?redirect_uri=https%3A%2F%2Fcd.example%2Fcallback', stop: () => undefined }), status: async () => ({ connected: false }), timeoutMs: 20_000, ...(options.stateDir ? { stateDir: options.stateDir } : {}) }).then(() => undefined, (e: Error) => e);
    return error!;
  };

  it('includes the JSON error body and classifies an unrecognized client', async () => {
    const error = await stuck('{"message":"Unrecognized client_id"}');
    expect(error.message).toContain('JSON error: "{"message":"Unrecognized client_id"}"');
    expect(error.message).toContain('does not recognize the OAuth client');
    expect((error as ConsentStop).reason).toBeUndefined();
  });

  it('truncates the page text to about 300 characters, masks tokens and addresses, and says what it is', async () => {
    const error = await stuck(`You have no API credits. Add credits to continue. me@example.com ${'x'.repeat(40)} ${'filler '.repeat(100)}`);
    expect(error.message).toContain('Page text: "You have no API credits.');
    expect(error.message).not.toContain('me@example.com');
    expect(error.message).not.toContain('x'.repeat(40));
    expect(error.message.length).toBeLessThan(900);
    expect(error.message).toContain('wants payment');
  });

  it('records a payment-class stop in the human queue with reason payment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-oauth-'));
    try {
      const error = await stuck('Out of credits. Add credits or a billing method to continue.', { stateDir: dir });
      expect((error as ConsentStop).reason).toBe('payment');
      expect(error.message).toContain('Recorded in the human queue');
      const [task] = await listTasks(dir);
      expect(task).toMatchObject({ vendor: 'vendor', kind: 'oauth-app', status: 'needs-human', reason: 'payment', connectors: ['vendor'] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not record anything for an unrecognized client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-oauth-'));
    try {
      await stuck('{"message":"Unrecognized client_id"}', { stateDir: dir });
      expect(await listTasks(dir)).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('classifies captcha and MFA/SMS words', () => {
    expect(classifyStuck('Please verify you are human')?.kind).toBe('captcha');
    expect(classifyStuck('We sent a code to your phone by text message')?.kind).toBe('mfa');
    expect(classifyStuck('Acme wants to access your account')).toBeUndefined();
  });
});
