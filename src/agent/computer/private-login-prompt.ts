/** Collect a login in the terminal or VS Code question UI. The answer is
 * consumed by the local worker; only a status reaches the agent transcript. */
import type { TurnObserver } from '../../turn/observer.js';
import type { LoginField } from './login-fields.js';

export async function askPrivateLogin(
  observer: TurnObserver, site: string, fields: readonly LoginField[], signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
  if (!observer.askQuestions) return undefined;
  if (!fields.length) return undefined;
  const result = await observer.askQuestions({
    title: `Sign in to ${new URL(site).hostname}`,
    questions: fields.map(field => ({
      id: field.key, prompt: field.label, options: [], secret: true,
      maskInput: field.kind === 'password',
    })),
  }, signal);
  if (result.kind !== 'answered') return undefined;
  const values = Object.fromEntries(fields.map(field => [field.key, result.answers[field.key]?.[0] ?? '']));
  if (Object.values(values).some(value => !value)) throw new Error('Complete the visible login fields.');
  return values;
}
