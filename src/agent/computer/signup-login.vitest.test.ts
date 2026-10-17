import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { lockCredentialVault, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import { expectSignup, settleSignup } from './signup-login.js';

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
