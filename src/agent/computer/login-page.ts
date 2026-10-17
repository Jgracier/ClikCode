/** A single private login action follows ordinary multi-page sign-in forms.
 * Answers stay in this worker until the browser advances past sign-in. */
import type { Page } from 'playwright-core';
import { saveLoginFields, savedLoginFields, soleCredentialForSite } from './credential-vault.js';
import { loginFields, type LoginField } from './login-fields.js';
import { protectLoginPage } from './private-page.js';

export type LoginOutcome = 'signed_in' | 'session_reused' | 'verification_needed' | 'unverified';
const AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|auth|authenticate|challenge|verify|verification)(?:\/|$)/i;
const STEP_POLLS = 60;
const VERIFY_POLLS = 120;

function checkedOrigin(url: string): string {
  const site = new URL(url);
  if (site.protocol !== 'https:' || site.username || site.password) throw new Error('Private login needs an HTTPS website.');
  return site.origin;
}

function signature(url: string, fields: readonly LoginField[]): string {
  return `${url}\n${fields.map(field => `${field.index}:${field.key}:${field.label}`).join('|')}`;
}

async function visible(page: Page): Promise<LoginField[]> {
  try { return await loginFields(page); }
  catch { return []; } // A navigation can temporarily destroy the old DOM.
}

async function progress(page: Page, before: string, signal?: AbortSignal): Promise<boolean> {
  for (let poll = 0; poll < STEP_POLLS; poll++) {
    if (signal?.aborted) throw new Error('Private login cancelled.');
    await page.waitForTimeout(250);
    if (signature(page.url(), await visible(page)) !== before) return true;
  }
  return false;
}

/** No website-independent signal proves authentication. A move away from an
 * auth URL, with no remaining credential fields, is the narrow success signal
 * used before saving a newly supplied login. */
function leftSignIn(startUrl: string, currentUrl: string): boolean {
  if (currentUrl === startUrl) return false;
  const current = new URL(currentUrl);
  return current.protocol === 'https:' && !AUTH_PATH.test(current.pathname);
}

export async function loginComputerPage(input: {
  stateDir: string;
  page: Page;
  signal?: AbortSignal;
  ask(site: string, fields: readonly LoginField[], signal?: AbortSignal): Promise<Record<string, string> | undefined>;
  onVerification?(): void;
}): Promise<LoginOutcome> {
  const startUrl = input.page.url();
  const origin = checkedOrigin(startUrl);
  protectLoginPage(input.page);
  const id = await soleCredentialForSite(input.stateDir, startUrl);
  const saved = id ? await savedLoginFields(input.stateDir, startUrl, id) : {};
  const supplied: Record<string, string> = {};
  let submitted = false;
  let submittedPassword = false;
  let announcedVerification = false;

  for (let step = 0; step < 8; step++) {
    if (input.signal?.aborted) throw new Error('Private login cancelled.');
    const url = input.page.url();
    const fields = await visible(input.page);
    if (fields.filter(field => field.kind === 'password').length > 1) throw new Error('Multiple password fields are visible. Use handoff.');
    if (!fields.length) {
      if (submittedPassword && leftSignIn(startUrl, url)) {
        if (Object.keys(supplied).length) await saveLoginFields(input.stateDir, startUrl, supplied, id);
        return 'signed_in';
      }
      if (submitted && leftSignIn(startUrl, url)) return 'session_reused';
      if (!submitted) throw new Error('No login field is visible. Use handoff for verification or CAPTCHA.');
      if (!announcedVerification) { input.onVerification?.(); announcedVerification = true; }
      for (let poll = 0; poll < VERIFY_POLLS; poll++) {
        if (input.signal?.aborted) throw new Error('Private login cancelled.');
        await input.page.waitForTimeout(1_000);
        const nextFields = await visible(input.page);
        if (nextFields.length || leftSignIn(startUrl, input.page.url())) break;
        if (poll === VERIFY_POLLS - 1) return 'verification_needed';
      }
      step--; // Resume the same flow after an MFA or loading page.
      continue;
    }
    if (checkedOrigin(url) !== origin) return 'unverified';
    // A rejected password often comes back on a new URL or a re-rendered
    // form. Never keep submitting the same secret into an account lockout.
    if (submittedPassword && fields.some(field => field.kind === 'password')) return 'unverified';
    const missing = fields.filter(field => !saved[field.key] && !supplied[field.key]);
    if (missing.length) {
      const answers = await input.ask(origin, missing, input.signal);
      if (!answers || input.signal?.aborted) throw new Error('Private login cancelled.');
      if (checkedOrigin(input.page.url()) !== origin) return 'unverified';
      for (const field of missing) {
        if (!answers[field.key]) throw new Error('Complete the visible login fields.');
        supplied[field.key] = answers[field.key];
      }
    }
    const before = signature(url, fields);
    for (const field of fields) {
      if (checkedOrigin(input.page.url()) !== origin) return 'unverified';
      await input.page.locator('input:visible').nth(field.index).fill(saved[field.key] ?? supplied[field.key]);
    }
    await input.page.locator('input:visible').nth(fields.at(-1)!.index).press('Enter');
    submitted = true;
    if (fields.some(field => field.kind === 'password')) submittedPassword = true;
    if (!await progress(input.page, before, input.signal)) return 'unverified';
  }
  return 'unverified';
}
