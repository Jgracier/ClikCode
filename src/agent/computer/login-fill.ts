/** A site the user already has a saved login for fills its sign-in fields from that login: the password
 * into a password box, the username (or email) into the account box. Anything else is not a sign-in field. */
import type { FieldHint } from './profiles.js';

const ACCOUNT = /user.?name|\blogin\b|e-?mail|identifier|account|sign.?in/i;

export function loginValueFor(saved: Record<string, string>, field: { password: boolean; hint: FieldHint }): string | undefined {
  if (field.password) return /new-password/.test(field.hint.autocomplete) ? undefined : saved.password;
  if (/one-time|verification|\bcode\b|\botp\b/i.test(`${field.hint.autocomplete} ${field.hint.text}`)) return undefined;
  if (field.hint.type === 'email' || /username|email/.test(field.hint.autocomplete) || ACCOUNT.test(field.hint.text)) return saved.username ?? saved.email;
  return undefined;
}
