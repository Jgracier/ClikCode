import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { NetworkSeams, PinnedRequestOptions, PinnedResponse } from '../model-client.js';
import { decidePermission, parsePermissionRules, suggestPermissionRule } from '../permissions.js';
import type { ToolContext } from '../tool-contract.js';
import { createWebSearchTool, decodeDuckDuckGoLink, parseBraveJson, parseDuckDuckGoHtml, parseTavilyJson, resolveSearchKeys } from './web-search.js';

// A real html.duckduckgo.com response for "typescript satisfies operator".
const DDG_HTML = readFileSync(new URL('./fixtures/duckduckgo-results.html', import.meta.url), 'utf8');

const BRAVE_JSON = {
  type: 'search',
  query: { original: 'rust borrow checker' },
  web: {
    type: 'search',
    results: [
      { title: 'The <strong>Borrow Checker</strong> - Rust Book', url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html', description: 'References and <strong>borrowing</strong> &amp; lifetimes.', age: '2 days ago' },
      { title: 'Understanding the borrow checker', url: 'https://blog.example.org/borrow', description: 'A walkthrough.' },
      { title: 'No URL entry' },
    ],
  },
};

const TAVILY_JSON = {
  query: 'rust borrow checker',
  answer: null,
  results: [
    { title: 'References and Borrowing', url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html', content: 'A reference is like a pointer\n that is an address.', score: 0.93 },
    { title: 'Borrow checker explained', url: 'https://blog.example.org/borrow', content: 'Explained.', score: 0.71 },
  ],
  response_time: 1.2,
};

interface Reply { status: number; body: string; headers?: Record<string, string> }
interface Call { url: URL; options: PinnedRequestOptions }

function fakeNet(route: (url: URL, options: PinnedRequestOptions) => Reply | Promise<Reply>, lookup: NetworkSeams['lookup'] = async () => [{ address: '93.184.216.34', family: 4 }]): NetworkSeams & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    lookup,
    async request(url, _pinned, options): Promise<PinnedResponse> {
      calls.push({ url, options });
      const reply = await route(url, options);
      return { status: reply.status, headers: reply.headers ?? {}, body: Readable.from([Buffer.from(reply.body)]) };
    },
  };
}

function context(net: NetworkSeams, signal?: AbortSignal): ToolContext {
  return { cwd: '/tmp', addDirs: [], sessionId: 's', turnId: 't', stateDir: '/tmp', homeDir: '/tmp', net, ...(signal ? { signal } : {}) } as unknown as ToolContext;
}

const ddgOk = (url: URL): Reply => url.hostname === 'html.duckduckgo.com' ? { status: 200, body: DDG_HTML, headers: { 'content-type': 'text/html' } } : { status: 500, body: 'unexpected' };

function tool(env: NodeJS.ProcessEnv = {}, stored: Record<string, unknown> = {}) {
  return createWebSearchTool({ env, readStoredConfig: () => stored });
}

describe('DuckDuckGo HTML parsing', () => {
  it('reads titles, decoded target URLs and snippets from a saved results page', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    expect(results.length).toBe(10);
    expect(results[0]).toEqual({
      title: 'Documentation - TypeScript 4.9',
      url: 'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html',
      snippet: expect.stringMatching(/^The satisfies Operator TypeScript developers are often faced with a dilemma/),
    });
    expect(results[5].title).toBe("What are the differences Between TypeScript's satisfies operator and ...");
    expect(results[7].title).toBe('new Typescript "satisfies" operator - Stack Overflow');
    for (const result of results) {
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.url).not.toMatch(/duckduckgo\.com/);
      expect(result.snippet).not.toMatch(/<|&#x27;|&amp;/);
    }
  });

  it('skips ads', () => {
    const ad = '<div class="result results_links results_links_deep result--ad "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;u3=x">Buy now</a></h2><a class="result__snippet" href="#">Sponsored</a></div>';
    const results = parseDuckDuckGoHtml(DDG_HTML.replace('<div id="links" class="results">', `<div id="links" class="results">${ad}`));
    expect(results.map((result) => result.title)).not.toContain('Buy now');
    expect(results.length).toBe(10);
  });
});

