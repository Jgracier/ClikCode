/** Metadata the agent may see on a sign-in page. Input values are never read. */
import type { Page } from 'playwright-core';

/** A field the page shows, or (kind 'choice') a question ClikCode puts to the
 * user itself, such as which saved account to sign in with. */
export type LoginField = {
  index: number; key: string; label: string; kind: 'text' | 'password' | 'choice'; required: boolean;
  options?: readonly string[];
  /** A one-time code: asked for every time it appears, never saved. */
  transient?: true;
};
type InputNode = {
  type: string; autocomplete: string; name: string; id: string; required: boolean; placeholder: string;
  labels?: Iterable<{ textContent?: string | null }>;
  getAttribute(name: string): string | null;
};

function safeLabel(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]').slice(0, 80);
}

export async function loginFields(page: Page): Promise<LoginField[]> {
  const raw = await page.locator('input:visible').evaluateAll((inputs) => inputs.map((node, index) => {
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
      || /one.time|\botp\b|\btotp\b|verification|security code|passcode|authenticator|\b2fa\b|\bmfa\b|\bcode\b/.test(hint));
    const key = code ? 'code' : password ? 'password'
      : /account[ -]?id|account[ -]?alias/.test(hint) ? 'accountId'
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

const OPTION_HINT = /sign in|log in|login|root|iam|\buser\b|account|\bsso\b|single sign|continue with|use another|different|email|phone|passkey|security key|try another/i;
const OPTION_NOISE = /privacy|terms|cookie|language|forgot|create|help|learn more|contact/i;

/** Other ways to sign in that the page offers (root or IAM, another account,
 * SSO), by their visible names. Names that look like an email address are
 * dropped so an account chooser never tells the model who is signed in. */
export async function loginOptions(page: Page): Promise<string[]> {
  let names: string[];
  try {
    names = await page.locator('a:visible, button:visible, [role="button"]:visible, [role="link"]:visible').evaluateAll(
      nodes => nodes.map(node => ((node as unknown as { innerText?: string }).innerText ?? '').replace(/\s+/g, ' ').trim()));
  } catch { return []; } // The page is navigating.
  const seen = new Set<string>();
  const options: string[] = [];
  for (const name of names) {
    if (!name || name.length > 60 || /@/.test(name) || !OPTION_HINT.test(name) || OPTION_NOISE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(name);
    if (options.length === 8) break;
  }
  return options;
}

export function loginFieldSummary(site: string, fields: readonly LoginField[], options: readonly string[] = []): string {
  const shown = fields.length ? fields.map(field => `- ${field.label} (${field.kind})`).join('\n') : '- No credential field is visible. Use handoff for verification or CAPTCHA.';
  const other = options.length
    ? `\n\nOther ways to sign in on this page:\n${options.map(name => `- ${name}`).join('\n')}\nIf more than one could apply (for example root user or IAM user), ask the user which one with ask_user before clicking.`
    : '';
  return `Page: ${site}\n\nSign-in fields:\n${shown}${other}\n\nUse login to ask for the visible fields privately; if several accounts are saved for this site the user picks one, and a single saved account is used without asking. Values are never shown here.`;
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
