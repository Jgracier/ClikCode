import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../tool-contract.js';
import { lockCredentialVault, saveLoginFields, savedLoginFields, savedLoginsForSite } from '../computer/credential-vault.js';

const browser = vi.hoisted(() => {
  const filled: string[] = [];
  let step = 0;
  let advance = true;
  let emailOnly = false;
  let mfa = false;
  let rejectAt = -1;
  let rejections = 0;
  let finishUrl = 'https://mail.google.com/mail/u/0/';
  const field = (type: string, name: string, label: string, autocomplete = type === 'password' ? 'current-password' : 'username') => ({
    type, name, id: name, autocomplete, required: true, placeholder: '', labels: [],
    getAttribute: (attribute: string) => attribute === 'aria-label' ? label : null,
  });
  const last = () => mfa ? 3 : 2;
  const page = {
    url: () => rejections && step === rejectAt ? `https://accounts.google.com/v3/signin/again/${rejections}`
      : step === 0 ? 'https://accounts.google.com/v3/signin/identifier'
      : step === 1 ? 'https://accounts.google.com/v3/signin/pwd'
      : step === 2 && mfa ? 'https://accounts.google.com/v3/signin/challenge/totp' : finishUrl,
    waitForTimeout: async () => {},
    locator: (selector: string) => ({
      count: async () => selector.includes('password') ? Number(step === 1) : Number(step < 2),
      evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback(step >= last() ? [] : [
        step === 0 ? field('text', 'identifier', 'Email or phone') : step === 1 ? field('password', 'password', 'Password')
          : field('text', 'totp', 'Enter the 6-digit code', 'one-time-code')]),
      nth: () => ({
        fill: async (value: string) => { filled.push(value); },
        press: async (key: string) => {
          filled.push(key);
          if (step === rejectAt) { rejections++; return; }
          if (advance) step = emailOnly && step === 0 ? last() : step + 1;
        },
      }),
      fill: async (value: string) => { filled.push(value); },
      press: async (key: string) => { filled.push(key); },
    }),
    getByRole: () => ({ count: async () => 0 }),
  };
  return { filled, page,
    reset: () => { step = 0; advance = true; emailOnly = false; mfa = false; rejectAt = -1; rejections = 0; finishUrl = 'https://mail.google.com/mail/u/0/'; },
    stopAdvancing: () => { advance = false; }, rejectPassword: () => { rejectAt = 1; }, rejectCode: () => { mfa = true; rejectAt = 2; },
    requireMfa: () => { mfa = true; }, reuseSession: () => { emailOnly = true; }, signedIn: () => { step = last(); },
    requireVerification: () => { finishUrl = 'https://accounts.google.com/v3/signin/challenge/dp'; } };
});
vi.mock('../computer/browser.js', () => ({ computerPage: async () => browser.page }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));

import { computerWebTool } from './computer-web.js';

let stateDir = '';
afterEach(async () => {
  if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; }
  browser.filled.length = 0;
  browser.reset();
});

it('follows both Gmail fields in one call without returning credentials to the model', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-'));
  const asked: string[][] = [];
  const ctx = {
    stateDir, requestPrivateLogin: async (_site: string, fields: { key: string }[]) => {
      asked.push(fields.map(field => field.key));
      return Object.fromEntries(fields.map(field => [field.key, field.key === 'password' ? 'private-secret' : 'private@example.com']));
    },
  } as ToolContext;
  const result = await computerWebTool.run({ action: 'login' }, ctx);
  expect(result.isError).toBeUndefined();
  expect(asked).toEqual([['username', 'password']]);
  expect(browser.filled).toEqual(['private@example.com', 'Enter', 'private-secret', 'Enter']);
  expect(JSON.stringify(result)).not.toContain('private@example.com');
  expect(JSON.stringify(result)).not.toContain('private-secret');
  const items = await readdir(join(stateDir, 'computer', 'vault', 'items'));
  expect(items).toHaveLength(1);
  const encrypted = await readFile(join(stateDir, 'computer', 'vault', 'items', items[0]), 'utf8');
  expect(encrypted).not.toContain('private@example.com');
  expect(encrypted).not.toContain('private-secret');
  browser.reset();
  await computerWebTool.run({ action: 'login' }, ctx);
  expect(asked).toEqual([['username', 'password']]);
});

it('does not save new answers when a form stays on the login page', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-rejected-'));
  browser.stopAdvancing();
  const result = await computerWebTool.run({ action: 'login' }, {
    stateDir, requestPrivateLogin: async () => ({ username: 'wrong@example.com', password: 'wrong-pw' }),
  } as ToolContext);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('not saved');
  await expect(readdir(join(stateDir, 'computer', 'vault', 'items'))).rejects.toThrow();
});

