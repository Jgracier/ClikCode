import { expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { frontPage } from './browser.js';

const tab = (name: string, visibility: 'visible' | 'hidden' | 'broken', closed = false) => ({
  name, isClosed: () => closed,
  evaluate: async () => { if (visibility === 'broken') throw new Error('internal page'); return visibility === 'visible'; },
}) as unknown as Page & { name: string };
const context = (...tabs: Page[]) => ({ pages: () => tabs }) as unknown as BrowserContext;

it('picks the tab in front, not the last one Chrome lists', async () => {
  const aws = tab('aws', 'hidden'); const salad = tab('salad', 'visible');
  expect(await frontPage(context(tab('chrome-signin', 'broken'), salad, aws))).toBe(salad);
});

it('takes the newest of several windows in front, ignores closed tabs, and falls back to the last tab', async () => {
  const one = tab('one', 'visible'); const two = tab('two', 'visible');
  expect(await frontPage(context(one, two, tab('gone', 'visible', true)))).toBe(two);
  const hidden = tab('hidden', 'hidden'); const last = tab('last', 'hidden');
  expect(await frontPage(context(hidden, last))).toBe(last);
  expect(await frontPage(context())).toBeUndefined();
});
