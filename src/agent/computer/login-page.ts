/** Fill the fields visible now. Multi-page logins keep partial answers
 * encrypted and ask again only when the next page needs a new field. */
import type { Page } from 'playwright-core';
import { saveLoginFields, savedLoginFields, soleCredentialForSite } from './credential-vault.js';
import { loginFields, type LoginField } from './login-fields.js';
import { protectLoginPage } from './private-page.js';

const active = new WeakMap<Page, { origin: string; id: string }>();

export async function loginComputerPage(input: {
  stateDir: string;
  page: Page;
  signal?: AbortSignal;
  ask(site: string, fields: readonly LoginField[], signal?: AbortSignal): Promise<Record<string, string> | undefined>;
}): Promise<void> {
  const site = new URL(input.page.url());
  if (site.protocol !== 'https:' || site.username || site.password) throw new Error('Private login needs an HTTPS website.');
  protectLoginPage(input.page);
  const fields = await loginFields(input.page);
  if (!fields.length) throw new Error('No login field is visible. Use handoff for verification or CAPTCHA.');
  if (fields.filter(field => field.kind === 'password').length > 1) throw new Error('Multiple password fields are visible. Use handoff.');
  let id = active.get(input.page)?.origin === site.origin ? active.get(input.page)!.id : await soleCredentialForSite(input.stateDir, site.href);
  const saved = id ? await savedLoginFields(input.stateDir, site.href, id) : {};
  const missing = fields.filter(field => !saved[field.key]);
  if (missing.length) {
    const supplied = await input.ask(site.origin, missing, input.signal);
    if (!supplied) throw new Error('Private login cancelled.');
    if (input.signal?.aborted) throw new Error('Private login cancelled.');
    if (new URL(input.page.url()).origin !== site.origin) throw new Error('The login moved to another website.');
    const values = Object.fromEntries(missing.map(field => [field.key, supplied[field.key] ?? '']));
    id = await saveLoginFields(input.stateDir, site.href, values, id);
    Object.assign(saved, values);
  }
  if (!id || input.signal?.aborted) throw new Error('Private login cancelled.');
  active.set(input.page, { origin: site.origin, id });
  for (const field of fields) {
    if (new URL(input.page.url()).origin !== site.origin) throw new Error('The login moved to another website.');
    await input.page.locator('input:visible').nth(field.index).fill(saved[field.key]);
  }
  await input.page.locator('input:visible').nth(fields.at(-1)!.index).press('Enter');
}
