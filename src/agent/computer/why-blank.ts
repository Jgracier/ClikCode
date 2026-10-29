/** Why is this page stuck loading? Reloads it once while recording what the page asks for, then reports failed requests,
 * requests a blocker or a content-security-policy stopped, third-party scripts that never arrived, and console errors, so a
 * worker can write down the real cause (a blocked login script, a 403 from a config call) instead of retrying.
 * Bounded: one reload, at most `seconds` (default 12, up to 25) of waiting, at most 12 lines per kind. Addresses are shown without
 * query values; nothing from a request or response body is read. */
import type { Page, Request } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';
import { readConsole, watchConsole } from './console-log.js';
import { safeUrl } from './network-capture.js';

export type Problem = { kind: 'failed' | 'blocked' | 'status' | 'pending'; url: string; thirdParty: boolean; detail: string; type: string };

const MAX_LINES = 12;
const BLOCKED = /BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE|BLOCKED_BY_ORB|BLOCKED_BY_CSP|CORS|ERR_NETWORK_ACCESS_DENIED|ERR_INSECURE_PRIVATE/i;

/** Same registrable-ish site: the last two labels of the host. */
const siteOf = (host: string): string => host.split('.').slice(-2).join('.');
export function isThirdParty(pageUrl: string, requestUrl: string): boolean {
  try { return siteOf(new URL(pageUrl).hostname) !== siteOf(new URL(requestUrl).hostname); } catch { return false; }
}

export function describeProblems(pageUrl: string, problems: readonly Problem[], consoleText: string, waitedMs: number): string {
  const lines: string[] = [];
  const section = (title: string, kinds: Problem['kind'][], format: (p: Problem) => string): void => {
    const hit = problems.filter(p => kinds.includes(p.kind));
    if (!hit.length) return;
    lines.push(`${title} (${hit.length}):`, ...hit.slice(0, MAX_LINES).map(p => `- ${format(p)}`), ...(hit.length > MAX_LINES ? [`- ... ${hit.length - MAX_LINES} more`] : []));
  };
  section('Blocked requests (an ad/privacy blocker, CORS or the page\'s own security policy stopped them)', ['blocked'], p => `${p.type} ${p.url}${p.thirdParty ? ' [third party]' : ''}: ${p.detail}`);
  section('Failed requests (never got an answer)', ['failed'], p => `${p.type} ${p.url}${p.thirdParty ? ' [third party]' : ''}: ${p.detail}`);
  section('Answered with an error status', ['status'], p => `${p.type} ${p.url}${p.thirdParty ? ' [third party]' : ''}: HTTP ${p.detail}`);
  section(`Still waiting after ${Math.round(waitedMs / 1000)}s`, ['pending'], p => `${p.type} ${p.url}${p.thirdParty ? ' [third party]' : ''}`);
  if (consoleText && !/console is empty|No console messages match/.test(consoleText)) lines.push('', consoleText);
  if (!lines.length) return `Nothing failed on ${safeUrl(pageUrl)} while it loaded for ${Math.round(waitedMs / 1000)}s: no failed, blocked or error-status requests and no console errors. The page may be waiting on a script that never finishes (try wait with network_idle), on a cookie or sign-in state, or on a human check.`;
  const scripts = problems.filter(p => p.type === 'script' && p.thirdParty && p.kind !== 'status');
  const cause = scripts.length ? ` Likely cause: ${scripts.length} third-party script${scripts.length === 1 ? '' : 's'} (${[...new Set(scripts.map(p => { try { return new URL(p.url).hostname; } catch { return p.url; } }))].slice(0, 4).join(', ')}) did not load, so what depends on ${scripts.length === 1 ? 'it' : 'them'} (a sign-in button) never renders.` : '';
  return `Why ${safeUrl(pageUrl)} is blank or stuck (one reload, ${Math.round(waitedMs / 1000)}s watched):${cause}\n${lines.join('\n')}`;
}

export async function whyBlank(page: Page, options: { seconds?: number } = {}): Promise<string> {
  watchConsole(page);
  const budget = Math.min(Math.max(Math.round((options.seconds ?? 12) * 1000), 3_000), 25_000);
  const pageUrl = page.url();
  const problems: Problem[] = [];
  const open = new Map<Request, Problem>();
  const info = (request: Request): Omit<Problem, 'kind' | 'detail'> => ({ url: safeUrl(request.url()), thirdParty: isThirdParty(pageUrl, request.url()), type: request.resourceType() });
  const onRequest = (request: Request): void => { if (!/^data:|^blob:/.test(request.url())) open.set(request, { ...info(request), kind: 'pending', detail: '' }); };
  const onFailed = (request: Request): void => {
    open.delete(request);
    const failure = request.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED/.test(failure)) return; // the page itself cancelled it
    problems.push({ ...info(request), kind: BLOCKED.test(failure) ? 'blocked' : 'failed', detail: failure });
  };
  const onFinished = (request: Request): void => {
    open.delete(request);
    void request.response().then(response => { if (response && response.status() >= 400) problems.push({ ...info(request), kind: 'status', detail: String(response.status()) }); }, quiet('agent/computer/why-blank'));
  };
  page.on('request', onRequest); page.on('requestfailed', onFailed); page.on('requestfinished', onFinished);
  const started = Date.now();
  try {
    await page.reload({ waitUntil: 'commit', timeout: Math.min(budget, 15_000) }).catch(quiet('agent/computer/why-blank'));
    await page.waitForLoadState('networkidle', { timeout: budget }).catch(quiet('agent/computer/why-blank'));
    await new Promise(resolve => setTimeout(resolve, 300)); // late response callbacks
  } finally {
    page.off('request', onRequest); page.off('requestfailed', onFailed); page.off('requestfinished', onFinished);
  }
  const waited = Date.now() - started;
  problems.push(...open.values());
  const consoleText = await readConsole(page, { level: 'error', limit: 15 }).catch(() => '');
  return describeProblems(pageUrl, problems, consoleText, waited);
}
