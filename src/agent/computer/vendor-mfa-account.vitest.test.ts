import { describe, expect, it, vi, beforeEach } from 'vitest';

const runCli = vi.fn();
vi.mock('./run-cli.js', () => ({ runCli: (...args: unknown[]) => runCli(...args) }));

import { wantsAuthenticatorCode } from './login-page.js';
import { vendorMfaAccountFor, vendorMfaAccounts } from './secret-destinations.js';

describe('which kept authenticator belongs to a site', () => {
  const accounts = ['bamboohr/developer-portal', 'aws/root', 'acme/console', 'acme/billing'];
  it('matches the vendor part of the account to a label of the host', () => {
    expect(vendorMfaAccountFor('https://developers.bamboohr.com/multi-factor-auth?flow=login', accounts)).toBe('bamboohr/developer-portal');
    expect(vendorMfaAccountFor('https://signin.aws.amazon.com/', accounts)).toBe('aws/root');
  });
  it('picks none rather than guess between two accounts of one vendor, or for another site', () => {
    expect(vendorMfaAccountFor('https://console.acme.com/login', accounts)).toBeUndefined();
    expect(vendorMfaAccountFor('https://notbamboohr.com/login', accounts)).toBeUndefined();
    expect(vendorMfaAccountFor('not a url', accounts)).toBeUndefined();
    expect(vendorMfaAccountFor('https://io.example.com/', ['io/x'])).toBeUndefined();
  });
});

describe('vendorMfaAccounts', () => {
  beforeEach(() => runCli.mockReset());
  it('reads the account keys and nothing else', async () => {
    runCli.mockResolvedValue({ code: 0, missing: false, text: JSON.stringify({ status: 'success', data: { success: true, data: { accounts: [{ account: 'aws/root', label: 'AWS' }, { account: 'bamboohr/developer-portal' }] } } }) });
    expect(await vendorMfaAccounts()).toEqual(['aws/root', 'bamboohr/developer-portal']);
  });
  it('is empty when ClikDeploy cannot be asked', async () => {
    runCli.mockResolvedValue({ code: 1, missing: false, text: JSON.stringify({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'no' } }) });
    expect(await vendorMfaAccounts()).toEqual([]);
    runCli.mockResolvedValue({ code: null, missing: true, text: '' });
    expect(await vendorMfaAccounts()).toEqual([]);
  });
});

describe('a code box that is not the authenticator\'s', () => {
  it('leaves an emailed or texted code alone', () => {
    expect(wantsAuthenticatorCode('We sent a code to j***@gmail.com. Enter it below.')).toBe(false);
    expect(wantsAuthenticatorCode('Check your email for a sign-in code')).toBe(false);
    expect(wantsAuthenticatorCode('Enter the code from the text message')).toBe(false);
    expect(wantsAuthenticatorCode('Enter the 6-digit code from your authenticator app')).toBe(true);
    expect(wantsAuthenticatorCode('2-Step Login. Enter the 6-digit code')).toBe(true);
  });
});