describe('DuckDuckGo redirect decoding', () => {
  it('unwraps the uddg parameter, entity-encoded or not', () => {
    expect(decodeDuckDuckGoLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&amp;rut=abc')).toBe('https://example.com/a?b=1&c=2');
    expect(decodeDuckDuckGoLink('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=abc')).toBe('https://example.com/');
  });

  it('drops ad links and non-http targets, and passes through direct links', () => {
    expect(decodeDuckDuckGoLink('https://duckduckgo.com/y.js?ad_domain=x')).toBeUndefined();
    expect(decodeDuckDuckGoLink('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeUndefined();
    expect(decodeDuckDuckGoLink('//duckduckgo.com/l/?rut=only')).toBeUndefined();
    expect(decodeDuckDuckGoLink('https://example.org/page')).toBe('https://example.org/page');
  });
});

describe('API response parsing', () => {
  it('Brave: strips highlight markup, decodes entities, skips entries without a URL', () => {
    expect(parseBraveJson(BRAVE_JSON)).toEqual([
      { title: 'The Borrow Checker - Rust Book', url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html', snippet: 'References and borrowing & lifetimes.' },
      { title: 'Understanding the borrow checker', url: 'https://blog.example.org/borrow', snippet: 'A walkthrough.' },
    ]);
    expect(parseBraveJson({})).toEqual([]);
    expect(parseBraveJson(null)).toEqual([]);
  });

  it('Tavily: maps content to the snippet with whitespace collapsed', () => {
    expect(parseTavilyJson(TAVILY_JSON)).toEqual([
      { title: 'References and Borrowing', url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html', snippet: 'A reference is like a pointer that is an address.' },
      { title: 'Borrow checker explained', url: 'https://blog.example.org/borrow', snippet: 'Explained.' },
    ]);
    expect(parseTavilyJson({ results: 'nope' })).toEqual([]);
  });
});

describe('key resolution', () => {
  it('environment beats the stored config, blanks are ignored', () => {
    expect(resolveSearchKeys({ BRAVE_SEARCH_API_KEY: 'env-brave' }, { braveApiKey: 'stored-brave', tavilyApiKey: 'stored-tavily' })).toEqual({ brave: 'env-brave', tavily: 'stored-tavily' });
    expect(resolveSearchKeys({ BRAVE_SEARCH_API_KEY: '  ', TAVILY_API_KEY: '' }, { braveApiKey: 42 })).toEqual({});
  });
});

describe('web_search tool', () => {
  it('asks like web_fetch, and "always" remembers the tool itself', () => {
    // The query leaves the machine; there is no domain to scope a rule to.
    expect(tool().class).toBe('network');
    const scope = { cwd: '/w', addDirs: [], homeDir: '/h', stateDir: '/s' } as unknown as Parameters<typeof suggestPermissionRule>[2];
    const rule = suggestPermissionRule(tool(), { query: 'node streams' }, scope);
    expect(rule).toBe('web_search');
    expect(decidePermission({
      tool: tool(), args: { query: 'x' }, mode: 'ask', planMode: false, scope, hasApprover: true,
      rules: parsePermissionRules([rule]), command: undefined,
    } as unknown as Parameters<typeof decidePermission>[0]).decision).toBe('allow');
    const decideIn = (mode: string) => decidePermission({
      tool: tool(), args: { query: 'x' }, mode, planMode: false, scope, hasApprover: true,
      rules: parsePermissionRules([]), command: undefined,
    } as unknown as Parameters<typeof decidePermission>[0]).decision;
    // The session's mode is the whole policy: only ask mode asks.
    expect(decideIn('ask')).toBe('ask');
    expect(decideIn('auto')).toBe('allow');
    expect(decideIn('bypass')).toBe('allow');
  });

  it('with no keys, searches DuckDuckGo and prints a compact numbered list', async () => {
    const net = fakeNet(ddgOk);
    const result = await tool().run({ query: 'typescript satisfies operator' }, context(net));
    expect(result.isError).toBeFalsy();
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url.toString()).toBe('https://html.duckduckgo.com/html/');
    expect(net.calls[0].options.method).toBe('POST');
    expect(net.calls[0].options.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(net.calls[0].options.body).toBe('q=typescript+satisfies+operator');
    expect(net.calls[0].options.headers['user-agent']).toBe('ClikCode/1');
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('Search results for "typescript satisfies operator" via DuckDuckGo:');
    expect(lines[1]).toBe('1. Documentation - TypeScript 4.9');
    expect(lines[2]).toBe('   https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html');
    // Default of 8 results even though the page holds 10.
    expect(result.output).toMatch(/\n8\. /);
    expect(result.output).not.toMatch(/\n9\. /);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(310);
  });

  it('honours max_results and caps it', async () => {
    const three = await tool().run({ query: 'q', max_results: 3 }, context(fakeNet(ddgOk)));
    expect(three.output).toMatch(/\n3\. /);
    expect(three.output).not.toMatch(/\n4\. /);

    const net = fakeNet(() => ({ status: 200, body: JSON.stringify(BRAVE_JSON) }));
    await tool({ BRAVE_SEARCH_API_KEY: 'k' }).run({ query: 'q', max_results: 500 }, context(net));
    expect(net.calls[0].url.searchParams.get('count')).toBe('20');
  });

  it('prefers Brave when its key is set, sending the key as a header', async () => {
    const net = fakeNet(() => ({ status: 200, body: JSON.stringify(BRAVE_JSON), headers: { 'content-type': 'application/json' } }));
    const result = await tool({ BRAVE_SEARCH_API_KEY: 'brave-key', TAVILY_API_KEY: 'tavily-key' }).run({ query: 'rust borrow checker', max_results: 5 }, context(net));
    expect(net.calls).toHaveLength(1);
    const { url, options } = net.calls[0];
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('rust borrow checker');
    expect(url.searchParams.get('count')).toBe('5');
    expect(options.headers['x-subscription-token']).toBe('brave-key');
    expect(url.toString()).not.toContain('brave-key');
    expect(result.output).toBe([
      'Search results for "rust borrow checker" via Brave Search:',
      '1. The Borrow Checker - Rust Book',
      '   https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html',
      '   References and borrowing & lifetimes.',
      '2. Understanding the borrow checker',
      '   https://blog.example.org/borrow',
      '   A walkthrough.',
    ].join('\n'));
  });

  it('uses Tavily when only its key is set (stored config), POSTing JSON with a bearer token', async () => {
    const net = fakeNet(() => ({ status: 200, body: JSON.stringify(TAVILY_JSON) }));
    const result = await tool({}, { tavilyApiKey: 'tavily-key' }).run({ query: 'rust borrow checker' }, context(net));
    expect(net.calls).toHaveLength(1);
    const { url, options } = net.calls[0];
    expect(url.toString()).toBe('https://api.tavily.com/search');
    expect(options.method).toBe('POST');
    expect(options.headers.authorization).toBe('Bearer tavily-key');
    expect(JSON.parse(options.body ?? '')).toEqual({ query: 'rust borrow checker', max_results: 8, search_depth: 'basic' });
    expect(result.output).toMatch(/^Search results for "rust borrow checker" via Tavily:\n1\. References and Borrowing\n/);
  });

  it('falls back from a failing keyed backend to the next, and says why', async () => {
    const net = fakeNet((url) => {
      if (url.hostname === 'api.search.brave.com') return { status: 401, body: '{"error":"invalid token"}' };
      if (url.hostname === 'api.tavily.com') return { status: 200, body: '<html>gateway error</html>' };
      return ddgOk(url);
    });
    const result = await tool({ BRAVE_SEARCH_API_KEY: 'bad', TAVILY_API_KEY: 'k' }).run({ query: 'q', max_results: 2 }, context(net));
    expect(result.isError).toBeFalsy();
    expect(net.calls.map((call) => call.url.hostname)).toEqual(['api.search.brave.com', 'api.tavily.com', 'html.duckduckgo.com']);
    expect(result.output).toMatch(/via DuckDuckGo:/);
    expect(result.output).toContain('(note: Brave Search returned HTTP 401 (the API key was rejected): {"error":"invalid token"}; fell back)');
    expect(result.output).toContain('(note: Tavily returned a response that is not JSON; fell back)');
  });

  it('reports every failure when all backends fail, naming the bot check', async () => {
    const net = fakeNet((url) => url.hostname === 'api.tavily.com'
      ? { status: 429, body: 'slow down' }
      : { status: 202, body: '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>' });
    const result = await tool({ TAVILY_API_KEY: 'k' }).run({ query: 'q' }, context(net));
    expect(result.isError).toBe(true);
    expect(result.output).toBe([
      'Web search failed.',
      '- Tavily returned HTTP 429 (rate limited or out of quota): slow down',
      '- DuckDuckGo answered with its bot check instead of results (it does this after a burst of searches, and the lockout can last minutes); search less often, or set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY',
    ].join('\n'));
  });

  it('flags a results page it cannot read instead of claiming there are no results', async () => {
    const broken = '<div class="result results_links web-result "><h2><a class="renamed" href="x">T</a></h2></div>';
    const result = await tool().run({ query: 'q' }, context(fakeNet(() => ({ status: 200, body: broken }))));
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/could not be read/);
  });

  it('keeps web_fetch network safety: a search host resolving to a private address is refused', async () => {
    const net = fakeNet(ddgOk, async () => [{ address: '10.0.0.5', family: 4 }]);
    const result = await tool().run({ query: 'q' }, context(net));
    expect(result.isError).toBe(true);
    expect(net.calls).toHaveLength(0);
    expect(result.output).toMatch(/DuckDuckGo failed: Refused: html\.duckduckgo\.com resolves to 10\.0\.0\.5/);
  });

  it('rejects an empty query without touching the network', async () => {
    const net = fakeNet(ddgOk);
    const result = await tool().run({ query: '   ' }, context(net));
    expect(result).toEqual({ output: 'The search query is empty.', isError: true });
    expect(net.calls).toHaveLength(0);
  });

  it('a cancelled turn throws instead of falling back', async () => {
    const controller = new AbortController();
    const net = fakeNet(() => { controller.abort(); throw new Error('aborted'); });
    await expect(tool({ BRAVE_SEARCH_API_KEY: 'k' }).run({ query: 'q' }, context(net, controller.signal))).rejects.toThrow();
    expect(net.calls).toHaveLength(1);
  });
});
