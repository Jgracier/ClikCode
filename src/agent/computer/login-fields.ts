/** Metadata the agent may see on a sign-in page. Input values are never read. */
import type { Frame, Page } from 'playwright-core';

import { LoginError } from './login-error.js';

/** A page, or the frame inside it that holds the sign-in form. */
type LoginScope = Page | Frame;

/** Sign-in forms are sometimes embedded in an iframe (payment and identity
 * providers). The page itself wins when it has inputs; otherwise the first
 * frame that does. */
export async function loginScope(page: Page): Promise<LoginScope> {
  try {
    if (await page.locator('input:visible').count()) return page;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      if (await frame.locator('input:visible').count()) return frame;
    }
  } catch { /* fail-open-ok: A navigation can detach a frame mid-check: the page itself is the safe answer. */ }
  return page;
}

/** A field the page shows, or (kind 'choice') a question ClikCode puts to the
 * user itself, such as which saved account to sign in with. */
export type LoginField = {
  index: number; key: string; label: string; kind: 'text' | 'password' | 'choice'; required: boolean;
  options?: readonly string[];
  /** A typed-in pattern for a text field (`date`, `phone`, `zip`, `time` or e.g. `##/##/####`): see harness/events/input-mask.ts. */
  format?: string;
  /** A value already known: offered as "Keep …" with room to type a replacement (an autofill profile). */
  current?: string;
  /** A one-time code: asked for every time it appears, never saved. */
  transient?: true;
};
type InputNode = {
  type: string; autocomplete: string; name: string; id: string; required: boolean; placeholder: string;
  labels?: Iterable<{ textContent?: string | null }>;
  getAttribute(name: string): string | null;
};

/** A box that asks which account, tenant or workspace the person belongs to (AWS's "Account ID or alias"): a different thing
 * from who they are, so an email or username is never its answer. */
export const ACCOUNT_SCOPE = /account[ _-]?(?:id|alias|number)|tenant|workspace|organi[sz]ation|subdomain|company[ _-]?id/i;

function safeLabel(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]').slice(0, 80);
}

export async function loginFields(page: Page): Promise<LoginField[]> {
  const raw = await (await loginScope(page)).locator('input:visible').evaluateAll((inputs) => inputs.map((node, index) => {
    const input = node as unknown as InputNode;
    const doc = (globalThis as unknown as { document: { getElementById(id: string): { textContent?: string | null } | null } }).document;
    const labelled = input.getAttribute('aria-labelledby')?.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
    return {
      index, type: input.type.toLowerCase(), autocomplete: input.autocomplete.toLowerCase(),
      name: input.name, id: input.id, required: input.required,
      label: input.getAttribute('aria-label') || labelled || [...(input.labels ?? [])].map(label => label.textContent?.trim()).filter(Boolean).join(' ') || input.placeholder || '',
    };
  }));
  const keys = new Map<string, number>();
  return raw.slice(0, 30).flatMap((field) => {
    if (!['text', 'email', 'password', 'tel', 'number'].includes(field.type)) return [];
    const hint = `${field.label} ${field.name} ${field.id} ${field.autocomplete}`.toLowerCase();
    if (/captcha|search|coupon|promo|referral|invite|discount|zip|postal|country|area code/.test(hint)) return [];
    if (/new-password/.test(field.autocomplete)) return [];
    const password = field.type === 'password' || /current-password|password/.test(hint);
    const code = !password && (/one-time-code/.test(field.autocomplete)
      // A field named in one word (oneTimeCode, authCode, mfaCode, otp_code) is a code box as much as one labelled "Code".
      || /one.?time|\botp\b|\btotp\b|verification|security code|passcode|authenticator|\b2fa\b|\bmfa\b|\bcode\b|(?:auth|login|signin|verify|mfa|otp|totp|security|access|sms|email|factor)[ _-]?code\b/.test(hint));
    const key = code ? 'code' : password ? 'password'
      : ACCOUNT_SCOPE.test(hint) ? 'accountId'
      : field.type === 'email' || /\bemail\b/.test(field.autocomplete) ? 'email'
      : /username|identifier|email|phone|login/.test(hint) ? 'username'
      : `field_${field.index + 1}`;
    const count = keys.get(key) ?? 0;
    keys.set(key, count + 1);
    const finalKey = count ? `${key}_${count + 1}` : key;
    const label = safeLabel(field.label || (key === 'code' ? 'Verification code' : key === 'password' ? 'Password' : key === 'accountId' ? 'Account ID' : key === 'email' ? 'Email' : key === 'username' ? 'Email or username' : field.name || field.id || 'Login field'));
    return [{ index: field.index, key: finalKey, label, kind: password ? 'password' as const : 'text' as const, required: field.required, ...(code ? { transient: true as const } : {}) }];
  });
}

