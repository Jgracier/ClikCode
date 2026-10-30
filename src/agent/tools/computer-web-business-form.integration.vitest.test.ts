/** The post-signup business page (Quaderno's /welcome/your-business-data) filled from the profile in real Chrome:
 * each box gets its own profile detail, a registration number stays empty and is reported, a read-only prefilled
 * email is skipped, and the profile used is named. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { lockCredentialVault } from '../computer/credential-vault.js';
import { saveProfile } from '../computer/profiles.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const FORM = `<h1>Your business data</h1><form>
  <label for=a>Business name</label><input id=a name="account[business_name]">
  <label for=b>Registration number</label><input id=b name="account[registration_number]" required>
  <label for=c>Business phone</label><input id=c name="account[phone]" type=tel>
  <label for=d>Street address</label><input id=d name="account[address]">
  <label for=e>Postal code</label><input id=e name="account[address_postal_code]">
  <label for=f>City</label><input id=f name="account[city]">
  <label for=g>State / Province</label><input id=g name="account[region]">
  <label for=h>Country</label><input id=h name="account[country]">
  <label for=i>Email</label><input id=i name="user[email]" type=email value="me@mail.test" readonly>
  </form>`;

it.skipIf(!enabled)('fills each business box from its own profile detail and leaves a registration number and a read-only email alone', async () => {
  const { askForFills, observeComputerPage } = await import('./computer-web.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-business-form-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await saveProfile(stateDir, { label: 'Personal', fields: { email: 'me@mail.test', given_name: 'Ada', family_name: 'L', organization: 'Acme LLC', phone: '+17195550123', address_line1: '1 Main St', city: 'Calhan', state: 'CO', postal_code: '80808', country: 'United States' } });
    await saveProfile(stateDir, { label: 'Railway', fields: { organization: 'Railway Co' }, custom: { railway_email: { value: 'other@webpro.test', match: ['email'] } } });
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(FORM)}`);
    const view = (await observeComputerPage(page, false)).output;
    const refs = [...view.matchAll(/textbox "[^"]*" \[ref=(e\d+)\]/g)].map(match => match[1]!);
    expect(refs).toHaveLength(9);
    const report: string[] = [];
    const steps = await askForFills(page, refs.map(target => ({ do: 'fill' as const, target })), { stateDir, signal: undefined } as never, undefined, report);
    expect(steps.map(step => step.text)).toEqual(['Acme LLC', '+17195550123', '1 Main St', '80808', 'Calhan', 'CO', 'United States']);
    expect(steps).toHaveLength(7);
    expect(report.join('\n')).toContain('used the profile "Personal"');
    expect(report.join('\n')).toMatch(/required, no profile value: Registration number/);
    expect(report.join('\n')).toMatch(/Email is already filled and read-only/);
    expect(steps.some(step => step.text?.includes('@'))).toBe(false);
  } finally {
    await browser.close();
    lockCredentialVault(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90_000);
