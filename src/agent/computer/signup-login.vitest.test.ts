import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { generatePassword } from './signup-login.js';
import { lockCredentialVault, saveLoginFields, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import { expectSignup, holdSignup, savedPasswordFor, settleSignup, sitePasswordFor } from './signup-login.js';

let stateDir = '';
afterEach(async () => { if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

function formPage(state: { passwords: number }): Page {
  return {
    isClosed: () => false,
    url: () => 'https://signup.example.com/done',
    locator: (selector: string) => selector.includes(':visible')
      ? { count: async () => state.passwords }
      : { evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback([{ value: 'ada@example.com' }]) },
  } as unknown as Page;
}

it('keeps the login of a signup only after the password fields are gone, with the email the form held', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  const state = { passwords: 2 };
  const page = formPage(state);
  expectSignup(page, 'Zq9-correct-horse');
  expect(await settleSignup(stateDir, page)).toBeUndefined();
  expect(await savedLoginsForSite(stateDir, 'https://signup.example.com/')).toEqual([]);
  state.passwords = 0;
  expect(await settleSignup(stateDir, page)).toContain('Saved the new login');
  const [login] = await savedLoginsForSite(stateDir, 'https://signup.example.com/');
  expect(login?.label).toBe('ada@example.com');
  expect((await savedLoginFields(stateDir, 'https://signup.example.com/', login!.id)).password).toBe('Zq9-correct-horse');
  // Once saved it is not saved again.
  expect(await settleSignup(stateDir, page)).toBeUndefined();
});

it('makes a 24-character password with every class, differently each time', () => {
  const first = generatePassword();
  expect(first).toHaveLength(24);
  expect(first).toMatch(/[a-z]/); expect(first).toMatch(/[A-Z]/); expect(first).toMatch(/\d/); expect(first).toMatch(/[!@#$%^*_-]/);
  expect(generatePassword()).not.toBe(first);
});

it('keeps a generated password at once, then corrects the email once the form is gone', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  const state = { passwords: 2 };
  const page = formPage(state);
  await holdSignup(stateDir, page, 'Gen-4-ever-Zq9', 'me@example.com');
  const [early] = await savedLoginsForSite(stateDir, 'https://signup.example.com/');
  expect(early?.label).toBe('me@example.com');
  expect((await savedLoginFields(stateDir, 'https://signup.example.com/', early!.id)).password).toBe('Gen-4-ever-Zq9');
  state.passwords = 0;
  await settleSignup(stateDir, page);
  const all = await savedLoginsForSite(stateDir, 'https://signup.example.com/');
  expect(all).toHaveLength(1);
  expect(all[0]?.label).toBe('ada@example.com');
  expect((await savedLoginFields(stateDir, 'https://signup.example.com/', all[0]!.id)).password).toBe('Gen-4-ever-Zq9');
});

it('keeps one login when the same generated password is held again for the same form', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  const page = formPage({ passwords: 2 });
  await holdSignup(stateDir, page, 'Same-Gen-9', 'me@example.com');
  await holdSignup(stateDir, page, 'Same-Gen-9', 'me@example.com');
  expect(await savedLoginsForSite(stateDir, 'https://signup.example.com/')).toHaveLength(1);
});

it('keeps the password a signup replaces as previous_password, which a sign-in picker never shows', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  const page = formPage({ passwords: 0 });
  await saveLoginFields(stateDir, 'https://signup.example.com/', { username: 'ada@example.com', password: 'Old-one-Zq9' });
  expectSignup(page, 'New-one-Zq9');
  expect(await settleSignup(stateDir, page)).toContain('Saved the new login');
  const [login] = await savedLoginsForSite(stateDir, 'https://signup.example.com/');
  expect(await savedLoginFields(stateDir, 'https://signup.example.com/', login!.id)).toMatchObject({ password: 'New-one-Zq9', previous_password: 'Old-one-Zq9' });
  expect(login!.label).toBe('ada@example.com');
});

it('finds a generated login on the www and bare host alike', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  await saveLoginFields(stateDir, 'https://www.example.com/signup', { username: 'ada@example.com', password: 'Gen-4-ever-Zq9' });
  expect(await savedLoginsForSite(stateDir, 'https://example.com/login')).toHaveLength(1);
  expect(await savedPasswordFor(stateDir, 'https://example.com/login', 'Ada@Example.com')).toBe('Gen-4-ever-Zq9');
  expect(await savedLoginsForSite(stateDir, 'https://other.example.com/')).toEqual([]);
  expect(await savedPasswordFor(stateDir, 'https://example.com/login', undefined)).toBeUndefined();
});

it('a password box on a re-entry page gets the site password, never the profile one: typed, then by email, then the only login', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-signup-'));
  const page = (url: string) => ({ url: () => url } as unknown as Page);
  expect(await sitePasswordFor(stateDir, page('https://mapbox.example.com/verify'), 'ada@example.com')).toBeUndefined();
  await saveLoginFields(stateDir, 'https://mapbox.example.com/signup', { username: 'ada@example.com', password: 'Gen-site-Zq9' });
  expect(await sitePasswordFor(stateDir, page('https://mapbox.example.com/verify'), 'ADA@example.com')).toBe('Gen-site-Zq9');
  // The email is not known (a form filled box by box): the only login saved for the site is it.
  expect(await sitePasswordFor(stateDir, page('https://mapbox.example.com/verify'), undefined)).toBe('Gen-site-Zq9');
  // Two logins and no email to tell them apart: no guess.
  await saveLoginFields(stateDir, 'https://mapbox.example.com/signup', { username: 'bob@example.com', password: 'Other-Zq9' });
  expect(await sitePasswordFor(stateDir, page('https://mapbox.example.com/verify'), undefined)).toBeUndefined();
  // A password typed into this very form wins.
  const typed = page('https://mapbox.example.com/verify');
  expectSignup(typed, 'Typed-Zq9');
  expect(await sitePasswordFor(stateDir, typed, undefined)).toBe('Typed-Zq9');
});