const isEmail = (value: string | undefined): value is string => !!value && value.includes('@');

/** What a saved login puts in each account box of the form in front of it (password and code boxes are not its business).
 * A box takes the saved value of its own kind. Two things are the same under another name and nothing else is: an email box
 * takes a saved username that is an email, and the form's ONLY account box ("Email or username") takes the saved email.
 * A form that asks for something the saved login does not hold (an account ID, a username beside an account ID, a second
 * account box) is another kind of sign-in than the saved one, and is refused whole before anything is typed: an email put
 * there as a guess is a failed attempt against the account. */
export function savedLoginValues(fields: readonly LoginField[], saved: Readonly<Record<string, string>>): Record<string, string> {
  const boxes = fields.filter(field => field.kind === 'text' && !field.transient);
  const holds = [saved.accountId && 'an account ID', (saved.email || isEmail(saved.username)) && 'an email', saved.username && !isEmail(saved.username) && 'a username']
    .filter((kind): kind is string => !!kind);
  // No saved login in use: every box is asked of the person.
  if (!holds.length) return {};
  const values: Record<string, string> = {};
  const missing: LoginField[] = [];
  for (const box of boxes) {
    const value = saved[box.key]
      ?? (box.key === 'email' && isEmail(saved.username) ? saved.username : undefined)
      ?? (box.key === 'username' && boxes.length === 1 ? saved.email : undefined);
    // One saved value never answers two boxes.
    if (value === undefined || Object.values(values).includes(value)) missing.push(box); else values[box.key] = value;
  }
  if (missing.length) {
    throw new LoginError(`Nothing was typed or pressed. This page asks for ${missing.map(field => `"${field.label}"`).join(' and ')}, and the saved login holds only ${holds.join(' and ')} (with its password): `
      + 'this is a different kind of sign-in than the saved login. Observe the page and press its own switch to the kind the saved login is for (for example "Sign in using root user email"), '
      + 'or call login with new_account true to enter and save a login that has these fields.');
  }
  return values;
}

/** Names of the buttons and links on the page, for a page that holds a key or other
 * secret in a field and so cannot be shown whole: the agent still needs to see what
 * it can press (Create, Regenerate, Copy). Names only, never values or email-like text. */
export async function pageControls(page: Page): Promise<string[]> {
  let names: string[];
  try {
    names = await page.locator('a:visible, button:visible, [role="button"]:visible, [role="link"]:visible').evaluateAll(
      nodes => nodes.map(node => {
        const element = node as unknown as { innerText?: string; getAttribute(name: string): string | null };
        return (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      }));
  } catch { return []; } // The page is navigating.
  const seen = new Set<string>();
  const controls: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (!name || name.length > 50 || /@/.test(name) || seen.has(key)) continue;
    seen.add(key);
    controls.push(name);
    if (controls.length === 30) break;
  }
  return controls;
}

export function loginFieldSummary(site: string, fields: readonly LoginField[], controls: readonly string[] = []): string {
  const shown = fields.length ? fields.map(field => `- ${field.label} (${field.kind})`).join('\n') : '- No credential field is visible. Use handoff for verification or CAPTCHA.';
  const pressable = controls.length ? `\n\nButtons and links on the page (names only):\n${controls.map(name => `- ${name}`).join('\n')}\nPress one with click, using its role and name. If a sign-in page offers different ways in (for example root or IAM user, or another account), ask the user which with ask_user before clicking.` : '';
  return `Page: ${site}\n\nSign-in fields:\n${shown}${pressable}\n\nUse login to ask for the visible fields privately; if several accounts are saved for this site the user picks one, and a single saved account is used without asking. Values are never shown here.`;
}

/** The same label twice (two accounts, or a retyped password) still has to be told apart in a list. */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map(label => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}
