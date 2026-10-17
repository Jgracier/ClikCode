/** A password the user typed into a signup form (through the private prompt) is the login of the
 * account that form creates. Without this it would be typed once, never seen again, and lost.
 * It is saved to the vault only after the form has gone, with the email the form held. */
import type { Page } from 'playwright-core';
import { saveLoginFields } from './credential-vault.js';
import { sharedState } from './shared-state.js';

type Pending = { password: string; username?: string };
const pending = sharedState('signup-pending', () => new WeakMap<Page, Pending>());
const PASSWORD_FIELD = 'input[type="password"]';
const NAME_FIELD = 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"]';

export function expectSignup(page: Page, password: string): void { pending.set(page, { password }); }

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
    await saveLoginFields(stateDir, page.url(), { username: waiting.username, password: waiting.password });
    return `Saved the new login for ${new URL(page.url()).hostname} (${waiting.username}) in ClikCode Secrets Manager.`;
  } catch { return undefined; } // The page is navigating; the next step looks again.
}
