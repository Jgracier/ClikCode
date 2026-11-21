/** One private login action that follows an ordinary sign-in: saved account
 * (picked if there are several), email, password, then a one-time code.
 * Answers stay in this worker, and a new login is saved only after the
 * browser has moved past sign-in. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { ElementHandle, Page } from 'playwright-core';
import { loginLabel, sameSite, saveLoginFields, savedLoginFields, savedLoginsForSite, setLoginRejected } from './credential-vault.js';
import { LoginError } from './login-error.js';
import { loginFields, loginScope, savedLoginValues, uniqueLabels, type LoginField } from './login-fields.js';
/** Paths that mean a sign-in or verification step. */
const AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|auth|oauth|authenticate|challenge|verify|verification|mfa|otp|2fa|2sv|two-factor|sso|saml)(?:\/|$)/i;

type LoginOutcome = 'signed_in' | 'session_reused' | 'verification_needed' | 'unverified' | 'saved_login_rejected';
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
    if (!nudged && poll >= NUDGE_POLLS && !await loading(page)) { nudged = true; await nudge!().catch(quiet('agent/computer/login-page')); }
    if (poll + 1 >= deadline && deadline < MAX_POLLS && await loading(page)) deadline += 20;
  }
  return false;
}

/** The visible words of the sign-in page (never a typed value: those are not part of a page's text). Undefined when unreadable. */
async function pageWords(page: Page): Promise<string | undefined> {
  try { return await (await loginScope(page)).locator('body').innerText({ timeout: 2_000 }); }
  catch { return undefined; } // Mid-navigation, or a page that cannot be read: not known to be unchanged, so nothing is pressed.
}

type ButtonNode = {
  tagName: string; type?: string; value?: string; innerText?: string; parentElement: ButtonNode | null; form?: ButtonNode | null;
  getAttribute(name: string): string | null; getClientRects(): { length: number };
  querySelectorAll(selector: string): Iterable<ButtonNode>;
};

/** Finds the submit control that belongs to the box just filled, in the page. Runs in the browser.
 * Inside a <form>: its one submit button, or with several, the one named exactly like a submit. With no <form> (a
 * script-driven page): the one button named exactly like a submit in the nearest container around the box that has any.
 * Anything less certain returns nothing: a page's other buttons (a header's "Provide feedback", "Sign in using root
 * user email", "Create account") are never the sign-in's to press. */
