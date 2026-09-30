/** Web search for the agent loop. It runs on the user's machine whatever the
 * model is, so it cannot lean on a provider's server-side search.
 *
 * Backends, tried in order:
 *   1. Brave Search API  — key from BRAVE_SEARCH_API_KEY, else the ClikCode
 *      config store key `webSearch.braveApiKey`.
 *   2. Tavily            — key from TAVILY_API_KEY, else `webSearch.tavilyApiKey`.
 *   3. DuckDuckGo's HTML endpoint, which needs no key, so search works out of
 *      the box.
 * A keyed backend that fails falls through to the next one; the output says
 * so, because a silent switch would hide an expired key forever.
 *
 * Every request goes through web_fetch's fetchVetted: pinned DNS, private
 * address refusal and a size cap apply here exactly as they do there. */
import Conf from 'conf';
import { turnCancelledError } from '../cancellation.js';
import type { NetworkSeams } from '../model-client.js';
import { defineTool } from '../tool-contract.js';
import { decodeHtmlEntities, fetchVetted } from './web-fetch.js';
import { formatToolRow } from '../../harness/protocol/tools.js';

interface WebSearchArgs { query: string; max_results?: number }

export interface SearchResult { title: string; url: string; snippet: string }

export interface SearchKeys { brave?: string; tavily?: string }

type BackendName = 'Brave Search' | 'Tavily' | 'DuckDuckGo';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const TIMEOUT_MS = 15_000;
/** Result pages are small; anything bigger is not a result page. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Local models have small contexts: a snippet is a hint, not the page. */
const SNIPPET_CHARS = 300;
const USER_AGENT = 'ClikCode/1';

class BackendError extends Error {}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** DuckDuckGo wraps every result link as //duckduckgo.com/l/?uddg=<target>.
 * Ad links go to /y.js instead and carry no organic target; they are dropped. */
export function decodeDuckDuckGoLink(href: string): string | undefined {
  const raw = decodeHtmlEntities(href);
  let url: URL;
  try { url = new URL(raw, 'https://duckduckgo.com'); } catch { return undefined; }
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) {
    if (url.pathname !== '/l/') return undefined;
    const target = url.searchParams.get('uddg');
    return target && /^https?:\/\//i.test(target) ? target : undefined;
  }
  return /^https?:$/.test(url.protocol) ? url.toString() : undefined;
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Each organic result is a div whose class list starts with "result ";
  // splitting on it keeps one result's title and snippet together.
  const blocks = html.split(/<div class="result\b/).slice(1);
  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('>'));
    if (/result--ad/.test(head)) continue;
    const anchor = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      ?? /<a\b[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    const url = decodeDuckDuckGoLink(anchor[1]);
    if (!url) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block)?.[1] ?? '';
    results.push({ title: stripTags(anchor[2]), url, snippet: stripTags(snippet) });
  }
  return results;
}

export function parseBraveJson(body: unknown): SearchResult[] {
  const list = (body as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: { title?: unknown; url?: unknown; description?: unknown }) => typeof entry?.url === 'string'
    // Brave marks query terms with <strong> inside titles and descriptions.
    ? [{ title: stripTags(String(entry.title ?? '')), url: entry.url, snippet: stripTags(String(entry.description ?? '')) }]
    : []);
}

export function parseTavilyJson(body: unknown): SearchResult[] {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: { title?: unknown; url?: unknown; content?: unknown }) => typeof entry?.url === 'string'
    ? [{ title: String(entry.title ?? '').trim(), url: entry.url, snippet: String(entry.content ?? '').replace(/\s+/g, ' ').trim() }]
    : []);
}

interface BackendCall { query: string; count: number; net?: NetworkSeams; signal: AbortSignal }

async function request(label: BackendName, url: string, call: BackendCall, init: { headers: Record<string, string>; method?: 'POST'; body?: string }): Promise<{ status: number; text: string }> {
  const response = await fetchVetted(url, {
    net: call.net, signal: call.signal, maxBytes: MAX_RESPONSE_BYTES,
    headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...init.headers },
    ...(init.method ? { method: init.method } : {}), ...(init.body !== undefined ? { body: init.body } : {}),
  });
  if (!response) throw new BackendError(`${label} redirected too many times`);
  return { status: response.status, text: response.body.toString('utf8') };
}

function parseJson(label: BackendName, text: string): unknown {
  try { return JSON.parse(text); } catch { throw new BackendError(`${label} returned a response that is not JSON`); }
}

function httpFailure(label: BackendName, status: number, text: string): BackendError {
  // Auth failures get named outright: that is the one the user can fix.
  const hint = status === 401 || status === 403 ? ' (the API key was rejected)' : status === 429 ? ' (rate limited or out of quota)' : '';
  const detail = clip(text.replace(/\s+/g, ' ').trim(), 200);
  return new BackendError(`${label} returned HTTP ${status}${hint}${detail ? `: ${detail}` : ''}`);
}

