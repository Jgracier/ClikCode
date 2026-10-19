import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { generatePassword } from './signup-login.js';
import { lockCredentialVault, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import { expectSignup, holdSignup, settleSignup } from './signup-login.js';

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
