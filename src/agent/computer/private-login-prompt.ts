/** Collect a login in the terminal or VS Code question UI. The answer is
 * consumed by the local worker; only a status reaches the agent transcript. */
import type { TurnObserver } from '../../turn/observer.js';
import type { PrivateLogin } from './credential-vault.js';

export async function askPrivateLogin(
  observer: TurnObserver, site: string, signal?: AbortSignal,
): Promise<PrivateLogin | undefined> {
  if (!observer.askQuestions) return undefined;
  const result = await observer.askQuestions({
    title: `Save login for ${site}`,
    questions: [
      { id: 'accountId', header: 'Account ID', prompt: 'Account ID, if needed', options: [], optional: true, secret: true },
      { id: 'email', header: 'Email or username', prompt: 'Email or username, if needed', options: [], optional: true, secret: true },
      { id: 'password', header: 'Password', prompt: 'Password', options: [], secret: true },
    ],
  }, signal);
  if (result.kind !== 'answered') return undefined;
  const accountId = result.answers.accountId?.[0] ?? '';
  const email = result.answers.email?.[0] ?? '';
  const password = result.answers.password?.[0] ?? '';
  if ((!email && !accountId) || !password) throw new Error('Enter an account ID or email and a password.');
  return { accountId, email, password };
}
