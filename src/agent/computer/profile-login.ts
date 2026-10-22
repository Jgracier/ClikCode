/** Answers a sign-in page's fields from the autofill profile, so a missing saved login does not mean a question
 * to the user: the profile's sign-in email, and its `password` secret, which only ever goes into the form. A page
 * that asks for anything else (a one-time code, a choice, a field the profile has no answer for) is not answered
 * here and falls through to the usual private prompt, or to the queue when running unattended. */
import type { LoginField } from './login-fields.js';
import { defaultProfile, listProfiles, PASSWORD_SECRET, readProfileSecret } from './profiles.js';
import { registerSecret } from './secret-scrubber.js';

const ACCOUNT_KEYS = new Set(['email', 'username', 'accountId']);

export async function profileLoginAnswers(stateDir: string, fields: readonly LoginField[]): Promise<Record<string, string> | undefined> {
  if (!fields.length || fields.some(field => field.transient || field.kind === 'choice')) return undefined;
  // The default profile (Personal) first: listProfiles sorts by label, which would put an admin profile such as "ClikDeploy" ahead of it.
  const listed = await listProfiles(stateDir);
  const first = defaultProfile(listed);
  const profiles = first ? [first, ...listed.filter(profile => profile !== first)] : listed;
  const email = profiles.map(profile => profile.fields.sso_email ?? profile.fields.email).find(Boolean);
  const holder = profiles.find(profile => profile.secrets?.[PASSWORD_SECRET]);
  const answers: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'password' || field.key === 'password') {
      const password = holder ? await readProfileSecret(stateDir, holder, PASSWORD_SECRET) : undefined;
      if (!password) return undefined;
      registerSecret(password);
      answers[field.key] = password;
    } else if (ACCOUNT_KEYS.has(field.key) && email) answers[field.key] = email;
    else return undefined;
  }
  return answers;
}
