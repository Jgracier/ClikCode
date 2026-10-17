/** Collect a login in the terminal or VS Code question UI. The answer is
 * consumed by the local worker; only a status reaches the agent transcript. */
import type { TurnObserver } from '../../turn/observer.js';
import type { LoginField } from './login-fields.js';

/** Fields are typed (the password masked); a 'choice' field is an arrow-key
 * picker. Every answer is marked secret, so none is recorded in the history. */
export async function askPrivateLogin(
  observer: TurnObserver, site: string, fields: readonly LoginField[], signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
  if (!observer.askQuestions) return undefined;
  if (!fields.length) return undefined;
  const result = await observer.askQuestions({
    title: `Sign in to ${new URL(site).hostname}`,
    questions: fields.map(field => field.kind === 'choice'
      ? { id: field.key, prompt: field.label, options: (field.options ?? []).map(label => ({ label })), secret: true }
      : { id: field.key, prompt: field.label, options: [], secret: true, maskInput: field.kind === 'password' }),
  }, signal);
  if (result.kind !== 'answered') return undefined;
  const values = Object.fromEntries(fields.map(field => [field.key, result.answers[field.key]?.[0] ?? '']));
  if (Object.values(values).some(value => !value)) throw new Error('Complete the visible login fields.');
  for (const field of fields) if (field.kind === 'choice' && !field.options?.includes(values[field.key]!)) throw new Error('Choose one of the listed options.');
  return values;
}
