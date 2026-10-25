import { describe, expect, it } from 'vitest';
import { authorizationUrl, callbackState, GENERIC_ACTIONS, nextPress, providerFor, stopReason, type Control } from './oauth-consent.js';

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
});
