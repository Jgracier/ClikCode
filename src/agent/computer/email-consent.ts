/** Drives Google's consent screens in the ClikCode browser, already signed in, so connecting a mailbox is one command and no extra steps. */
import type { Page } from 'playwright-core';
import { startConsent, type GoogleEndpoints } from './email-api.js';

/** Where the browser is when consent stalls: the address (no query) and the names of what can be pressed, never a field's value. */
async function stuckOn(page: Page): Promise<string> {
  try {
    const url = new URL(page.url());
    const names = await page.locator('button:visible, [role=button]:visible, a:visible, [role=link]:visible').evaluateAll(nodes => nodes.slice(0, 40).map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 60));
    return `The browser is on ${url.host}${url.pathname}; it shows: ${[...new Set(names)].slice(0, 10).join(' | ') || 'nothing to press'}.`;
  } catch { return ''; }
}

/**
 * Opens the consent URL in `page` and presses through the screens that only continue what the user asked for: choose
 * the account named, "Advanced" and "Go to <app> (unsafe)" on an app still in testing, then Continue or Allow. It stops
 * (and the connect times out with a plain reason) at anything else, such as a password or a captcha.
 */
export async function connectEmail(stateDir: string, page: Page, options: { email?: string; endpoints?: GoogleEndpoints; timeoutMs?: number; progress?: (line: string) => void } = {}): Promise<{ email: string }> {
  const consent = await startConsent(stateDir, { loginHint: options.email, endpoints: options.endpoints, timeoutMs: options.timeoutMs });
  let finished = false;
  consent.done.then(() => { finished = true; }, () => { finished = true; });
  await page.goto(consent.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const click = async (locator: ReturnType<Page['locator']>): Promise<boolean> => {
    const shown = locator.filter({ visible: true });
    if (!(await shown.count().catch(() => 0))) return false;
    return shown.first().click({ timeout: 3_000 }).then(() => true, () => false);
  };
  let chosen = '';
  const steps = (async () => {
    for (let i = 0; i < 90 && !finished; i++) {
      if (page.isClosed()) return;
      const url = page.url();
      if (/^http:\/\/127\.0\.0\.1:\d+\/callback/.test(url)) return;
      if (options.email && chosen !== url && await click(page.locator(`[data-identifier="${options.email}"]`))) { chosen = url; options.progress?.('Chose the account.\n'); }
      else if (await click(page.getByRole('link', { name: /go to .*\(unsafe\)/i }))) options.progress?.('Continued past the unverified-app notice.\n');
      else if (await click(page.getByText(/^advanced$/i))) options.progress?.('');
      else if (await click(page.getByRole('button', { name: /^(continue|allow)$/i }))) options.progress?.('Allowed read access to mail.\n');
      await page.waitForTimeout(1_000).catch(() => undefined);
    }
  })();
  try { return await consent.done; }
  catch (error) { throw new Error(`${(error as Error).message} ${await stuckOn(page)}`); }
  finally { await steps.catch(() => undefined); }
}
