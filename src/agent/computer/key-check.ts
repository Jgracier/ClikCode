/** Does a captured key actually reach the service it came from? Asked of the
 * service's own API at capture time, so Secrets Manager holds keys that work and
 * a wrong value (a key's id, a page blob) is refused instead of saved. The key
 * goes only to the service it was issued by, chosen by the page's host.
 *
 * Each check is paired with a control: the same request with the key damaged.
 * A service that answers both the same does not check keys at that endpoint, and
 * the result is "not tested" rather than a false "works". */
import { createSign } from 'node:crypto';

export type KeyCheck = { verdict: 'works' | 'rejected' | 'untested'; service?: string; detail: string };

type Recipe = { host: RegExp; service: string; rejects?: readonly number[]; request(key: string): { url: string; headers: Record<string, string> } };
const bearer = (url: string) => (key: string) => ({ url, headers: { Authorization: `Bearer ${key}` } });

const RECIPES: readonly Recipe[] = [
  { host: /(^|\.)huggingface\.co$/, service: 'Hugging Face', request: bearer('https://huggingface.co/api/whoami-v2') },
  { host: /(^|\.)aistudio\.google\.com$/, service: 'Google AI Studio', rejects: [400, 401, 403],
    request: key => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': key } }) },
  { host: /(^|\.)together\.(ai|xyz)$/, service: 'Together AI', request: bearer('https://api.together.xyz/v1/models') },
  { host: /(^|\.)platform\.openai\.com$/, service: 'OpenAI', request: bearer('https://api.openai.com/v1/models') },
  { host: /(^|\.)console\.anthropic\.com$/, service: 'Anthropic',
    request: key => ({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }) },
  { host: /(^|\.)console\.groq\.com$/, service: 'Groq', request: bearer('https://api.groq.com/openai/v1/models') },
  { host: /(^|\.)console\.mistral\.ai$/, service: 'Mistral', request: bearer('https://api.mistral.ai/v1/models') },
  { host: /(^|\.)platform\.deepseek\.com$/, service: 'DeepSeek', request: bearer('https://api.deepseek.com/models') },
  { host: /(^|\.)openrouter\.ai$/, service: 'OpenRouter', request: bearer('https://openrouter.ai/api/v1/key') },
  // A 403 from these can mean "valid, but this key's scope does not include that call", so only 401 is a refusal.
  { host: /(^|\.)scaleway\.com$/, service: 'Scaleway', rejects: [401], request: bearer('https://api.scaleway.ai/v1/models') },
  { host: /(^|\.)(fireworks\.ai)$/, service: 'Fireworks', rejects: [401], request: bearer('https://api.fireworks.ai/inference/v1/models') },
  { host: /(^|\.)console\.x\.ai$/, service: 'xAI', rejects: [400, 401], request: bearer('https://api.x.ai/v1/models') },
  { host: /(^|\.)dashboard\.cohere\.com$/, service: 'Cohere', rejects: [401], request: bearer('https://api.cohere.com/v1/models') },
  { host: /(^|\.)replicate\.com$/, service: 'Replicate', rejects: [401], request: bearer('https://api.replicate.com/v1/account') },
  { host: /(^|\.)cloud\.lambda(labs)?\.(ai|com)$/, service: 'Lambda', rejects: [401, 403], request: bearer('https://cloud.lambdalabs.com/api/v1/instance-types') },
  { host: /(^|\.)my\.vultr\.com$/, service: 'Vultr', rejects: [401], request: bearer('https://api.vultr.com/v2/account') },
  { host: /(^|\.)console\.hetzner\.(cloud|com)$/, service: 'Hetzner', rejects: [401], request: bearer('https://api.hetzner.cloud/v1/servers?per_page=1') },
  // 403 here means a good key on an account with no credit; only 401 is a refused key.
  { host: /(^|\.)reka\.ai$/, service: 'Reka', rejects: [401], request: bearer('https://api.reka.ai/v1/models') },
  { host: /(^|\.)publicai\.co$/, service: 'Public AI', rejects: [401], request: key => ({ url: 'https://api.publicai.co/v1/models', headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'ClikCode/1.0' } }) },
  { host: /^github\.com$/, service: 'GitHub', rejects: [401], request: bearer('https://api.github.com/user') },
];

