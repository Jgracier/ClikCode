/** A generated password meets the page: read what the page asks for, and when the site refuses the password, make
 * another under looser rules and try again, a bounded number of times. Every password made here is registered with
 * the scrubber and typed straight into the page; the model sees neither the password nor a count of its characters.
 * What it may be told is that the site refused and how many tries it took. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Page } from 'playwright-core';
import { holdSignup } from './signup-login.js';
import { generatePassword, MAX_PASSWORD_ATTEMPTS, parsePolicy, relax, type PasswordPolicy, type PolicyHints } from './password-policy.js';
import { registerSecret, scrubSecrets } from './secret-scrubber.js';
import { sharedState } from './shared-state.js';

const PASSWORD_BOX = 'input[type="password"]:visible';

type Generated = { password: string; policy: PasswordPolicy; attempts: number; past: Set<string> };
const generated = sharedState('generated-password', () => new WeakMap<Page, Generated>());

/** The generated password this page's form holds, and the older ones it replaced (a later step of the same batch may still carry one). */
export function generatedFor(page: Page): Generated | undefined { return generated.get(page); }

/** The page's own words about its password: attributes of each visible password box, the text that describes it, and the text around it. */
export async function readPasswordPolicy(page: Page): Promise<PasswordPolicy> {
  try {
    const hints = await page.locator(PASSWORD_BOX).evaluateAll((boxes): PolicyHints[] => boxes.map(node => {
      type El = { getAttribute(name: string): string | null; parentElement: El | null; innerText?: string; textContent: string | null; ownerDocument: { getElementById(id: string): { textContent: string | null } | null }; title?: string };
      const box = node as unknown as El;
      const described = (box.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => box.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
      // Two ancestors up is the field's own wrapper (label, box, hint); further would be the whole form.
      let near = box.parentElement;
      for (let level = 0; level < 2 && near?.parentElement && (near.innerText ?? '').length < 200; level++) near = near.parentElement;
      const min = Number(box.getAttribute('minlength')); const max = Number(box.getAttribute('maxlength'));
      return { text: `${described} ${box.getAttribute('title') ?? ''} ${box.getAttribute('placeholder') ?? ''} ${(near?.innerText ?? '').slice(0, 600)}`,
        ...(min > 0 ? { minlength: min } : {}), ...(max > 0 ? { maxlength: max } : {}), ...(box.getAttribute('pattern') ? { pattern: box.getAttribute('pattern')! } : {}) };
    }));
    return parsePolicy(hints);
  } catch { return parsePolicy(); }
}

/** An error the page shows next to a password box about its length, characters or symbols; '' when there is none. */
export async function readPasswordRejection(page: Page): Promise<string> {
  try {
    return await page.locator(PASSWORD_BOX).evaluateAll((boxes) => {
      type El = { getAttribute(name: string): string | null; parentElement: El | null; closest(selector: string): El | null; querySelectorAll(selector: string): ArrayLike<El>; innerText?: string; textContent: string | null;
        checkValidity?: () => boolean; validationMessage?: string; getClientRects(): { length: number }; ownerDocument: { getElementById(id: string): El | null } };
      const about = /password|passphrase|character|symbol|special|upper|lower|digit|number|letter|too (?:short|long|weak|simple|common)|weak|at least|at most|must (?:contain|include|be|have)|not allowed|invalid|not accepted|requirement/i;
      const failing = /error|invalid|danger|alert|fail|warn|problem|help-block|feedback|validation/i;
      const lines: string[] = [];
      for (const node of boxes) {
        const box = node as unknown as El;
        const flagged = box.getAttribute('aria-invalid') === 'true' || (box.checkValidity ? !box.checkValidity() : false);
        const scope = box.closest('form') ?? box.parentElement?.parentElement?.parentElement ?? box.parentElement;
        const described = (box.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => box.ownerDocument.getElementById(id)).filter(Boolean) as El[];
        const candidates = [...Array.from(scope?.querySelectorAll('[role="alert"], [aria-live], [class], [id], [data-error], [data-testid]') ?? []), ...described];
        for (const item of candidates) {
          const text = (item.innerText ?? '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 300 || !item.getClientRects().length || !about.test(text)) continue;
          const marked = item.getAttribute('role') === 'alert' || failing.test(`${item.getAttribute('class') ?? ''} ${item.getAttribute('id') ?? ''} ${item.getAttribute('data-testid') ?? ''}`) || described.includes(item) && flagged;
          // A hint that was always there ("At least 12 characters") is not a complaint; an error, or a flagged box's own description, is.
          if (marked) lines.push(text);
        }
        if (flagged && !lines.length && box.validationMessage && about.test(box.validationMessage)) lines.push(box.validationMessage);
      }
      return [...new Set(lines)].slice(0, 3).join(' ');
    });
  } catch { return ''; }
}

/** Types a password into every visible password box, as keystrokes (the page checks each one). */
export async function typePassword(page: Page, password: string): Promise<number> {
  const boxes = page.locator(PASSWORD_BOX);
  const count = await boxes.count();
  for (let index = 0; index < count; index++) {
    const box = boxes.nth(index);
    await box.fill('', { timeout: 10_000 });
    await box.pressSequentially(password, { timeout: 10_000 });
    await box.blur().catch(quiet('agent/computer/password-retry'));
  }
  return count;
}

/** Remember the password just made for this page's form, with the rules it was made under. */
export function rememberGenerated(page: Page, password: string, policy: PasswordPolicy): void {
  const before = generated.get(page);
  if (before?.password === password) return;
  generated.set(page, { password, policy, attempts: before?.attempts ?? 0, past: new Set([...(before?.past ?? []), ...(before ? [before.password] : [])]) });
}

export type RetryOptions = {
  stateDir: string; page: Page; username: string | undefined;
  /** Press the control again (the Create account button) after a new password is typed. */
  resubmit?: () => Promise<unknown>;
  settle: (page: Page) => Promise<unknown>;
};

/** If the site refused the generated password, make another under looser rules and try again, up to three times in all.
 * Returns a line for the agent (never the password), or undefined when nothing was refused. */
export async function retryRejectedPassword(options: RetryOptions): Promise<string | undefined> {
  const { page } = options;
  const state = generated.get(page);
  if (!state || state.attempts >= MAX_PASSWORD_ATTEMPTS || page.isClosed()) return undefined;
  let rejection = await readPasswordRejection(page);
  if (!rejection) return undefined;
  const first = rejection;
  let tries = 0;
  while (rejection && state.attempts < MAX_PASSWORD_ATTEMPTS) {
    state.attempts += 1; tries += 1;
    state.policy = relax(state.policy, rejection, state.attempts);
    const next = generatePassword(state.policy);
    registerSecret(next);
    state.past.add(state.password);
    state.password = next;
    await holdSignup(options.stateDir, page, next, options.username);
    if (!await typePassword(page, next)) break;
    if (options.resubmit) { await options.resubmit().catch(quiet('agent/computer/password-retry')); await options.settle(page); }
    if (page.isClosed() || !await page.locator(PASSWORD_BOX).count().catch(() => 0)) { rejection = ''; break; } // the form is gone: the site took it
    rejection = await readPasswordRejection(page);
  }
  const said = scrubSecrets(first).slice(0, 120);
  const refused = !page.isClosed() && state.attempts >= MAX_PASSWORD_ATTEMPTS && await readPasswordRejection(page) !== '';
  return refused
    ? `The site refused the generated password ${state.attempts} times ("${said}"). The last one is saved with the login; do not retry, hand off to the user for this form.`
    : `The site refused the first generated password ("${said}"); a new one under looser rules was typed in (${tries} ${tries === 1 ? 'retry' : 'retries'}).`;
}
