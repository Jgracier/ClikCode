/** Keep a login page out of model observations even if a website changes its
 * password input to text for a "show password" control. */
import { computerPage } from './browser.js';
import type { Page } from 'playwright-core';

const protectedPages = new WeakSet<Page>();

export function protectLoginPage(page: Page): void { protectedPages.add(page); }

export async function privateLoginPage(page: Page): Promise<boolean> {
  if (protectedPages.has(page)) return true;
  if (await page.locator('input[type="password"]:visible').count()) {
    protectLoginPage(page);
    return true;
  }
  return false;
}

export async function privateBrowserActive(stateDir: string): Promise<boolean> {
  try {
    const page = await computerPage(stateDir);
    for (const candidate of page.context().pages()) {
      if (!candidate.isClosed() && await privateLoginPage(candidate)) return true;
    }
    return false;
  }
  catch { return false; }
}
