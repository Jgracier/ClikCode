/** Metadata the agent may see on a sign-in page. Input values are never read. */
import type { Page } from 'playwright-core';

export type LoginField = { index: number; key: string; label: string; kind: 'text' | 'password'; required: boolean };
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
    if (!['text', 'email', 'password', 'tel'].includes(field.type)) return [];
    const hint = `${field.label} ${field.name} ${field.id} ${field.autocomplete}`.toLowerCase();
    if (/captcha|verification|one.time|\botp\b|security code|search|coupon|promo/.test(hint)) return [];
    const password = field.type === 'password' || /current-password|password/.test(hint);
    if (/new-password/.test(field.autocomplete)) return [];
    const key = password ? 'password'
      : /account[ -]?id|account[ -]?alias/.test(hint) ? 'accountId'
      : field.type === 'email' || /\bemail\b/.test(field.autocomplete) ? 'email'
      : /username|identifier|email|phone|login/.test(hint) ? 'username'
      : `field_${field.index + 1}`;
    const count = keys.get(key) ?? 0;
    keys.set(key, count + 1);
    const finalKey = count ? `${key}_${count + 1}` : key;
    const label = safeLabel(field.label || (key === 'password' ? 'Password' : key === 'accountId' ? 'Account ID' : key === 'email' ? 'Email' : key === 'username' ? 'Email or username' : field.name || field.id || 'Login field'));
    return [{ index: field.index, key: finalKey, label, kind: password ? 'password' as const : 'text' as const, required: field.required }];
  });
}

export function loginFieldSummary(site: string, fields: readonly LoginField[]): string {
  return `Page: ${site}\n\nSign-in fields:\n${fields.length ? fields.map(field => `- ${field.label} (${field.kind})`).join('\n') : '- No credential field is visible. Use handoff for verification or CAPTCHA.'}\n\nUse login to ask for the visible fields privately. Values are never shown here.`;
}
