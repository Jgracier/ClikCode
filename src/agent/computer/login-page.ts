/** One private login action that follows an ordinary sign-in: saved account
 * (picked if there are several), email, password, then a one-time code.
 * Answers stay in this worker, and a new login is saved only after the
 * browser has moved past sign-in. */
import type { Page } from 'playwright-core';
import { loginLabel, sameSite, saveLoginFields, savedLoginFields, savedLoginsForSite, setLoginRejected } from './credential-vault.js';
import { LoginError } from './login-error.js';
import { loginFields, loginScope, uniqueLabels, type LoginField } from './login-fields.js';
import { AUTH_PATH, protectLoginPage } from './private-page.js';

export type LoginOutcome = 'signed_in' | 'session_reused' | 'verification_needed' | 'unverified' | 'saved_login_rejected';
const NEW_ACCOUNT = 'Use a different account';
const STEP_POLLS = 60;
const MAX_POLLS = 240;
/** Quiet for this long after Enter: try the submit button. */
const NUDGE_POLLS = 12;
/** Phone approval and CAPTCHA take a person a while: as long as a private prompt waits. */
const VERIFY_POLLS = 600;
const CODE_ATTEMPTS = 2;

/** The one wording of each result, for the agent tool and the slash command alike. */
export function loginOutcomeMessage(outcome: LoginOutcome): string {
  switch (outcome) {
    case 'signed_in': return 'Browser advanced beyond sign-in. ClikCode Secrets Manager is ready for this site.';
    case 'session_reused': return 'Browser advanced without asking for a password. An existing session may have been reused; no new login was saved.';
    case 'verification_needed': return 'Verification is still pending, so the new login was not saved. Approve it on your phone or finish it in the open browser, or use handoff to finish it from another device.';
    case 'saved_login_rejected': return 'The site did not accept the saved password. Run login again and choose "Use a different account" to enter an updated one.';
    default: return 'Sign-in could not be verified. The new login was not saved.';
  }
}

function checkedOrigin(url: string): string {
  const site = new URL(url);
  if (site.protocol !== 'https:' || site.username || site.password) throw new LoginError('Private login needs an HTTPS website.');
  return site.origin;
}

/** Still on the site the login started on (a regional host of it counts). */
function onSite(url: string, startUrl: string): boolean {
  checkedOrigin(url);
  return sameSite(url, startUrl);
}

function signature(url: string, fields: readonly LoginField[]): string {
  return `${url}\n${fields.map(field => `${field.index}:${field.key}:${field.label}`).join('|')}`;
}

async function visible(page: Page): Promise<LoginField[]> {
  try { return await loginFields(page); }
  catch { return []; } // A navigation can temporarily destroy the old DOM.
}

async function loading(page: Page): Promise<boolean> {
  try { return await page.evaluate(() => (globalThis as unknown as { document: { readyState: string } }).document.readyState !== 'complete'); }
  catch { return false; } // Mid-navigation the old document is gone; the signature check sees the change.
}

/** Waits for the page to move on. A slow site is given more time while it is
 * still loading (up to a minute); a quiet page that never changes ends after
 * the normal wait. `nudge` runs once if nothing has changed early on. */
async function progress(page: Page, before: string, signal?: AbortSignal, nudge?: () => Promise<void>): Promise<boolean> {
  let deadline = STEP_POLLS;
  let nudged = !nudge;
  for (let poll = 0; poll < Math.min(deadline, MAX_POLLS); poll++) {
    if (signal?.aborted) throw new LoginError('Private login cancelled.');
    await page.waitForTimeout(250);
    if (signature(page.url(), await visible(page)) !== before) return true;
    if (!nudged && poll >= NUDGE_POLLS && !await loading(page)) { nudged = true; await nudge!().catch(() => undefined); }
    if (poll + 1 >= deadline && deadline < MAX_POLLS && await loading(page)) deadline += 20;
  }
  return false;
}

