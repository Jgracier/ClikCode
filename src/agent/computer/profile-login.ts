/** Answers a sign-in page's fields from the autofill profile, so a missing saved login does not mean a question
 * to the user: the profile's sign-in email, and its `password` secret, which only ever goes into the form. A page
 * that asks for anything else (a one-time code, a choice, a field the profile has no answer for) is not answered
 * here and falls through to the usual private prompt, or to the queue when running unattended. */
import type { LoginField } from './login-fields.js';
import { defaultProfile, listProfiles, PASSWORD_SECRET, readProfileSecret } from './profiles.js';
import { registerSecret } from './secret-scrubber.js';

/** The boxes the profile's email answers. An account ID, tenant or workspace box is not one: the profile holds no such thing. */
const EMAIL_KEYS = new Set(['email', 'username']);

export async function profileLoginAnswers(stateDir: string, fields: readonly LoginField[], label?: string): Promise<Record<string, string> | undefined> {
  if (!fields.length || fields.some(field => field.transient || field.kind === 'choice')) return undefined;
  // The email is one answer for one box. A form with several account boxes (an account ID beside a username) wants things the
  // profile does not hold, and the same email in each would be a failed sign-in: it is left to the private prompt.
  if (fields.filter(field => field.kind !== 'password' && field.key !== 'password').length > 1) return undefined;
  // One profile answers the whole form, or none does: a sign-in made with one profile's email and another's password is a failed
  // sign-in at best, and at worst hands one account's password to another account's page. A profile the caller NAMED (an AWS
  // root account, say) answers; else the default one (Personal; listProfiles sorts by label, which would put an admin profile
  // such as "ClikDeploy" ahead of it). When that profile lacks an answer, the form goes to the private prompt.
  const listed = await listProfiles(stateDir);
  const named = label ? listed.find(profile => profile.label.toLowerCase() === label.trim().toLowerCase()) : undefined;
  const profile = named ?? defaultProfile(listed);
  if (!profile) return undefined;
  const email = profile.fields.sso_email ?? profile.fields.email;
  const answers: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'password' || field.key === 'password') {
      const password = profile.secrets?.[PASSWORD_SECRET] ? await readProfileSecret(stateDir, profile, PASSWORD_SECRET) : undefined;
      if (!password) return undefined;
      registerSecret(password);
      answers[field.key] = password;
    } else if (EMAIL_KEYS.has(field.key) && email) answers[field.key] = email;
    else return undefined;
  }
  return answers;
}
