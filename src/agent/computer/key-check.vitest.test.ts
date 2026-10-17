import { expect, it } from 'vitest';
import { checkKey, keyCheckService } from './key-check.js';

const KEY = ['hf', 'QjXkVbNzWpLcRmTgHsYdFaUeIoKnBvCxZq'].join('_'); // assembled so no token-shaped text sits in the source
/** A service that accepts exactly one key. */
const service = (accepted: string, bad = 401): typeof fetch => (async (_url: unknown, init?: RequestInit) => {
  const sent = JSON.stringify(init?.headers ?? {});
  return new Response('{}', { status: sent.includes(accepted) ? 200 : bad });
}) as typeof fetch;

it('says it works only when the service accepts the key and refuses a damaged copy', async () => {
  const result = await checkKey('https://huggingface.co/settings/tokens', KEY, service(KEY));
  expect(result).toMatchObject({ verdict: 'works', service: 'Hugging Face' });
});

it('reports a refused key as rejected', async () => {
  expect(await checkKey('https://huggingface.co/settings/tokens', 'key_0123456789abcdef', service(KEY))).toMatchObject({ verdict: 'rejected', service: 'Hugging Face' });
});

it('does not claim a pass when the endpoint answers a damaged key the same way', async () => {
  const open = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  expect(await checkKey('https://api.together.ai/settings/api-keys', KEY, open)).toMatchObject({ verdict: 'untested' });
});

it('treats an unreachable service or an unexpected status as untested, not as a failure', async () => {
  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  expect((await checkKey('https://huggingface.co/', KEY, down)).verdict).toBe('untested');
  const busy = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
  expect((await checkKey('https://huggingface.co/', KEY, busy)).verdict).toBe('untested');
});

it('counts Google\'s 400 for a bad key as a refusal', async () => {
  const google = (async (_u: unknown, init?: RequestInit) => new Response('{}', { status: JSON.stringify(init?.headers).includes('AQ.good-key-0123456789abcdef"') ? 200 : 400 })) as unknown as typeof fetch;
  expect((await checkKey('https://aistudio.google.com/api-keys', 'AQ.good-key-0123456789abcdef', google)).verdict).toBe('works');
  expect((await checkKey('https://aistudio.google.com/api-keys', 'AQ.bad-key-0123456789abcdef', google)).verdict).toBe('rejected');
});

it('has no check for a site it does not know', async () => {
  expect(await checkKey('https://example.com/keys', KEY)).toMatchObject({ verdict: 'untested', detail: 'no check is known for this site' });
  expect(keyCheckService('https://platform.openai.com/api-keys')).toBe('OpenAI');
  expect(keyCheckService('https://example.com/')).toBeUndefined();
});
