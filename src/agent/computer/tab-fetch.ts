/** One request made "as the tab": through the tab's own way out (egress.ts) and with the cookies of the context it lives in.
 *
 * Playwright's request clients (`page.request`, `context.request`) run in this Node process, not in Chrome: they leave through this
 * computer's own connection whatever proxy the tab has, and a page the browser host opened in an egress context (egress-host.ts) is filed
 * under the shared profile's context, so they also carry the shared profile's cookies. For a tab on an egress that leaks the home address
 * and the home sign-ins to the very site the egress hides them from. So for such a tab the request is made by Chrome itself:
 *
 * 1. `Network.loadNetworkResource` over a CDP session on the tab (what DevTools uses to load a source map): Chrome's own network stack for
 *    that frame, so the context's proxy and cookies, and no CORS check.
 * 2. Failing that, `fetch` evaluated in the frame (the challenge frame for a captcha clip, else the page), with its credentials.
 *
 * Neither way working is an error: the request is never made from this process for an egress tab. A tab on home (and the cloud browser,
 * whose requests Playwright already sends through that browser) keeps the context's request client. */
import type { Frame, Page } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';
import { egressOfPage } from './egress.js';

export interface TabFetchOptions {
  timeoutMs?: number;
  /** Bodies larger than this are refused (default 50 MB). */ maxBytes?: number;
  /** The frame whose origin the request is made from in the in-page fallback (default: the page's main frame). */ frame?: Frame;
}
export interface TabFetch { ok: boolean; status: number; contentType: string; body: Buffer }

const DEFAULT_MAX = 50 * 1024 * 1024;

/** The body is over `maxBytes`. */
export class TooLarge extends Error {}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(ms / 1000)}s.`)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** What the CDP fetch needs of a session. */
interface Cdp { send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }

async function viaCdp(page: Page, url: string, max: number): Promise<TabFetch> {
  const session = await page.context().newCDPSession(page) as unknown as Cdp;
  try {
    const tree = await session.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId) throw new Error('The tab has no frame to load from.');
    const { resource } = await session.send('Network.loadNetworkResource', { frameId, url, options: { disableCache: false, includeCredentials: true } }) as
      { resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> } };
    const status = resource.httpStatusCode ?? 0;
    if (!resource.success && !status) throw new Error(`Chrome could not load it${resource.netErrorName ? ` (${resource.netErrorName})` : ''}.`);
    const headers = Object.fromEntries(Object.entries(resource.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    if (Number(headers['content-length']) > max) throw new TooLarge(`The body is over ${max} bytes.`);
    const chunks: Buffer[] = [];
    let size = 0;
    if (resource.stream) {
      try {
        for (;;) {
          const read = await session.send('IO.read', { handle: resource.stream, size: 1 << 20 }) as { data: string; base64Encoded?: boolean; eof: boolean };
          const chunk = Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8');
          size += chunk.length;
          if (size > max) throw new TooLarge(`The body is over ${max} bytes.`);
          chunks.push(chunk);
          if (read.eof) break;
        }
      } finally { await session.send('IO.close', { handle: resource.stream }).catch(quiet('agent/computer/tab-fetch')); }
    }
    return { ok: status >= 200 && status < 300, status, contentType: headers['content-type'] ?? '', body: Buffer.concat(chunks) };
  } finally { await session.detach().catch(quiet('agent/computer/tab-fetch')); }
}

async function viaFrame(frame: Frame, url: string, max: number): Promise<TabFetch> {
  const got = await frame.evaluate(async ({ url, max }: { url: string; max: number }) => {
    const reply = await fetch(url, { credentials: 'include' });
    const bytes = new Uint8Array(await reply.arrayBuffer());
    if (bytes.length > max) return { status: reply.status, type: reply.headers.get('content-type') ?? '', data: '', large: true };
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return { status: reply.status, type: reply.headers.get('content-type') ?? '', data: btoa(text), large: false };
  }, { url, max });
  if (got.large) throw new TooLarge(`The body is over ${max} bytes.`);
  return { ok: got.status >= 200 && got.status < 300, status: got.status, contentType: got.type, body: Buffer.from(got.data, 'base64') };
}

/** GET `url` as the tab `page` would: through its egress and with its context's cookies. Throws when it cannot be had that way. */
export async function fetchAsTab(page: Page, url: string, options: TabFetchOptions = {}): Promise<TabFetch> {
  const ms = options.timeoutMs ?? 15_000;
  const max = options.maxBytes ?? DEFAULT_MAX;
  if (!egressOfPage(page)) {
    const response = await page.context().request.get(url, { timeout: ms, maxRedirects: 5 });
    const headers = response.headers();
    if (Number(headers['content-length']) > max) throw new TooLarge(`The body is over ${max} bytes.`);
    const body = await response.body();
    if (body.length > max) throw new TooLarge(`The body is over ${max} bytes.`);
    return { ok: response.ok(), status: response.status(), contentType: headers['content-type'] ?? '', body };
  }
  let first: unknown;
  try { return await within(viaCdp(page, url, max), ms, 'The request'); }
  catch (error) { if (error instanceof TooLarge) throw error; first = error; }
  try { return await within(viaFrame(options.frame ?? page.mainFrame(), url, max), ms, 'The request'); }
  catch (error) {
    if (error instanceof TooLarge) throw error;
    const say = (value: unknown): string => (value instanceof Error ? value.message : String(value)).split('\n')[0]!.slice(0, 160);
    throw new Error(`The tab could not fetch ${url.slice(0, 120)} through its egress (${say(first)}; in the page: ${say(error)}).`);
  }
}
