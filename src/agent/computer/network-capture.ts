/** Records the API calls a page makes while something happens on it (a click, a form submit), so an agent can read
 * the real endpoints, methods and answer shapes a vendor's own web app uses when its docs are thin. What it keeps is
 * built to be safe to show: header NAMES only (never values), query parameter names only, and bodies only when
 * asked for, truncated and with anything key-shaped hidden. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Page, Request } from 'playwright-core';
import { hideKeyLikeText } from './secret-finder.js';
import { scrubSecrets } from './secret-scrubber.js';

export type NetworkCall = {
  method: string; url: string; status?: number; type: string;
  requestHeaders: string[]; contentType?: string; body?: string; answer?: string; jsonShape?: string;
};

const KINDS = new Set(['xhr', 'fetch']);
const MAX_CALLS = 60;
const MAX_BODY = 1500;

/** The address with query values dropped: the parameter names show the call's shape, the values may be tokens. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const names = [...new Set([...u.searchParams.keys()])];
    return `${u.origin}${u.pathname}${names.length ? `?${names.map(name => `${name}=…`).join('&')}` : ''}`;
  } catch { return raw.slice(0, 200); }
}

/** The keys of a JSON answer (arrays as `[…]`), a few levels down: the answer's shape without its data. */
export function jsonShape(value: unknown, depth = 3): string {
  if (Array.isArray(value)) return value.length ? `[${depth > 0 ? jsonShape(value[0], depth - 1) : '…'}]` : '[]';
  if (value && typeof value === 'object') {
    if (depth <= 0) return '{…}';
    return `{${Object.entries(value as Record<string, unknown>).slice(0, 25).map(([key, inner]) => `${key}: ${jsonShape(inner, depth - 1)}`).join(', ')}}`;
  }
  return value === null ? 'null' : typeof value;
}

const clip = (text: string): string => hideKeyLikeText(scrubSecrets(text.slice(0, MAX_BODY))).text;

export async function recordNetwork<T>(page: Page, run: () => Promise<T>, options: { find?: string; bodies?: boolean; quietMs?: number } = {}): Promise<{ result: T; calls: NetworkCall[]; dropped: number }> {
  const calls: NetworkCall[] = [];
  const pending: Promise<void>[] = [];
  let dropped = 0;
  const onRequest = (request: Request): void => {
    if (!KINDS.has(request.resourceType())) return;
    const url = request.url();
    if (options.find && !url.toLowerCase().includes(options.find.toLowerCase())) return;
    if (calls.length >= MAX_CALLS) { dropped++; return; }
    const call: NetworkCall = { method: request.method(), url: safeUrl(url), type: request.resourceType(), requestHeaders: Object.keys(request.headers()).sort() };
    calls.push(call);
    if (options.bodies) { const body = request.postData(); if (body) call.body = clip(body); }
    pending.push((async () => {
      const response = await request.response().catch(() => null);
      if (!response) return;
      call.status = response.status();
      call.contentType = response.headers()['content-type']?.split(';')[0];
      if (call.contentType?.includes('json')) {
        const parsed = await response.json().catch(quiet('agent/computer/network-capture'));
        if (parsed !== undefined) { call.jsonShape = jsonShape(parsed); if (options.bodies) call.answer = clip(JSON.stringify(parsed)); }
      }
    })());
  };
  page.on('request', onRequest);
  try {
    const result = await run();
    // Answers that arrive just after the last step still count.
    await page.waitForTimeout(options.quietMs ?? 800);
    await Promise.allSettled(pending);
    return { result, calls, dropped };
  } finally { page.off('request', onRequest); }
}

export function describeCalls(calls: readonly NetworkCall[], dropped = 0): string {
  if (!calls.length) return 'No API calls (xhr/fetch) were made.';
  return [`${calls.length} API call${calls.length === 1 ? '' : 's'}${dropped ? ` (${dropped} more not shown)` : ''}:`, ...calls.map(call => `${call.method} ${call.url} → ${call.status ?? '?'}${call.contentType ? ` ${call.contentType}` : ''}${call.jsonShape ? `\n    answer: ${call.jsonShape}` : ''}${call.body ? `\n    sent: ${call.body}` : ''}${call.answer ? `\n    body: ${call.answer}` : ''}\n    header names: ${call.requestHeaders.join(', ')}`)].join('\n');
}