it('does not save a password while verification is still pending', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-mfa-'));
  browser.requireVerification();
  const result = await computerWebTool.run({ action: 'login' }, {
    stateDir, requestPrivateLogin: async (_site: string, fields: { key: string }[]) =>
      Object.fromEntries(fields.map(field => [field.key, field.key === 'password' ? 'private-secret' : 'private@example.com'])),
  } as ToolContext);
  expect(result.output).toMatch(/erification is still pending/);
  expect(result.output).toContain('not saved');
  await expect(readdir(join(stateDir, 'computer', 'vault', 'items'))).rejects.toThrow();
});

it('reports an existing browser session without saving an email-only attempt', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-session-'));
  browser.reuseSession();
  const result = await computerWebTool.run({ action: 'login' }, {
    stateDir, requestPrivateLogin: async () => ({ username: 'private@example.com', password: 'unused-pw' }),
  } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('existing session may have been reused');
  expect(result.output).not.toContain('private@example.com');
  await expect(readdir(join(stateDir, 'computer', 'vault', 'items'))).rejects.toThrow();
});

it('does not fall back to a phone credential link when no private client UI is attached', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-headless-'));
  const result = await computerWebTool.run({ action: 'login' }, { stateDir } as ToolContext);
  expect(result.isError).toBe(true);
  expect(result.output).toBe('This chat cannot show private login fields.');
  expect(result.output).not.toContain('https://jgracier.github.io');
});


const GOOGLE = 'https://accounts.google.com/';
const NEW_ACCOUNT = 'Use a different account';
const seed = (username: string, password: string): Promise<string> => saveLoginFields(stateDir, GOOGLE, { username, password });
/** Answers the way a person would: the named account (or a new one) from the picker, then typed fields. */
function person(answers: { account?: string; username?: string; password?: string }, asked: { key: string; kind: string; options?: readonly string[] }[][] = []): ToolContext {
  return {
    stateDir, requestPrivateLogin: async (_site: string, fields: { key: string; kind: string; options?: readonly string[] }[]) => {
      asked.push(fields);
      const given = fields.map(field => [field.key, answers[field.key as 'account' | 'username' | 'password']] as const);
      return given.some(([, value]) => value === undefined) ? undefined : Object.fromEntries(given);
    },
  } as ToolContext;
}

it('uses the one saved account without asking anything', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-one-'));
  await seed('one@example.com', 'pw-one');
  const asked: { key: string; kind: string }[][] = [];
  const result = await computerWebTool.run({ action: 'login' }, person({}, asked));
  expect(result.isError).toBeUndefined();
  expect(asked).toEqual([]);
  expect(browser.filled).toEqual(['one@example.com', 'Enter', 'pw-one', 'Enter']);
  expect(JSON.stringify(result)).not.toMatch(/one@example|pw-one/);
});

it('shows a picker of the saved usernames when there are several, then signs in with the chosen one', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-pick-'));
  await seed('two@example.com', 'pw-two');
  await seed('one@example.com', 'pw-one');
  const asked: { key: string; kind: string; options?: readonly string[] }[][] = [];
  const result = await computerWebTool.run({ action: 'login' }, person({ account: 'two@example.com' }, asked));
  expect(result.isError).toBeUndefined();
  expect(asked).toHaveLength(1);
  expect(asked[0]![0]).toMatchObject({ kind: 'choice', options: ['one@example.com', 'two@example.com', NEW_ACCOUNT] });
  expect(browser.filled).toEqual(['two@example.com', 'Enter', 'pw-two', 'Enter']);
  expect(JSON.stringify(result)).not.toMatch(/one@example|two@example|pw-/);
});

it('signs nothing in when the picker is dismissed', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-dismiss-'));
  await seed('one@example.com', 'pw-one');
  await seed('two@example.com', 'pw-two');
  const result = await computerWebTool.run({ action: 'login' }, person({}));
  expect(result.isError).toBe(true);
  expect(browser.filled).toEqual([]);
});

it('adds a third account from the picker', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-add-'));
  await seed('one@example.com', 'pw-one');
  await seed('two@example.com', 'pw-two');
  const answers = { account: NEW_ACCOUNT, username: 'three@example.com', password: 'pw-three' };
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: keyof typeof answers }[]) => Object.fromEntries(fields.map(field => [field.key, answers[field.key]])) } as ToolContext;
  expect((await computerWebTool.run({ action: 'login' }, ctx)).isError).toBeUndefined();
  expect((await savedLoginsForSite(stateDir, GOOGLE)).map(login => login.label)).toEqual(['one@example.com', 'three@example.com', 'two@example.com']);
});

it('updates an account instead of duplicating it when the same username is entered again', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-same-'));
  const first = await seed('one@example.com', 'pw-old');
  await seed('two@example.com', 'pw-two');
  const answers = { account: NEW_ACCOUNT, username: 'one@example.com', password: 'pw-new' };
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: keyof typeof answers }[]) => Object.fromEntries(fields.map(field => [field.key, answers[field.key]])) } as ToolContext;
  expect((await computerWebTool.run({ action: 'login' }, ctx)).isError).toBeUndefined();
  expect(await savedLoginsForSite(stateDir, GOOGLE)).toHaveLength(2);
  expect((await savedLoginFields(stateDir, GOOGLE, first)).password).toBe('pw-new');
});

