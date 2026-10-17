/** The one rule that keeps typed credentials out of what the agent reads: any page can be
 * read, but the VALUE of a password, one-time-code or card field never is. Nothing here
 * guesses which pages are "sign-in pages". */
import type { Page } from 'playwright-core';
import { allComputerPages } from './browser.js';

const SENSITIVE = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete^="cc-"]';
const MIN_LENGTH = 3;

/** What the sensitive fields on the page hold right now (including a password shown by a "show" toggle). */
export async function sensitiveValues(page: Page): Promise<string[]> {
  try {
    const values = await page.locator(SENSITIVE).evaluateAll(nodes => nodes.map(node => (node as unknown as { value?: string }).value ?? ''));
    return [...new Set(values.filter(value => value.length >= MIN_LENGTH))];
  } catch { return []; } // The page is navigating, or has no such field.
}

/** `text` with every sensitive field value on the page replaced. */
export async function maskSensitive(page: Page, text: string): Promise<string> {
  let out = text;
  for (const value of await sensitiveValues(page)) out = out.split(value).join('[hidden]');
  return out;
}

/** A typed or revealed credential is on a screen the desktop tool could photograph. */
export async function credentialOnScreen(stateDir: string): Promise<boolean> {
  let pages: Page[];
  try { pages = await allComputerPages(stateDir); }
  catch { return false; } // No ClikCode browser is open.
  for (const page of pages) if ((await sensitiveValues(page)).length) return true;
  return false;
}
