import { createVerify, generateKeyPairSync } from 'node:crypto';
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

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'service_account', project_id: 'p', private_key_id: 'a92ef41d3362f8ba630ce9d06e248537e08cc19f', client_email: 'clikdeploy-compute@p.iam.gserviceaccount.com',
  private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://evil.example/token', ...extra });

/** Google, as far as the check can tell: accepts a request signed by the key it knows. */
function google(answer: (signedOk: boolean, claims: Record<string, unknown>) => Response, seen: { url?: string } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.url = String(url);
    const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    const ok = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(pair.publicKey, signature!, 'base64url');
    return answer(ok, JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8')));
  }) as unknown as typeof fetch;
}

it('tests a Google service-account key by getting a token with it, signed here and sent only to Google', async () => {
  const seen: { url?: string } = {};
  const got: { ok?: boolean; claims?: Record<string, unknown> } = {};
  const result = await checkKey('https://console.cloud.google.com/iam-admin', serviceAccount(), google((ok, claims) => {
    Object.assign(got, { ok, claims });
    return new Response(JSON.stringify({ access_token: 'x' }), { status: 200 });
  }, seen));
  expect(got.ok).toBe(true);
  expect(got.claims).toMatchObject({ iss: 'clikdeploy-compute@p.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform' });
  expect(result).toMatchObject({ verdict: 'works', service: 'Google' });
  // The address inside the file is ignored: the signed request goes to Google's own token endpoint.
  expect(seen.url).toBe('https://oauth2.googleapis.com/token');
});

it('reports a service-account key Google refuses as rejected, and one that is not a usable key', async () => {
  const refused = await checkKey('https://console.cloud.google.com/', serviceAccount(), google(() => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 })));
  expect(refused.verdict).toBe('rejected');
  expect(refused.detail).toContain('invalid_grant');
  const broken = await checkKey('https://console.cloud.google.com/', serviceAccount({ private_key: 'not a key' }), google(() => new Response('{}', { status: 200 })));
  expect(broken).toMatchObject({ verdict: 'rejected', detail: 'the private key in the file is not a usable key' });
});

it('treats an unreachable Google as untested, and leaves other JSON alone', async () => {
  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  expect((await checkKey('https://console.cloud.google.com/', serviceAccount(), down)).verdict).toBe('untested');
  expect((await checkKey('https://example.com/', JSON.stringify({ type: 'something-else' }))).detail).toBe('no check is known for this site');
});

const refusing = (error = 'invalid_grant'): Response => new Response(JSON.stringify({ error, error_description: 'Invalid JWT Signature.' }), { status: 400 });

it('keeps asking Google for a minute when the key was only just made, because Google is slow to accept a new one', async () => {
  let calls = 0;
  const slow = google(() => (++calls < 3 ? refusing() : new Response(JSON.stringify({ access_token: 'x' }), { status: 200 })));
  const pauses: number[] = [];
  const result = await checkKey('https://console.cloud.google.com/', serviceAccount(), slow, { fresh: true, pause: async ms => { pauses.push(ms); } });
  expect(result.verdict).toBe('works');
  expect(calls).toBe(3);
  expect(pauses).toEqual([8000, 8000]);
});

it('gives up with Google\'s reason after the wait, and does not wait at all for a key that was not just made', async () => {
  let calls = 0;
  const never = google(() => { calls++; return refusing(); });
  const waited = await checkKey('https://console.cloud.google.com/', serviceAccount(), never, { fresh: true, pause: async () => undefined });
  expect(waited).toMatchObject({ verdict: 'rejected' });
  expect(calls).toBe(8);
  calls = 0;
  expect((await checkKey('https://console.cloud.google.com/', serviceAccount(), never, { pause: async () => { throw new Error('should not wait'); } })).verdict).toBe('rejected');
  expect(calls).toBe(1);
});

it('knows the common key pages, and sends each key only to its own service', async () => {
  const urls: string[] = [];
  const spy = (async (url: unknown, init?: RequestInit) => { urls.push(String(url)); const sent = JSON.stringify(init?.headers ?? {}); return new Response('{}', { status: sent.includes('abcDEF123456789xyz0') ? 200 : 401 }); }) as typeof fetch;
  for (const [page, host] of [['https://console.scaleway.com/iam/api-keys', 'api.scaleway.ai'], ['https://github.com/settings/tokens', 'api.github.com'], ['https://replicate.com/account/api-tokens', 'api.replicate.com'], ['https://my.vultr.com/settings/#settingsapi', 'api.vultr.com'], ['https://console.hetzner.cloud/projects', 'api.hetzner.cloud']] as const) {
    urls.length = 0;
    expect(await checkKey(page, 'abcDEF123456789xyz0', spy)).toMatchObject({ verdict: 'works' });
    expect(urls.every(url => new URL(url).hostname === host)).toBe(true);
  }
  expect(keyCheckService('https://console.x.ai/team/keys')).toBe('xAI');
});