async function searchBrave(key: string, call: BackendCall): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(call.query)}&count=${call.count}`;
  const { status, text } = await request('Brave Search', url, call, { headers: { accept: 'application/json', 'x-subscription-token': key } });
  if (status !== 200) throw httpFailure('Brave Search', status, text);
  return parseBraveJson(parseJson('Brave Search', text));
}

async function searchTavily(key: string, call: BackendCall): Promise<SearchResult[]> {
  const { status, text } = await request('Tavily', 'https://api.tavily.com/search', call, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: call.query, max_results: call.count, search_depth: 'basic' }),
  });
  if (status !== 200) throw httpFailure('Tavily', status, text);
  return parseTavilyJson(parseJson('Tavily', text));
}

async function searchDuckDuckGo(call: BackendCall): Promise<SearchResult[]> {
  // A POST of the search form, as the page itself submits it: measured from
  // this machine, a GET of /html/?q= drew the bot check on 3 of 5 queries
  // while the same queries POSTed drew it on none.
  const { status, text } = await request('DuckDuckGo', 'https://html.duckduckgo.com/html/', call, {
    method: 'POST',
    headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: call.query }).toString(),
  });
  // No retry: measured here, four quick searches trip a lockout that lasts
  // for minutes, and retrying inside it only prolongs it.
  if (status === 202 || /anomaly-modal|anomaly\.js/.test(text)) throw new BackendError('DuckDuckGo answered with its bot check instead of results (it does this after a burst of searches, and the lockout can last minutes); search less often, or set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY');
  if (status !== 200) throw httpFailure('DuckDuckGo', status, '');
  const results = parseDuckDuckGoHtml(text);
  if (!results.length && !/class="no-results"|No\s+results\./i.test(text) && /<div class="result\b/.test(text)) {
    throw new BackendError('DuckDuckGo returned a page whose results could not be read (its markup may have changed)');
  }
  return results;
}

export function formatResults(query: string, backend: BackendName, results: readonly SearchResult[], notes: readonly string[]): string {
  const lines = [`Search results for "${query}" via ${backend}:`];
  for (const note of notes) lines.push(`(note: ${note})`);
  if (!results.length) lines.push('No results.');
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || result.url}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${clip(result.snippet, SNIPPET_CHARS)}`);
  });
  return lines.join('\n');
}

/** Environment first so a one-off shell override beats the stored value. */
export function resolveSearchKeys(env: NodeJS.ProcessEnv, stored: { braveApiKey?: unknown; tavilyApiKey?: unknown } = {}): SearchKeys {
  const pick = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim();
  const brave = pick(env.BRAVE_SEARCH_API_KEY, stored.braveApiKey);
  const tavily = pick(env.TAVILY_API_KEY, stored.tavilyApiKey);
  return { ...(brave ? { brave } : {}), ...(tavily ? { tavily } : {}) };
}

/** The same store `src/index.ts` opens. Read per call so a key saved while a
 * session is running takes effect without a restart; a missing or unreadable
 * store just means no stored keys. */
function readStoredSearchConfig(): { braveApiKey?: unknown; tavilyApiKey?: unknown } {
  try {
    const value = new Conf({ projectName: 'clikcode', configFileMode: 0o600 }).get('webSearch');
    return value && typeof value === 'object' ? value as { braveApiKey?: unknown; tavilyApiKey?: unknown } : {};
  } catch {
    return {};
  }
}

export interface WebSearchOptions {
  env?: NodeJS.ProcessEnv;
  readStoredConfig?: () => { braveApiKey?: unknown; tavilyApiKey?: unknown };
}

export function createWebSearchTool(options: WebSearchOptions = {}) {
  return defineTool<WebSearchArgs>({
    name: 'web_search',
    // Network, like web_fetch: a search changes nothing here, but the query
    // leaves the machine for a third party and can carry the project's code,
    // names or secrets. It asks like any other outbound request; "always"
    // saves a plain `web_search` rule, since there is no domain to scope to.
    class: 'network',
    description: 'Search the web and return a numbered list of results (title, URL, snippet). Use web_fetch to read a result in full.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `How many results to return (default ${DEFAULT_RESULTS}, at most ${MAX_RESULTS}).` },
      },
    },
    label: (args) => formatToolRow('web_search', args.query, 'fetch'),
    async run(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) return { output: 'The search query is empty.', isError: true };
      const count = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(args.max_results ?? DEFAULT_RESULTS)) || DEFAULT_RESULTS));
      const keys = resolveSearchKeys(options.env ?? process.env, (options.readStoredConfig ?? readStoredSearchConfig)());
      const backends: { name: BackendName; run: (call: BackendCall) => Promise<SearchResult[]> }[] = [];
      if (keys.brave) { const key = keys.brave; backends.push({ name: 'Brave Search', run: (call) => searchBrave(key, call) }); }
      if (keys.tavily) { const key = keys.tavily; backends.push({ name: 'Tavily', run: (call) => searchTavily(key, call) }); }
      backends.push({ name: 'DuckDuckGo', run: searchDuckDuckGo });

      const failures: string[] = [];
      for (const backend of backends) {
        // Each backend gets its own clock: a hung keyed backend must not eat
        // the time the keyless fallback needs.
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
        const onAbort = (): void => timeout.abort();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const results = await backend.run({ query, count, signal: timeout.signal, ...(ctx.net ? { net: ctx.net } : {}) });
          return { output: formatResults(query, backend.name, results.slice(0, count), failures.map((failure) => `${failure}; fell back`)) };
        } catch (error) {
          if (ctx.signal?.aborted) throw turnCancelledError();
          failures.push(timeout.signal.aborted
            ? `${backend.name} timed out after ${TIMEOUT_MS / 1000}s`
            : error instanceof BackendError ? error.message : `${backend.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      }
      return { output: `Web search failed.\n${failures.map((failure) => `- ${failure}`).join('\n')}`, isError: true };
    },
  });
}

export const webSearchTool = createWebSearchTool();