export function keyCheckService(pageUrl: string): string | undefined {
  try { const host = new URL(pageUrl).hostname; return RECIPES.find(recipe => recipe.host.test(host))?.service; } catch { return undefined; }
}

async function status(recipe: Recipe, key: string, fetcher: typeof fetch): Promise<number | undefined> {
  const { url, headers } = recipe.request(key);
  try { return (await fetcher(url, { headers, signal: AbortSignal.timeout(8_000) })).status; } catch { return undefined; }
}

/** A Google service-account key is tested by what it is for: signing a request to Google for an access
 * token. The signing happens here, so the private key never leaves; only the signed request goes, and
 * only to Google's own token address (never to one named inside the file). */
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function serviceAccountOf(key: string): { client_email: string; private_key: string } | undefined {
  try {
    const parsed = JSON.parse(key) as { type?: string; client_email?: string; private_key?: string };
    return parsed.type === 'service_account' && parsed.client_email && parsed.private_key ? { client_email: parsed.client_email, private_key: parsed.private_key } : undefined;
  } catch { return undefined; }
}

/** Google takes up to about a minute to start accepting a service-account key it has just made: until then
 * it answers `invalid_grant: Invalid JWT Signature` for a perfectly good key. */
export type CheckOptions = { fresh?: boolean; pause?: (ms: number) => Promise<void> };
const FRESH_TRIES = 8;
const FRESH_GAP_MS = 8_000;

async function checkServiceAccount(account: { client_email: string; private_key: string }, fetcher: typeof fetch, options: CheckOptions): Promise<KeyCheck> {
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let last = await tryServiceAccount(account, fetcher);
  for (let attempt = 1; options.fresh && last.verdict === 'rejected' && /invalid_grant/.test(last.detail) && attempt < FRESH_TRIES; attempt++) {
    await pause(FRESH_GAP_MS);
    last = await tryServiceAccount(account, fetcher);
  }
  return last;
}

async function tryServiceAccount(account: { client_email: string; private_key: string }, fetcher: typeof fetch): Promise<KeyCheck> {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: GOOGLE_TOKEN, iat: now, exp: now + 300 })}`;
  let assertion: string;
  try { assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`; }
  catch { return { verdict: 'rejected', service: 'Google', detail: 'the private key in the file is not a usable key' }; }
  try {
    const response = await fetcher(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(8_000) });
    const body = await response.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
    if (response.ok && body.access_token) return { verdict: 'works', service: 'Google', detail: `Google gave ${account.client_email} an access token with it` };
    if (response.status === 400 || response.status === 401) return { verdict: 'rejected', service: 'Google', detail: `Google refused it (${body.error ?? `HTTP ${response.status}`}${body.error_description ? `: ${body.error_description}` : ''})` };
    return { verdict: 'untested', service: 'Google', detail: `Google answered HTTP ${response.status}, which does not show whether the key works` };
  } catch { return { verdict: 'untested', service: 'Google', detail: 'Google could not be reached' }; }
}

export async function checkKey(pageUrl: string, key: string, fetcher: typeof fetch = fetch, options: CheckOptions = {}): Promise<KeyCheck> {
  const account = serviceAccountOf(key);
  if (account) return checkServiceAccount(account, fetcher, options);
  let host: string;
  try { host = new URL(pageUrl).hostname; } catch { return { verdict: 'untested', detail: 'no check is known for this site' }; }
  const recipe = RECIPES.find(candidate => candidate.host.test(host));
  if (!recipe) return { verdict: 'untested', detail: 'no check is known for this site' };
  const rejects = recipe.rejects ?? [401, 403];
  const real = await status(recipe, key, fetcher);
  if (real === undefined) return { verdict: 'untested', service: recipe.service, detail: `${recipe.service} could not be reached` };
  if (rejects.includes(real)) return { verdict: 'rejected', service: recipe.service, detail: `${recipe.service} refused it (HTTP ${real})` };
  if (real !== 200) return { verdict: 'untested', service: recipe.service, detail: `${recipe.service} answered HTTP ${real}, which does not show whether the key works` };
  const control = await status(recipe, `${key.slice(0, -3)}xyz`, fetcher);
  if (control !== undefined && rejects.includes(control)) return { verdict: 'works', service: recipe.service, detail: `${recipe.service} accepted it` };
  return { verdict: 'untested', service: recipe.service, detail: `${recipe.service} answers a damaged key the same way, so this check proves nothing` };
}
