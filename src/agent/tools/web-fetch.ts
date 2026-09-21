/** HTTP(S) fetch with SSRF protection. The hostname is resolved ONCE, every
 * answer is vetted, and the request is then pinned to a vetted address, so a
 * rebinding DNS server cannot swap in a private address between the check and
 * the connection. Redirects are followed manually and re-vetted each hop. */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { OUTPUT_CAPS } from '../security.js';
import { defineTool, turnCancelledError, type NetworkSeams, type PinnedResponse, type ResolvedAddress } from '../types.js';

interface WebFetchArgs { url: string; raw?: boolean }

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function ipv4IsPrivate([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)          // CGNAT (incl. Tailscale)
    || (a === 169 && b === 254)                    // link-local / cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;                                   // multicast, reserved, broadcast
}

function expandIpv6(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return undefined;
    text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((group) => /^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN);
  return groups.length === 8 && groups.every((group) => !Number.isNaN(group)) ? groups : undefined;
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation,
 * unspecified and any IPv6 form that embeds such an IPv4 address. Anything
 * unparseable is treated as private: fail closed. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4IsPrivate(v4);
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [g0, g1, , , , g5, g6, g7] = groups;
  const embedded = (hi: number, lo: number): boolean => ipv4IsPrivate([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (groups.slice(0, 5).every((group) => group === 0) && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;      // :: and ::1
    return embedded(g6, g7);                                              // ::ffff:a.b.c.d and ::a.b.c.d
  }
  if (g0 === 0x64 && g1 === 0xff9b) return embedded(g6, g7);              // NAT64
  if (g0 === 0x2002) return embedded(g1, groups[2]);                      // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true;                              // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true;                              // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true;                              // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true;                              // multicast
  if (g0 === 0x2001 && g1 === 0xdb8) return true;                         // documentation
  return false;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
}

function defaultRequest(url: URL, pinned: ResolvedAddress, options: { signal?: AbortSignal; headers: Record<string, string> }): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET', headers: options.headers, signal: options.signal,
      // Pin the socket to the vetted address; TLS still verifies the hostname.
      lookup: (_hostname, lookupOptions, callback) => {
        const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null && (lookupOptions as { all?: boolean }).all === true;
        if (wantsAll) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: pinned.address, family: pinned.family }]);
        else (callback as unknown as (error: null, address: string, family: number) => void)(null, pinned.address, pinned.family);
      },
    }, (response) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      resolve({ status: response.statusCode ?? 0, headers, body: response });
    });
    request.once('error', reject);
    request.end();
  });
}

export async function vetUrl(raw: string, seams: NetworkSeams = {}): Promise<{ url: URL; pinned: ResolvedAddress }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not fetched');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || /^localhost$/i.test(hostname) || /\.(?:localhost|local|internal)$/i.test(hostname)) throw new Error(`Refused: ${hostname || 'empty host'} is a local hostname`);
  const literal = net.isIP(hostname);
  const answers: ResolvedAddress[] = literal
    ? [{ address: hostname, family: literal === 6 ? 6 : 4 }]
    : await (seams.lookup ?? defaultLookup)(hostname);
  if (!answers.length) throw new Error(`Could not resolve ${hostname}`);
  // Every answer must be public: a host with one public and one private A
  // record is a rebinding setup, not a partially safe one.
  const blocked = answers.find((answer) => isPrivateAddress(answer.address));
  if (blocked) throw new Error(`Refused: ${hostname} resolves to ${blocked.address}, a private, loopback or link-local address`);
  return { url, pinned: answers[0] };
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, body: string) => /^(?:#|javascript:)/i.test(href) ? body : `${body} (${href})`)
    .replace(/<(?:h[1-6])\b[^>]*>/gi, '\n\n# ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:p|div|section|article|header|footer|main|nav|aside|br|tr|table|ul|ol|pre|blockquote|h[1-6]|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    try { return Number.isFinite(point) ? String.fromCodePoint(point) : match; } catch { return match; }
  });
  text = text.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return title ? `Title: ${title.replace(/\s+/g, ' ')}\n\n${text}` : text;
}

export const webFetchTool = defineTool<WebFetchArgs>({
  name: 'web_fetch',
  class: 'network',
  description: 'Fetch a public http(s) URL and return its content as text (HTML is reduced to readable text; set raw to keep markup). Private, loopback and link-local addresses are blocked. 10 MB and 30 s limits.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: { url: { type: 'string', description: 'Absolute http:// or https:// URL.' }, raw: { type: 'boolean', description: 'Return the body unmodified.' } },
  },
  label: (args) => `Fetch ${args.url}`,
  async run(args, ctx) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
    const onAbort = (): void => timeout.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let target = args.url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const { url, pinned } = await vetUrl(target, ctx.net);
        const response = await (ctx.net?.request ?? defaultRequest)(url, pinned, {
          signal: timeout.signal,
          headers: { 'user-agent': 'ClikCode/1 (+https://clikdeploy.com)', accept: 'text/html,text/plain,application/json,*/*;q=0.5', 'accept-encoding': 'identity' },
        });
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          for await (const _chunk of response.body) { /* drain */ }
          target = new URL(response.headers.location, url).toString();
          continue;
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let truncated = false;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > OUTPUT_CAPS.webFetchBytes) { truncated = true; timeout.abort(); break; }
          chunks.push(chunk);
        }
        const contentType = response.headers['content-type'] ?? '';
        if (!/^(?:text\/|application\/(?:json|xml|xhtml|javascript|x-ndjson|.*\+(?:json|xml)))/i.test(contentType) && contentType) {
          return { output: `${url} returned ${contentType} (${bytes} bytes), which is not text.`, isError: response.status >= 400 };
        }
        const body = Buffer.concat(chunks).toString('utf8');
        let text = !args.raw && /html/i.test(contentType) ? htmlToText(body) : body;
        if (text.length > OUTPUT_CAPS.webFetchTextChars) text = `${text.slice(0, OUTPUT_CAPS.webFetchTextChars)}\n\n… [${text.length - OUTPUT_CAPS.webFetchTextChars} more characters not shown]`;
        const header = `${url} → HTTP ${response.status}${truncated ? ' [body exceeded 10 MB; truncated]' : ''}`;
        return { output: `${header}\n\n${text || '(empty body)'}`, isError: response.status >= 400 };
      }
      return { output: `Too many redirects (more than ${MAX_REDIRECTS}).`, isError: true };
    } catch (error) {
      if (ctx.signal?.aborted) throw turnCancelledError();
      if (timeout.signal.aborted) return { output: `Timed out after ${TIMEOUT_MS / 1000}s fetching ${args.url}.`, isError: true };
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  },
});
