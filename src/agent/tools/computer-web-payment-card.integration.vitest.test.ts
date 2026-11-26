/** A checkout form filled from a saved card in real Chrome: the card boxes each live in their own frame (as a payment
 * provider's hosted fields do), the person approves the card for the site once, the number and code never reach the
 * model-visible report, and with no approval (or no way to ask) every card box stays empty. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { lockCredentialVault } from '../computer/credential-vault.js';
import { saveCard } from '../computer/payment-cards.js';
import { saveProfile } from '../computer/profiles.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const frame = (inner: string): string => `<iframe srcdoc='${inner}' style="width:320px;height:40px;border:0"></iframe>`;
const FORM = `<h1>Checkout</h1><form>
  <label for=n>Name on card</label><input id=n name="cardholder" autocomplete="cc-name">
  ${frame('<span id="card-label">Card number</span><input id="accountToken" aria-labelledby="card-label card-error"><span id="card-error"></span>')}
  ${frame('<input aria-label="Expiration" name="exp-date" autocomplete="cc-exp" placeholder="MM / YY">')}
  ${frame('<input aria-label="Security code" name="cvc" autocomplete="cc-csc" type="password" placeholder="CVC">')}
  <label for=z>ZIP / Postal code</label><input id=z name="postal" autocomplete="postal-code">
  </form>`;
const VISA = '4242424242424242';

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-pay-form-'));
  await saveProfile(stateDir, { label: 'Personal', fields: { email: 'me@mail.test', given_name: 'Ada', family_name: 'Lovelace', postal_code: '80808' } });
  await saveCard(stateDir, { number: VISA, expiry: '04/27', code: '123', name: 'Ada Lovelace' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.route('https://shop.test/checkout', route => route.fulfill({ contentType: 'text/html', body: FORM }));
  await page.goto('https://shop.test/checkout');
  await page.waitForFunction(() => document.querySelectorAll('iframe').length === 3);
  return { stateDir, browser, page };
}
async function refsOf(page: import('playwright-core').Page): Promise<string[]> {
  const { observeComputerPage } = await import('./computer-web.js');
  const view = (await observeComputerPage(page, false)).output;
  return [...view.matchAll(/textbox "[^"]*" \[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1]!);
}

it.skipIf(!enabled)('fills the framed card boxes from the approved card, asking once, and never reports the number or code', async () => {
  const { askForFills } = await import('./computer-web.js');
  const { stateDir, browser, page } = await setup();
  try {
    const refs = await refsOf(page);
    expect(refs).toHaveLength(5);
    const asked: string[][] = [];
    const ctx = { stateDir, signal: undefined, requestPrivateLogin: async (site: string, fields: Array<{ key: string; label: string; options?: string[] }>) => {
      asked.push([site, fields[0]!.label, ...(fields[0]!.options ?? [])]);
      return { card: 'Use Visa ending 4242, expires 04/27' };
    } };
    const report: string[] = [];
    const steps = await askForFills(page, refs.map(target => ({ do: 'fill' as const, target })), ctx as never, undefined, report);
    expect(steps.map(step => step.text).sort()).toEqual(['04 / 27', '123', VISA, '80808', 'Ada Lovelace'].sort());
    // One question for the whole form, naming the site and the card as a wallet shows it.
    expect(asked).toEqual([['https://shop.test', 'Type a saved card into shop.test?', 'Use Visa ending 4242, expires 04/27', 'Do not use a card']]);
    const said = report.join('\n');
    expect(said).toContain('Filled from the saved card Visa ending 4242, expires 04/27');
    expect(said).not.toContain(VISA);
    expect(said).not.toMatch(/\b123\b/);
    // Typed into the page, the card is still never in what the agent reads of it: not the number as typed, not regrouped
    // the way a payment field shows it back, not the code. (The number box here is named, with no cc-* on purpose below.)
    const { observeComputerPage } = await import('./computer-web.js');
    const { locate } = await import('./computer-web.js');
    for (const step of steps) await (await locate(page, step.target)).fill(step.text!);
    await page.frames()[1]!.locator('input').evaluate(node => { (node as unknown as { value: string }).value = '4242 4242 4242 4242'; });
    const seen = (await observeComputerPage(page, false)).output;
    expect(seen).not.toContain(VISA);
    expect(seen).not.toContain('4242 4242 4242 4242');
    expect(seen).not.toMatch(/: "?123"?\s*$/m);
    // A second fill of the same form inside the approval window asks nothing more.
    await askForFills(page, [{ do: 'fill' as const, target: refs[1]! }], ctx as never, undefined, []);
    expect(asked).toHaveLength(1);
  } finally {
    await browser.close();
    lockCredentialVault(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90_000);

it.skipIf(!enabled)('leaves every card box empty when the person says no, and when the chat cannot ask them', async () => {
  const { askForFills } = await import('./computer-web.js');
  const { stateDir, browser, page } = await setup();
  try {
    const refs = await refsOf(page);
    const declined: string[] = [];
    const no = await askForFills(page, refs.map(target => ({ do: 'fill' as const, target })), { stateDir, signal: undefined, requestPrivateLogin: async () => ({ card: 'Do not use a card' }) } as never, undefined, declined);
    expect(no.map(step => step.text)).toEqual(['80808']);
    expect(declined.join('\n')).toMatch(/Card number left empty: the user did not approve using a card on this site/);
    const mute: string[] = [];
    const none = await askForFills(page, refs.map(target => ({ do: 'fill' as const, target })), { stateDir, signal: undefined } as never, undefined, mute);
    expect(none.map(step => step.text)).toEqual(['80808']);
    expect(mute.join('\n')).toMatch(/used only with the user's approval, and this chat cannot ask them privately/);
    expect([...declined, ...mute].join('\n')).not.toContain(VISA);
  } finally {
    await browser.close();
    lockCredentialVault(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90_000);
