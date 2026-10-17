import { expect, it } from 'vitest';
import { privateLoginPage } from './private-page.js';
import type { Page } from 'playwright-core';

it('keeps the same login page private when a show-password control changes the input type', async () => {
  let url = 'https://example.com/login';
  let passwordField = true;
  const page = { url: () => url, locator: () => ({ count: async () => passwordField ? 1 : 0 }) } as unknown as Page;
  expect(await privateLoginPage(page)).toBe(true);
  passwordField = false;
  expect(await privateLoginPage(page)).toBe(true);
  url = 'https://example.com/account';
  expect(await privateLoginPage(page)).toBe(false);
});
