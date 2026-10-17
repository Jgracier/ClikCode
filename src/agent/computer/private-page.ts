/** Keep a login page out of model observations even if a website changes its
 * password input to text for a "show password" control. */
import { allComputerPages } from './browser.js';
import { loginFields, loginScope } from './login-fields.js';
import type { Page } from 'playwright-core';

const protectedPages = new WeakMap<Page, string>();

/** Paths that mean a sign-in or verification step; shared with the login flow. */
export const AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|auth|oauth|authenticate|challenge|verify|verification|mfa|otp|2fa|2sv|two-factor|sso|saml)(?:\/|$)/i;

export function protectLoginPage(page: Page): void { protectedPages.set(page, page.url()); }

export async function privateLoginPage(page: Page): Promise<boolean> {
  if (protectedPages.get(page) === page.url()) return true;
  // Identity providers commonly show account details or recovery hints after
  // the credential form has navigated to a challenge page.
  try {
    const path = new URL(page.url()).pathname;
    if (AUTH_PATH.test(path)) {
      protectLoginPage(page);
      return true;
    }
  } catch { /* Inspect the fields below if the URL is transient. */ }
  if (await (await loginScope(page)).locator('input[type="password"]:visible:not([autocomplete="new-password"])').count()) {
    // (A field that creates a password, on a signup form, is filled with a private prompt and does not hide the page.)
    // One masked field labelled as a key or token (an account's API-key page) is a
    // credential on display, not a sign-in: its value is hidden by the key
    // redaction, and the rest of the page stays readable.
    const lone = await loginFields(page).then(fields => fields.length === 1 && fields[0]!.kind === 'password' && /api|key|token|secret/i.test(fields[0]!.label)).catch(() => false);
    if (!lone) {
      protectLoginPage(page);
      return true;
    }
  }
  try {
    const fields = await loginFields(page);
    // Only a one-time code makes a page private by its fields: an email or name box is also on
    // every signup and contact form, which the agent reads normally and fills with what the user gave it.
    if (fields.some(field => field.key === 'code')) {
      protectLoginPage(page);
      return true;
    }
  } catch { /* The page may be navigating; the old protection stays until its URL changes. */ }
  protectedPages.delete(page);
  return false;
}

export async function privateBrowserActive(stateDir: string): Promise<boolean> {
  let pages: Page[];
  try { pages = await allComputerPages(stateDir); }
  catch { return false; } // No ClikCode browser is open.
  try {
    for (const candidate of pages) if (await privateLoginPage(candidate)) return true;
    return false;
  }
  catch { return true; } // A running browser that cannot be inspected stays private.
}
