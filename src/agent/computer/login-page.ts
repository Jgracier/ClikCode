/** A single private login action follows ordinary multi-page sign-in forms.
 * Answers stay in this worker until the browser advances past sign-in. */
import type { Page } from 'playwright-core';
import { loginLabel, saveLoginFields, savedLoginFields, savedLoginsForSite, setLoginRejected, type SavedLogin } from './credential-vault.js';
import { loginFields, type LoginField } from './login-fields.js';
import { protectLoginPage } from './private-page.js';

export type LoginOutcome = 'signed_in' | 'session_reused' | 'verification_needed' | 'unverified' | 'saved_login_rejected';
const NEW_ACCOUNT = 'Use a different account';

/** The one wording of each result, for the agent tool and the slash command alike. */
export function loginOutcomeMessage(outcome: LoginOutcome): string {
  switch (outcome) {
    case 'signed_in': return 'Browser advanced beyond sign-in. ClikCode Secrets Manager is ready for this site.';
    case 'session_reused': return 'Browser advanced without asking for a password. An existing session may have been reused; no new login was saved.';
    case 'verification_needed': return 'Finish verification in the open browser. The new login was not saved.';
    case 'saved_login_rejected': return 'The site did not accept the saved password. Run login again and choose "Use a different account" to enter an updated one.';
    default: return 'Sign-in could not be verified. The new login was not saved.';
  }
}

/** The same account twice (a retyped password) still has to be told apart. */
function pickerLabels(accounts: readonly SavedLogin[]): string[] {
  const seen = new Map<string, number>();
  return accounts.map(account => {
    const count = (seen.get(account.label) ?? 0) + 1;
    seen.set(account.label, count);
    return count === 1 ? account.label : `${account.label} (${count})`;
  });
}
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
  /** The user wants another account than the saved one: enter it, don't reuse. */
  newAccount?: boolean;
}): Promise<LoginOutcome> {
  const startUrl = input.page.url();
  const origin = checkedOrigin(startUrl);
  protectLoginPage(input.page);
  const accounts = await savedLoginsForSite(input.stateDir, startUrl);
  // One saved account is simply used. Several (or one the site refused last
  // time) are put to the user as an arrow-key picker, with a way to add another.
  let id: string | undefined;
  let saved: Record<string, string> = {};
  let accountChosen = false;
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
        if (Object.keys(supplied).length) {
          // The same username again is the same account: update it, don't duplicate it.
          await saveLoginFields(input.stateDir, startUrl, supplied, id ?? accounts.find(account => account.label === loginLabel(supplied))?.id);
        } else if (id && accounts.find(account => account.id === id)?.rejected) await setLoginRejected(input.stateDir, startUrl, id, false);
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
    if (submittedPassword && fields.some(field => field.kind === 'password')) {
      if (id && !supplied.password && saved.password) { await setLoginRejected(input.stateDir, startUrl, id, true); return 'saved_login_rejected'; }
      return 'unverified';
    }
    if (!accountChosen) {
      accountChosen = true;
      if (input.newAccount) id = undefined;
      else if (accounts.length > 1 || accounts[0]?.rejected) {
        const labels = pickerLabels(accounts);
        const answers = await input.ask(origin, [{ index: -1, key: 'account', label: 'Choose an account', kind: 'choice', required: true, options: [...labels, NEW_ACCOUNT] }], input.signal);
        if (!answers || input.signal?.aborted) throw new Error('Private login cancelled.');
        id = accounts[labels.indexOf(answers.account!)]?.id;
      } else id = accounts[0]?.id;
      saved = id ? await savedLoginFields(input.stateDir, startUrl, id) : {};
      step--; // The page may have moved while the picker was open: read it again.
      continue;
    }
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
