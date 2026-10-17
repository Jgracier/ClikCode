/** Keep a login page out of model observations even if a website changes its
 * password input to text for a "show password" control. */
import { computerPage } from './browser.js';
import { loginFields } from './login-fields.js';
import type { Page } from 'playwright-core';

const protectedPages = new WeakMap<Page, string>();

export function protectLoginPage(page: Page): void { protectedPages.set(page, page.url()); }

export async function privateLoginPage(page: Page): Promise<boolean> {
  if (protectedPages.get(page) === page.url()) return true;
  if (await page.locator('input[type="password"]:visible').count()) {
    protectLoginPage(page);
    return true;
  }
  try {
    const fields = await loginFields(page);
    if (fields.some(field => ['email', 'username', 'accountId'].includes(field.key))) {
      protectLoginPage(page);
      return true;
    }
  } catch { /* The page may be navigating; the old protection stays until its URL changes. */ }
  protectedPages.delete(page);
  return false;
}

export async function privateBrowserActive(stateDir: string): Promise<boolean> {
  let page: Page;
  try { page = await computerPage(stateDir); }
  catch { return false; } // No ClikCode browser is open.
  try {
    for (const candidate of page.context().pages()) {
      if (!candidate.isClosed() && await privateLoginPage(candidate)) return true;
    }
    return false;
  }
  catch { return true; } // A running browser that cannot be inspected stays private.
}
