/** Decides whether a page with password boxes makes a new password (a sign-up, an invite, a set-your-password step) or asks for the
 * one an account already has (a sign-in). One rule for both, so the answer is the same wherever it is asked, and the reason is named. */
import type { Page } from 'playwright-core';

export type PasswordPageContext = {
  url: string;
  /** Visible password boxes on the page. */
  boxes: number;
  /** Label, placeholder, aria-label, name and id of every visible password box. */
  boxText: string;
  /** Headings, legends and the title. */
  headings: string;
  /** A "forgot password" link or button is on the page. */
  forgotLink: boolean;
  /** A visible, non-password text/email box already holds a value (an account that is known). */
  prefilledAccount: boolean;
};

export type PasswordPageKind = { kind: 'signup' | 'signin'; reason: string };

const STRONG = /\b(?:new|create|set|choose|pick|make)\b[^.]{0,20}\bpassword\b|\bpassword\b[^.]{0,12}\b(?:new|create)\b|\bconfirm(?:ation)?\b[^.]{0,12}\bpassword\b|\bre-?(?:enter|type)\b[^.]{0,12}\bpassword\b|new-password/i;
const WEAK_TEXT = /\bwelcome(?!\s+back)\b|complete your (?:account|profile|registration)|finish (?:setting up|your (?:account|profile))|you(?:'|’)?ve been invited|accept (?:your )?invit/i;
const WEAK_PATH = /(?:^|[/_-])(?:welcome|onboarding|set-?password|setup|complete|invite|activate)(?:$|[/_-])/i;

/** The page's own words and layout decide. Sign-in wins on a /login address; a forgot-password link or an already known account
 * only gives way to explicit new/create/set/confirm wording. */
export function classifyPasswordPage(page: PasswordPageContext): PasswordPageKind {
  const where = (() => { try { return new URL(page.url).pathname; } catch { return ''; } })();
  if (/\/login\b|signin|sign-in|identifier/i.test(page.url)) return { kind: 'signin', reason: 'a login address' };
  if (page.boxes < 1 || page.boxes > 2) return { kind: 'signin', reason: `${page.boxes} password boxes` };
  const strong = STRONG.test(page.boxText) ? 'a new/create/set/confirm password box'
    : STRONG.test(page.headings) ? 'a new/create/set password heading'
    : page.boxes === 2 ? 'two password boxes' : '';
  if (strong) return { kind: 'signup', reason: strong };
  if (page.forgotLink) return { kind: 'signin', reason: 'a forgot-password link' };
  if (page.prefilledAccount) return { kind: 'signin', reason: 'an account already filled in' };
  if (WEAK_TEXT.test(page.headings)) return { kind: 'signup', reason: 'a welcome/complete-your-account heading' };
  if (WEAK_PATH.test(where)) return { kind: 'signup', reason: 'a welcome/onboarding/set-password address' };
  return { kind: 'signin', reason: 'a password box with no new-password wording' };
}

/** What the page shows that the classifier needs. */
export async function readPasswordPageContext(page: Page): Promise<PasswordPageContext> {
  const seen = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: any }).document;
    const visible = (el: any): boolean => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (globalThis as unknown as { getComputedStyle(e: unknown): { visibility: string } }).getComputedStyle(el).visibility !== 'hidden'; };
    const passwords: any[] = Array.from(doc.querySelectorAll('input[type="password"]')).filter(visible);
    const text = (el: any): string => [el.labels?.[0]?.textContent, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete')].filter(Boolean).join(' ');
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3,legend,[role="heading"]')).filter(visible).map((el: any) => el.textContent ?? '').join(' | ') + ' | ' + (doc.title ?? '');
    const forgot = Array.from(doc.querySelectorAll('a,button')).some((el: any) => visible(el) && /forgot|reset (?:your )?password|can(?:'|’)?t sign in/i.test(el.textContent ?? ''));
    const account = Array.from(doc.querySelectorAll('input')).some((el: any) => ['text', 'email', 'tel', ''].includes(el.type ?? '') && visible(el) && /@/.test(el.value ?? ''));
    return { boxes: passwords.length, boxText: passwords.map(text).join(' | '), headings, forgot, account };
  }).catch(() => ({ boxes: 0, boxText: '', headings: '', forgot: false, account: false }));
  return { url: page.url(), boxes: seen.boxes, boxText: seen.boxText, headings: seen.headings, forgotLink: seen.forgot, prefilledAccount: seen.account };
}