function ownSubmitControl(node: unknown): unknown {
  const SUBMIT_NAME = /^(?:sign in|log in|login|next|continue|submit|verify|confirm)$/i;
  const box = node as ButtonNode;
  const shown = (button: ButtonNode): boolean => button.getClientRects().length > 0;
  const named = (button: ButtonNode): boolean => SUBMIT_NAME.test((button.innerText || button.value || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim());
  const only = (buttons: ButtonNode[]): ButtonNode | null => buttons.length === 1 ? buttons[0]! : null;
  const buttonsIn = (container: ButtonNode): ButtonNode[] => [...container.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')].filter(shown);
  if (box.form) {
    const all = buttonsIn(box.form);
    const submits = all.filter(button => button.tagName === 'INPUT' ? button.type === 'submit' : button.tagName === 'BUTTON' && button.type === 'submit');
    return only(submits) ?? only(all.filter(named));
  }
  for (let container = box.parentElement; container; container = container.parentElement) {
    const candidates = buttonsIn(container).filter(named);
    if (candidates.length) return only(candidates);
  }
  return null;
}

/** Enter did nothing: some forms only submit from their button. Presses the button of the form that holds box `index`, and no other. */
async function pressSubmit(page: Page, index: number): Promise<void> {
  const box = (await loginScope(page)).locator('input:visible').nth(index);
  const button = (await box.evaluateHandle(ownSubmitControl)).asElement() as ElementHandle | null;
  if (button) await button.click({ timeout: 3_000 });
}

/** No website-independent signal proves authentication. A move away from an
 * auth URL, with no remaining credential fields, is the narrow success signal
 * used before saving a newly supplied login. */
function leftSignIn(startUrl: string, currentUrl: string): boolean {
  if (currentUrl === startUrl) return false;
  const current = new URL(currentUrl);
  return current.protocol === 'https:' && !AUTH_PATH.test(current.pathname);
}

/** The words of a page whose code was just emailed or texted: an authenticator code is the wrong thing to type there. */
const SENT_CODE_PAGE = /(?:sent|emailed|texted|e-mailed)[^.\n]{0,60}\bcode\b|code[^.\n]{0,40}(?:sent|emailed|texted) to|check your (?:e-?mail|inbox|phone)|text message|\bsms\b/i;
/** A code box on a site whose authenticator seed is kept is the authenticator's, unless the page says the code was sent somewhere. */
export function wantsAuthenticatorCode(pageText: string): boolean {
  return !SENT_CODE_PAGE.test(pageText);
}
async function asksForAuthenticator(page: Page): Promise<boolean> {
  // A page whose words cannot be read is not assumed to want the authenticator: the person is asked, as before.
  let text: string;
  try { text = await page.locator('body').innerText({ timeout: 3_000 }); } catch { return false; }
  return !!text.trim() && wantsAuthenticatorCode(text.slice(0, 20_000));
}

export async function loginComputerPage(input: {
  stateDir: string;
  page: Page;
  signal?: AbortSignal;
  ask(site: string, fields: readonly LoginField[], signal?: AbortSignal): Promise<Record<string, string> | undefined>;
  onVerification?(): void;
  /** The user wants another account than the saved one: enter it, don't reuse. */
  newAccount?: boolean;
  /** The emailed one-time code for this site when a mailbox is connected (undefined when none is): asked for with the time the page began asking. */
  mailCode?(since: number): Promise<string | undefined>;
  /** The current authenticator-app code for this site, when its seed is kept in ClikDeploy (undefined when none is): never asked of anyone. */
  authenticatorCode?(): Promise<string | undefined>;
}): Promise<LoginOutcome> {
  const startUrl = input.page.url();
  const origin = checkedOrigin(startUrl);
  let lastSubmit = Date.now() - 120_000;
  const storedAccounts = await savedLoginsForSite(input.stateDir, startUrl);
  const usableAccounts = storedAccounts.filter(account => account.usable && !account.rejected);
  // Empty captures cannot force an account picker when a usable saved login exists.
  const accounts = usableAccounts.length ? usableAccounts : storedAccounts;
  // One saved account is simply used. Several (or one the site refused last
  // time) are put to the user as an arrow-key picker, with a way to add another.
  let id: string | undefined;
  let saved: Record<string, string> = {};
  let accountChosen = false;
  const supplied: Record<string, string> = {};
  let submitted = false;
  let submittedPassword = false;
  // The saved password went to the site (and no newly typed one). If the site then shows a sign-in form again, on
  // whatever host its login page lives on (login.x.com, x.auth0.com), the saved password was refused.
  let sentSaved = false;
  const refused = async (): Promise<LoginOutcome> => { if (id) await setLoginRejected(input.stateDir, startUrl, id, true); return 'saved_login_rejected'; };
  let codeAttempts = 0;
  let usedAuthenticator = false;
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
    if (!onSite(url, startUrl)) return sentSaved && fields.some(field => field.kind === 'password') ? refused() : 'unverified';
    // A rejected password often comes back on a new URL or a re-rendered
    // form. Never keep submitting the same secret into an account lockout.
    if (submittedPassword && fields.some(field => field.kind === 'password')) {
      // A page that is still redrawing after the password (a phone prompt on its way) shows the old form for a moment.
      let gone = false;
      for (let poll = 0; poll < 32 && !gone; poll++) {
        await input.page.waitForTimeout(250);
        gone = !(await visible(input.page)).some(field => field.kind === 'password');
      }
      if (gone) { step--; continue; }
      return sentSaved ? refused() : 'unverified';
    }
    if (codeAttempts >= CODE_ATTEMPTS && fields.some(field => field.transient)) return 'unverified';
    if (!accountChosen) {
      accountChosen = true;
      if (input.newAccount) id = undefined;
      else if (accounts.length > 1 || accounts[0]?.rejected) {
        const labels = uniqueLabels(accounts.map(account => account.label));
        const refusedOnly = accounts.length === 1 && accounts[0]?.rejected;
        const question = refusedOnly ? `The saved password for ${labels[0]} was refused last time. Enter a new one` : 'Choose an account';
        const answers = await input.ask(origin, [{ index: -1, key: 'account', label: question, kind: 'choice', required: true, options: [...labels, NEW_ACCOUNT] }], input.signal);
        if (!answers || input.signal?.aborted) throw new LoginError('Private login cancelled.');
        id = accounts[labels.indexOf(answers.account!)]?.id;
      } else id = accounts[0]?.id;
      saved = id ? await savedLoginFields(input.stateDir, startUrl, id) : {};
      // A password the site already refused is never sent again: it is asked for anew.
      if (id && accounts.find(account => account.id === id)?.rejected) delete saved.password;
      step--; // The page may have moved while the picker was open: read it again.
      continue;
    }
    // The saved login answers the form's account boxes only where it holds what they ask for; a form it does not fit is refused here, untouched.
    const known: Record<string, string> = { ...savedLoginValues(fields, saved), ...(saved.password ? { password: saved.password } : {}) };
    // A one-time code is asked for every time and never kept.
    const codes: Record<string, string> = {};
    const needed: LoginField[] = fields.filter(field => field.transient || (!known[field.key] && !supplied[field.key]));
    // An email-only first page is followed by a password page nearly everywhere: ask for both now, in one prompt.
    const early = !fields.some(field => field.kind === 'password') && !saved.password && !supplied.password
      && needed.some(field => ['email', 'username', 'accountId'].includes(field.key));
    if (early) needed.push({ index: -1, key: 'password', label: 'Password', kind: 'password', required: true });
    // A page that asks for the authenticator app's code gets it from the seed kept in ClikDeploy. One try: a second code box
    // after that is a refusal or another kind of code, and typing more authenticator codes at it would lock the account.
    if (input.authenticatorCode && !usedAuthenticator && needed.some(candidate => candidate.transient) && await asksForAuthenticator(input.page)) {
      const code = await input.authenticatorCode();
      if (code) {
        usedAuthenticator = true;
        for (const field of needed.filter(candidate => candidate.transient)) { codes[field.key] = code; needed.splice(needed.indexOf(field), 1); }
      }
    }
    // A one-time code that arrives by email is read from the connected mailbox, not asked of anyone.
    if (input.mailCode) {
      for (const field of needed.filter(candidate => candidate.transient)) {
        const code = await input.mailCode(lastSubmit - 5_000);
        if (code) { codes[field.key] = code; needed.splice(needed.indexOf(field), 1); }
      }
    }
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
    const valueOf = (field: LoginField): string => field.transient ? codes[field.key]! : (known[field.key] ?? supplied[field.key]!);
    // Whoever answered (the saved login, the profile, the person): one value in two account boxes is a guess, not a sign-in.
    const typed = fields.filter(field => field.kind === 'text' && !field.transient).map(valueOf);
    if (new Set(typed).size !== typed.length) throw new LoginError('Nothing was typed or pressed: the same value was given for two different account fields of this page. Each field needs its own answer.');
    for (const field of fields) {
      if (!onSite(input.page.url(), startUrl)) return sentSaved && fields.some(candidate => candidate.kind === 'password') ? refused() : 'unverified';
      await (await loginScope(input.page)).locator('input:visible').nth(field.index).fill(valueOf(field));
    }
    for (const key of Object.keys(codes)) delete codes[key];
    // The words on the page before Enter. A page that says something new afterwards (a refusal shown in place, a spinner) took
    // the submission: pressing its button as well would send the same answers twice, which counts twice towards a lockout.
    const words = await pageWords(input.page);
    const nudge = async (): Promise<void> => { if (words !== undefined && await pageWords(input.page) === words) await pressSubmit(input.page, fields.at(-1)!.index); };
    await (await loginScope(input.page)).locator('input:visible').nth(fields.at(-1)!.index).press('Enter');
    submitted = true;
    lastSubmit = Date.now();
    if (fields.some(field => field.kind === 'password')) {
      submittedPassword = true;
      // A refusal counts against the saved password only when this whole submission came from the saved login: a form that also
      // needed something typed fresh (an account id, a different kind of sign-in) says nothing about the password it was sent with.
      const allSaved = fields.every(field => field.transient || field.kind === 'password' || (known[field.key] !== undefined && supplied[field.key] === undefined));
      if (saved.password && !supplied.password && allSaved) sentSaved = true;
    }
    if (fields.some(field => field.transient)) codeAttempts++;
    // Nothing changed after the saved password was sent and the password box is still there: the site said no in place.
    if (!await progress(input.page, before, input.signal, nudge)) return sentSaved && (await visible(input.page)).some(field => field.kind === 'password') ? refused() : 'unverified';
  }
  return 'unverified';
}