it('lets the user choose a different account even when only one is saved', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-new-'));
  await seed('one@example.com', 'pw-one');
  const asked: { key: string; kind: string }[][] = [];
  const answers = { username: 'other@example.com', password: 'pw-other' };
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: keyof typeof answers; kind: string }[]) => { asked.push(fields); return Object.fromEntries(fields.map(field => [field.key, answers[field.key]])); } } as ToolContext;
  expect((await computerWebTool.run({ action: 'login', new_account: true }, ctx)).isError).toBeUndefined();
  expect(asked.map(fields => fields.map(field => field.key))).toEqual([['username', 'password']]);
  expect(await savedLoginsForSite(stateDir, GOOGLE)).toHaveLength(2);
});

it('offers the picker again after the site refuses a saved password, so a new one can be entered', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-refused-'));
  const id = await seed('one@example.com', 'pw-stale');
  browser.rejectPassword();
  const refused = await computerWebTool.run({ action: 'login' }, person({}));
  expect(refused.isError).toBe(true);
  expect(refused.output).toContain('did not accept the saved password');
  expect((await savedLoginsForSite(stateDir, GOOGLE))[0]).toMatchObject({ id, rejected: true });

  browser.reset();
  browser.filled.length = 0;
  const answers = { account: NEW_ACCOUNT, username: 'one@example.com', password: 'pw-fixed' };
  const asked: { key: string; kind: string }[][] = [];
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: keyof typeof answers; kind: string }[]) => { asked.push(fields); return Object.fromEntries(fields.map(field => [field.key, answers[field.key]])); } } as ToolContext;
  expect((await computerWebTool.run({ action: 'login' }, ctx)).isError).toBeUndefined();
  expect(asked[0]![0]!.kind).toBe('choice');
  expect(await savedLoginsForSite(stateDir, GOOGLE)).toEqual([{ id, label: 'one@example.com', rejected: false }]);
  expect((await savedLoginFields(stateDir, GOOGLE, id)).password).toBe('pw-fixed');
});

it('asks for a one-time code every time, fills it, and never saves it', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-code-'));
  browser.requireMfa();
  const asked: string[][] = [];
  const answers: Record<string, string> = { username: 'one@example.com', password: 'pw-one', code: '123456' };
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: string }[]) => { asked.push(fields.map(field => field.key)); return Object.fromEntries(fields.map(field => [field.key, answers[field.key]!])); } } as ToolContext;
  const first = await computerWebTool.run({ action: 'login' }, ctx);
  expect(first.isError).toBeUndefined();
  expect(asked).toEqual([['username', 'password'], ['code']]);
  expect(browser.filled).toEqual(['one@example.com', 'Enter', 'pw-one', 'Enter', '123456', 'Enter']);
  const [saved] = await savedLoginsForSite(stateDir, GOOGLE);
  expect(Object.keys(await savedLoginFields(stateDir, GOOGLE, saved!.id)).sort()).toEqual(['password', 'username']);
  expect(JSON.stringify(first)).not.toMatch(/123456|one@example|pw-one/);

  browser.reset(); browser.requireMfa(); browser.filled.length = 0; asked.length = 0;
  answers.code = '654321';
  expect((await computerWebTool.run({ action: 'login' }, ctx)).isError).toBeUndefined();
  expect(asked).toEqual([['code']]);
  expect(browser.filled).toEqual(['one@example.com', 'Enter', 'pw-one', 'Enter', '654321', 'Enter']);
});

it('stops after two wrong codes and saves nothing', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-badcode-'));
  browser.rejectCode();
  const asked: string[][] = [];
  const answers: Record<string, string> = { username: 'one@example.com', password: 'pw-one', code: '000000' };
  const ctx = { stateDir, requestPrivateLogin: async (_s: string, fields: { key: string }[]) => { asked.push(fields.map(field => field.key)); return Object.fromEntries(fields.map(field => [field.key, answers[field.key]!])); } } as ToolContext;
  const result = await computerWebTool.run({ action: 'login' }, ctx);
  expect(result.isError).toBe(true);
  expect(asked.filter(fields => fields[0] === 'code')).toHaveLength(2);
  expect(await savedLoginsForSite(stateDir, GOOGLE)).toEqual([]);
});

it('says why when there is nothing to sign in to, without quoting the page', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-none-'));
  browser.signedIn();
  const result = await computerWebTool.run({ action: 'login' }, person({}));
  expect(result.isError).toBe(true);
  expect(result.output).toBe('No sign-in form is visible. If a verification or CAPTCHA is showing, use handoff.');
});
