/** A password the user typed into a signup form (through the private prompt) is the login of the
 * account that form creates. Without this it would be typed once, never seen again, and lost.
 * It is saved to the vault only after the form has gone, with the email the form held. */
import type { Page } from 'playwright-core';
import { savedLoginFields, savedLoginsForSite, saveLoginFields } from './credential-vault.js';
import { sharedState } from './shared-state.js';

type Pending = { password: string; username?: string; itemId?: string };
const pending = sharedState('signup-pending', () => new WeakMap<Page, Pending>());
const PASSWORD_FIELD = 'input[type="password"]';
const NAME_FIELD = 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"]';

/** The password this page's signup form already has (a form filled one box per call needs the same value in both). */
export function pendingSignupPassword(page: Page): string | undefined { return pending.get(page)?.password; }

export function pendingSignupUsername(page: Page): string | undefined { return pending.get(page)?.username; }

export function expectSignup(page: Page, password: string): void { pending.set(page, { password }); }

/** A password the tool made up: kept in the vault at once, under the account email it is most likely for, so a signup
 * that is submitted, redirected or abandoned half-way never loses it. settleSignup later corrects the email to the
 * one the form really held. */
export async function holdSignup(stateDir: string, page: Page, password: string, username: string | undefined): Promise<void> {
  if (pending.get(page)?.password === password) return; // the same form, filled box by box: already kept
  const held: Pending = { password, ...(username ? { username } : {}) };
  if (username) {
    // A password this replaces is kept as `previous_password`: the account may already have been made with it.
    const old = await savedPasswordFor(stateDir, page.url(), username, { rejected: true });
    held.itemId = await saveLoginFields(stateDir, page.url(), { username, password, ...(old && old !== password ? { previous_password: old } : {}) });
  }
  pending.set(page, held);
}

/** The password saved for this site and account (`email`), if any. A login the site refused is only returned when asked for. */
export async function savedPasswordFor(stateDir: string, url: string, username: string | undefined, options: { rejected?: boolean } = {}): Promise<string | undefined> {
  if (!username) return undefined;
  try {
    const found = (await savedLoginsForSite(stateDir, url)).find(login => login.label.split(' · ').some(value => value.toLowerCase() === username.toLowerCase()));
    return found && (options.rejected || !found.rejected) ? (await savedLoginFields(stateDir, url, found.id)).password : undefined;
  } catch { return undefined; }
}

/** The password this site's account uses, for a password box that is not a sign-up: the one typed into this page's form, else the
 * one saved for this site and `email`, else the only usable login saved for the site. Undefined when the vault holds none, and only
 * then may a caller fall back to the profile's own password. */
export async function sitePasswordFor(stateDir: string, page: Page, email: string | undefined): Promise<string | undefined> {
  const typed = pendingSignupPassword(page);
  if (typed) return typed;
  const byEmail = await savedPasswordFor(stateDir, page.url(), email);
  if (byEmail) return byEmail;
  try {
    const usable = (await savedLoginsForSite(stateDir, page.url())).filter(login => !login.rejected);
    return usable.length === 1 ? (await savedLoginFields(stateDir, page.url(), usable[0]!.id)).password : undefined;
  } catch { return undefined; }
}

/** Call after each step: remembers the email the form holds, and saves the login once the password fields are gone. */
export async function settleSignup(stateDir: string, page: Page): Promise<string | undefined> {
  const waiting = pending.get(page);
  if (!waiting || page.isClosed()) return undefined;
  try {
    const username = (await page.locator(NAME_FIELD).evaluateAll(nodes => nodes.map(node => (node as unknown as { value?: string }).value ?? '').find(value => value.includes('@')))) as string | undefined;
    if (username) waiting.username = username;
    if (await page.locator(`${PASSWORD_FIELD}:visible`).count()) return undefined;
    pending.delete(page);
    if (!waiting.username) return undefined;
    // A password this replaces is kept as `previous_password`: the account may already have been made with it.
    const old = await savedPasswordFor(stateDir, page.url(), waiting.username, { rejected: true });
    await saveLoginFields(stateDir, page.url(), { username: waiting.username, password: waiting.password, ...(old && old !== waiting.password ? { previous_password: old } : {}) }, waiting.itemId);
    return `Saved the new login for ${new URL(page.url()).hostname} (${waiting.username}) in ClikCode Secrets Manager.`;
  } catch { return undefined; } // The page is navigating; the next step looks again.
}

export { generatePassword } from './password-policy.js';
