/** Does a captured key actually reach the service it came from? Asked of the
 * service's own API at capture time, so Secrets Manager holds keys that work and
 * a wrong value (a key's id, a page blob) is refused instead of saved. The key
 * goes only to the service it was issued by, chosen by the page's host.
 *
 * Each check is paired with a control: the same request with the key damaged.
 * A service that answers both the same does not check keys at that endpoint, and
 * the result is "not tested" rather than a false "works". */
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
];

export function keyCheckService(pageUrl: string): string | undefined {
  try { const host = new URL(pageUrl).hostname; return RECIPES.find(recipe => recipe.host.test(host))?.service; } catch { return undefined; }
}

async function status(recipe: Recipe, key: string, fetcher: typeof fetch): Promise<number | undefined> {
  const { url, headers } = recipe.request(key);
  try { return (await fetcher(url, { headers, signal: AbortSignal.timeout(8_000) })).status; } catch { return undefined; }
}

export async function checkKey(pageUrl: string, key: string, fetcher: typeof fetch = fetch): Promise<KeyCheck> {
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