/** Enter did nothing: some forms only submit from their button. */
async function pressSubmit(page: Page): Promise<void> {
  const scope = await loginScope(page);
  const button = scope.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if (await button.count()) { await button.click({ timeout: 3_000 }); return; }
  await scope.getByRole('button', { name: /^(sign in|log in|login|next|continue|submit|verify|confirm)\b/i }).first().click({ timeout: 3_000 });
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
  let codeAttempts = 0;
  let announcedVerification = false;
  let waited = 0;

  for (let step = 0; step < 10; step++) {
    if (input.signal?.aborted) throw new LoginError('Private login cancelled.');
    const url = input.page.url();
    const fields = await visible(input.page);
    if (fields.filter(field => field.kind === 'password').length > 1) throw new LoginError('Several password fields are visible. Use handoff.');
    if (fields.filter(field => field.transient).length > 1) throw new LoginError('This page asks for a code in several boxes. Use handoff.');
    if (!fields.length) {
      if (submittedPassword && leftSignIn(startUrl, url)) {
        if (Object.keys(supplied).length) {
          // The same username again is the same account: update it, don't duplicate it.
          await saveLoginFields(input.stateDir, startUrl, supplied, id ?? accounts.find(account => account.label === loginLabel(supplied))?.id);
        } else if (id && accounts.find(account => account.id === id)?.rejected) await setLoginRejected(input.stateDir, startUrl, id, false);
        return 'signed_in';
      }
      if (submitted && leftSignIn(startUrl, url)) return 'session_reused';
      // A page opened a moment ago may not have drawn its form yet.
      if (!submitted && waited++ < 24) { await input.page.waitForTimeout(500); step--; continue; }
      if (!submitted) throw new LoginError('No sign-in form is visible. If a verification or CAPTCHA is showing, use handoff.');
      if (!announcedVerification) { input.onVerification?.(); announcedVerification = true; }
      for (let poll = 0; poll < VERIFY_POLLS; poll++) {
        if (input.signal?.aborted) throw new LoginError('Private login cancelled.');
        await input.page.waitForTimeout(1_000);
        const nextFields = await visible(input.page);
        if (nextFields.length || leftSignIn(startUrl, input.page.url())) break;
        if (poll === VERIFY_POLLS - 1) return 'verification_needed';
      }
      step--; // Resume the same flow after an MFA or loading page.
      continue;
    }
    if (!onSite(url, startUrl)) return 'unverified';
    // A rejected password often comes back on a new URL or a re-rendered
    // form. Never keep submitting the same secret into an account lockout.
    if (submittedPassword && fields.some(field => field.kind === 'password')) {
      if (id && !supplied.password && saved.password) { await setLoginRejected(input.stateDir, startUrl, id, true); return 'saved_login_rejected'; }
      return 'unverified';
    }
    if (codeAttempts >= CODE_ATTEMPTS && fields.some(field => field.transient)) return 'unverified';
    if (!accountChosen) {
      accountChosen = true;
      if (input.newAccount) id = undefined;
      else if (accounts.length > 1 || accounts[0]?.rejected) {
        const labels = uniqueLabels(accounts.map(account => account.label));
        const answers = await input.ask(origin, [{ index: -1, key: 'account', label: 'Choose an account', kind: 'choice', required: true, options: [...labels, NEW_ACCOUNT] }], input.signal);
        if (!answers || input.signal?.aborted) throw new LoginError('Private login cancelled.');
        id = accounts[labels.indexOf(answers.account!)]?.id;
      } else id = accounts[0]?.id;
      saved = id ? await savedLoginFields(input.stateDir, startUrl, id) : {};
      step--; // The page may have moved while the picker was open: read it again.
      continue;
    }
    // A one-time code is asked for every time and never kept.
    const codes: Record<string, string> = {};
    const needed = fields.filter(field => field.transient || (!saved[field.key] && !supplied[field.key]));
    if (needed.length) {
      const answers = await input.ask(origin, needed, input.signal);
      if (!answers || input.signal?.aborted) throw new LoginError('Private login cancelled.');
      if (!onSite(input.page.url(), startUrl)) return 'unverified';
      for (const field of needed) {
        if (!answers[field.key]) throw new LoginError('Complete the visible login fields.');
        if (field.transient) codes[field.key] = answers[field.key]!; else supplied[field.key] = answers[field.key]!;
      }
    }
    const before = signature(url, fields);
    for (const field of fields) {
      if (!onSite(input.page.url(), startUrl)) return 'unverified';
      await (await loginScope(input.page)).locator('input:visible').nth(field.index).fill(field.transient ? codes[field.key]! : (saved[field.key] ?? supplied[field.key]!));
    }
    for (const key of Object.keys(codes)) delete codes[key];
    await (await loginScope(input.page)).locator('input:visible').nth(fields.at(-1)!.index).press('Enter');
    submitted = true;
    if (fields.some(field => field.kind === 'password')) submittedPassword = true;
    if (fields.some(field => field.transient)) codeAttempts++;
    if (!await progress(input.page, before, input.signal, () => pressSubmit(input.page))) return 'unverified';
  }
  return 'unverified';
}
