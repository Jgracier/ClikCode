/** `clikcode computer page read|fetch`: render one page in ClikCode's browser, in a named tab and through a chosen egress, and report what
 * a script needs from it as data: the final address and status, the value of an expression evaluated in the page, the data files the
 * page loaded (JSON, YAML, plain text) and whether a human check stands in the way. `fetch` gets one address with the browser's own
 * request context (its cookies and egress). Nothing is clicked or typed. */
import type { Page } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';

export interface PageReadOptions {
  tab: string; egress?: string;
  /** A JavaScript expression evaluated in the page once it settled; its JSON value is `result`. */ evaluate?: string;
  /** Keep the bodies of loaded responses whose `<url> <content-type>` matches this pattern (default: none). */ collect?: RegExp;
  /** Most bytes one collected file may have (default 12 MB); at most 40 files. */ maxFileBytes?: number;
  timeoutMs?: number;
  /** Report whether a human check (a captcha) is in the way. */ humanCheck?: boolean;
}
export interface PageRead { url: string; ok: boolean; status?: number; result?: unknown; loaded: Array<{ url: string; text: string }>; humanCheck?: boolean; error?: string }

async function tabPage(stateDir: string, tab: string, egress?: string): Promise<Page> {
  const browser = await import('./browser.js');
  if (egress) await browser.bindTabEgress(stateDir, tab, egress);
  return browser.openComputerPage(stateDir, tab);
}

export async function readPage(stateDir: string, url: string, options: PageReadOptions): Promise<PageRead> {
  if (!/^https?:\/\//i.test(url)) throw new Error('page read takes an http(s) address.');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxFile = options.maxFileBytes ?? 12_000_000;
  const page = await tabPage(stateDir, options.tab, options.egress);
  const loaded: Array<{ url: string; text: string }> = [];
  const pending: Array<Promise<void>> = [];
  const onResponse = (response: { url(): string; status(): number; headers(): Record<string, string>; text(): Promise<string> }): void => {
    if (!options.collect || loaded.length >= 40 || response.status() !== 200) return;
    const type = response.headers()['content-type'] ?? '';
    if (!options.collect.test(`${response.url()} ${type}`)) return;
    if (Number(response.headers()['content-length'] ?? 0) > maxFile) return;
    pending.push(response.text().then(text => { if (text.length <= maxFile && text.length > 0) loaded.push({ url: response.url(), text }); }).catch(quiet('agent/computer/page-read')));
  };
  page.on('response', onResponse);
  try {
    let status: number | undefined;
    try {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      status = response?.status();
    } catch (error) { return { url, ok: false, loaded: [], error: String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200) }; }
    await page.waitForLoadState('networkidle', { timeout: Math.min(6_000, timeoutMs) }).catch(quiet('agent/computer/page-read'));
    await page.waitForTimeout(700).catch(quiet('agent/computer/page-read'));
    await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, 4_000))]);
    let result: unknown;
    let error: string | undefined;
    if (options.evaluate) {
      result = await Promise.race([page.evaluate(options.evaluate), new Promise((_, reject) => setTimeout(() => reject(new Error('the expression did not finish in 8s')), 8_000))])
        .catch((e: unknown) => { error = String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 200); return undefined; });
    }
    const check = options.humanCheck ? !!(await (await import('./human-check.js')).detectHumanCheck(page).catch(quiet('agent/computer/page-read'))) : undefined;
    return { url: page.url() || url, ok: status === undefined || status < 400, ...(status !== undefined ? { status } : {}), ...(options.evaluate ? { result } : {}), loaded: [...loaded], ...(check !== undefined ? { humanCheck: check } : {}), ...(error ? { error } : {}) };
  } finally { page.off('response', onResponse); }
}

/** One address fetched with the browser's request context. Text bodies only, at most `maxBytes`. */
export async function fetchInBrowser(stateDir: string, url: string, options: { tab: string; egress?: string; maxBytes?: number; timeoutMs?: number }): Promise<{ ok: boolean; status?: number; contentType?: string; text?: string; error?: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('page fetch takes an http(s) address.');
  const page = await tabPage(stateDir, options.tab, options.egress);
  try {
    const response = await page.request.get(url, { timeout: options.timeoutMs ?? 12_000, maxRedirects: 4 });
    const text = await response.text().catch(() => '');
    const max = options.maxBytes ?? 12_000_000;
    return { ok: response.ok(), status: response.status(), contentType: response.headers()['content-type'] ?? '', ...(text.length <= max ? { text } : { error: `the body is larger than ${max} characters` }) };
  } catch (error) { return { ok: false, error: String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200) }; }
}
