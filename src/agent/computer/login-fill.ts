/** A site the user already has a saved login for fills its sign-in fields from that login: the password
 * into a password box, the username (or email) into the account box. Anything else is not a sign-in field:
 * a business name, a registration number or a postal code is never the account's email. */
import { isUnfillable, profileKeyFor, type FieldHint } from './profiles.js';

const ACCOUNT = /user.?name|\blogin\b|e-?mail|correo|courriel|identifier|\baccount\b|sign.?in|usuario|utilisateur|benutzer/i;

export function loginValueFor(saved: Record<string, string>, field: { password: boolean; hint: FieldHint }): string | undefined {
  if (field.password) return /new-password/.test(field.hint.autocomplete) ? undefined : saved.password;
  if (/one-time|verification|\bcode\b|\botp\b/i.test(`${field.hint.autocomplete} ${field.hint.text}`) && !/postal|zip/i.test(field.hint.text)) return undefined;
  // A box another profile detail owns (company, phone, postal code, name) or that asks for a number the login has none of is not an account box.
  const key = profileKeyFor(field.hint);
  if ((key && key !== 'email') || isUnfillable(field.hint)) return undefined;
  if (field.hint.type === 'email' || /username|email/.test(field.hint.autocomplete) || ACCOUNT.test(`${field.hint.label ?? ''} ${field.hint.text}`)) return saved.username ?? saved.email;
  return undefined;
}
