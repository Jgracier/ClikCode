/** Private site login used by both ClikCode's agent tool and a vendor chat's
 * worker command. Secret fields stay in the worker and never enter a model. */
import type { Page } from 'playwright-core';
import { fillCredential, saveCredential, soleCredentialForSite, type PrivateLogin } from './credential-vault.js';
import { protectLoginPage } from './private-page.js';

export async function loginComputerPage(input: {
  stateDir: string;
  page: Page;
  signal?: AbortSignal;
  ask(site: string, signal?: AbortSignal): Promise<PrivateLogin | undefined>;
}): Promise<void> {
  const site = new URL(input.page.url());
  if (site.protocol !== 'https:') throw new Error('Private login needs an HTTPS website.');
  protectLoginPage(input.page);
  let id = await soleCredentialForSite(input.stateDir, site.href);
  if (!id) {
    const secret = await input.ask(site.origin, input.signal);
    if (!secret) throw new Error('Private login cancelled.');
    if (input.signal?.aborted) throw new Error('Private login cancelled.');
    id = await saveCredential(input.stateDir, site.href, secret);
  }
  if (input.signal?.aborted) throw new Error('Private login cancelled.');
  await fillCredential(input.stateDir, input.page, id);
  const password = input.page.locator('input[type="password"]:visible');
  if (await password.count() !== 1) throw new Error('Login was filled, but its submit field changed. Use handoff.');
  await password.press('Enter');
}
