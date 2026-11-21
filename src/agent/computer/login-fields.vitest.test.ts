import { expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { LoginError } from './login-error.js';
import { loginFields, loginFieldSummary, pageControls, savedLoginValues, type LoginField } from './login-fields.js';
import { observeComputerPage } from '../tools/computer-web.js';

it('reads a sign-in page like any other, with the value of a password field masked', async () => {
  const input = {
    type: 'text', name: 'identifier', id: 'identifierId', autocomplete: 'username webauthn', required: true,
    placeholder: '', labels: [], value: 'private@example.com',
    getAttribute: (key: string) => key === 'aria-label' ? 'Email or phone' : null,
  };
  const typed = 'hunter2-typed';
  const page = {
    url: () => 'https://accounts.google.com/v3/signin/identifier',
    locator: (selector: string) => selector === 'input:visible'
      ? { evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback([input]) }
      : { evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback([{ value: typed }]), count: async () => 0 },
    ariaSnapshot: async () => `- textbox "Email or phone" [ref=e1]\n- textbox "Password" [ref=e2]: ${typed}\n- button "Next" [ref=e3]`,
  } as unknown as Page;
  expect((await loginFields(page)).map(field => [field.key, field.label])).toEqual([['username', 'Email or phone']]);
  const observation = await observeComputerPage(page, false);
  expect(observation.output).toContain('textbox "Email or phone"');
  expect(observation.output).toContain('button "Next"');
  expect(JSON.stringify(observation)).not.toContain(typed);
});

it('recognizes an account ID, email and password form from the fields actually on the page', async () => {
  const nodes = [
    ['text', 'accountId', 'Account ID'], ['email', 'email', 'Email'], ['password', 'password', 'Password'],
  ].map(([type, name, label]) => ({
    type, name, id: name, autocomplete: '', required: true, placeholder: '', labels: [], value: `private-${name}`,
    getAttribute: (key: string) => key === 'aria-label' ? label : null,
  }));
  const page = { locator: () => ({ evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback(nodes) }) } as unknown as Page;
  expect((await loginFields(page)).map(({ key, label }) => [key, label])).toEqual([
    ['accountId', 'Account ID'], ['email', 'Email'], ['password', 'Password'],
  ]);
});

it('lists the buttons and links by name so the agent can press one or ask which, without naming any account', async () => {
  const names = ['Sign in using root user email', 'Sign in as IAM user', 'Justin Gracier justin@example.com', 'Privacy', '', 'Use another account', 'Sign in using root user email', 'x'.repeat(80)];
  const page = { locator: () => ({ evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback(names.map(innerText => ({ innerText, getAttribute: () => null }))) }) } as unknown as Page;
  const controls = await pageControls(page);
  expect(controls).toEqual(['Sign in using root user email', 'Sign in as IAM user', 'Privacy', 'Use another account']);
  const summary = loginFieldSummary('https://signin.aws.amazon.com', [], controls);
  expect(summary).toContain('Sign in as IAM user');
  expect(summary).toContain('ask_user');
  expect(summary).toContain('picks one');
  expect(summary).not.toContain('justin@example.com');
  expect(loginFieldSummary('https://example.com', [])).not.toContain('Buttons and links');
});

it('takes an unlabelled box named in one word (oneTimeCode, authCode, otp_code) for a code box, and not a postcode', async () => {
  const fieldsOf = async (names: string[]) => {
    const nodes = names.map(name => ({ type: 'text', name, id: name, autocomplete: '', required: true, placeholder: '', labels: [], value: '', getAttribute: () => null }));
    const page = { locator: () => ({ evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback(nodes) }) } as unknown as Page;
    return (await loginFields(page)).map(({ key, transient }) => [key, transient === true]);
  };
  expect(await fieldsOf(['oneTimeCode'])).toEqual([['code', true]]);
  expect(await fieldsOf(['authCode'])).toEqual([['code', true]]);
  expect(await fieldsOf(['otp_code'])).toEqual([['code', true]]);
  expect(await fieldsOf(['mfaCode'])).toEqual([['code', true]]);
  expect((await fieldsOf(['postcode']))[0]![1]).toBe(false);
  expect((await fieldsOf(['barcode']))[0]![1]).toBe(false);
});

const box = (key: string, label: string, kind: LoginField['kind'] = 'text'): LoginField => ({ index: 0, key, label, kind, required: true });
const fieldsFrom = async (inputs: [type: string, name: string, label: string][]): Promise<LoginField[]> => {
  const nodes = inputs.map(([type, name, label]) => ({ type, name, id: name, autocomplete: '', required: true, placeholder: '', labels: [], value: '', getAttribute: (key: string) => key === 'aria-label' ? label : null }));
  return loginFields({ locator: () => ({ evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback(nodes) }) } as unknown as Page);
};

it('refuses the AWS IAM form for a saved login that holds only an email and password, naming the fields and the way out', async () => {
  const iam = await fieldsFrom([['text', 'account', 'Account ID or alias'], ['text', 'username', 'IAM username'], ['password', 'password', 'Password']]);
  expect(iam.map(field => field.key)).toEqual(['accountId', 'username', 'password']);
  for (const saved of [{ username: 'root@example.com', password: 'pw' }, { email: 'root@example.com', password: 'pw' }] as Record<string, string>[]) {
    let refusal: unknown;
    try { savedLoginValues(iam, saved); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(LoginError);
    const message = (refusal as Error).message;
    expect(message).toContain('Nothing was typed or pressed');
    expect(message).toContain('"Account ID or alias"');
    expect(message).toContain('holds only an email');
    expect(message).toContain('new_account');
    expect(message).not.toContain('root@example.com');
  }
  // The email-only saved login has no IAM username either: both boxes are named.
  expect(() => savedLoginValues(iam, { email: 'root@example.com', password: 'pw' })).toThrow('"Account ID or alias" and "IAM username"');
  // A login saved from this very form fits it.
  expect(savedLoginValues(iam, { accountId: '123456789012', username: 'deploy', password: 'pw' })).toEqual({ accountId: '123456789012', username: 'deploy' });
});

it('takes a tenant, workspace or organisation box for an account box of its own, never an email or username box', async () => {
  for (const label of ['Tenant', 'Workspace URL', 'Organization ID', 'Organisation', 'Company ID', 'Account number']) {
    const [field] = await fieldsFrom([['text', 'f', label]]);
    expect([label, field!.key]).toEqual([label, 'accountId']);
    expect(() => savedLoginValues([field!, box('password', 'Password', 'password')], { username: 'ada@example.com', password: 'pw' })).toThrow(LoginError);
  }
});

it('answers a plain email and password form, and a username and password form, from the saved login', () => {
  const password = box('password', 'Password', 'password');
  expect(savedLoginValues([box('email', 'Email'), password], { email: 'ada@example.com', password: 'pw' })).toEqual({ email: 'ada@example.com' });
  // A login saved from an "Email or phone" box is kept as its username: an email box takes it, because it is an email.
  expect(savedLoginValues([box('email', 'Email'), password], { username: 'ada@example.com', password: 'pw' })).toEqual({ email: 'ada@example.com' });
  expect(savedLoginValues([box('username', 'Username'), password], { username: 'ada', password: 'pw' })).toEqual({ username: 'ada' });
  // The form's only account box ("Email or username") takes the saved email.
  expect(savedLoginValues([box('username', 'Email or username')], { email: 'ada@example.com', password: 'pw' })).toEqual({ username: 'ada@example.com' });
  // A password-only or code-only page asks the saved login for no account value.
  expect(savedLoginValues([password], { username: 'ada', password: 'pw' })).toEqual({});
  expect(savedLoginValues([{ ...box('code', 'Code'), transient: true }], { username: 'ada', password: 'pw' })).toEqual({});
  // With no saved login every box is asked of the person.
  expect(savedLoginValues([box('accountId', 'Account ID'), box('username', 'Username'), password], {})).toEqual({});
});

it('never gives one saved value to two account boxes, and a username that is no email to an email box', () => {
  const password = box('password', 'Password', 'password');
  expect(() => savedLoginValues([box('email', 'Email'), box('username', 'Username'), password], { username: 'ada@example.com', password: 'pw' })).toThrow(LoginError);
  expect(() => savedLoginValues([box('username', 'Username'), box('username_2', 'Confirm username'), password], { username: 'ada', password: 'pw' })).toThrow('"Confirm username"');
  expect(() => savedLoginValues([box('email', 'Email'), password], { username: 'ada', password: 'pw' })).toThrow('holds only a username');
  expect(savedLoginValues([box('email', 'Email'), box('username', 'Username'), password], { email: 'ada@example.com', username: 'ada', password: 'pw' })).toEqual({ email: 'ada@example.com', username: 'ada' });
});
