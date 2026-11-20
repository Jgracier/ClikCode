/** The browser side of the reference search (connector-reference.ts): each page opens in the vendor's own named
 * tab of ClikCode's browser, and every data file it loads is kept for the search to read. */
import type { Page } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';
import { searchReference, worthReading, type ReferencePorts, type ReferenceSearch } from './connector-reference.js';

const MAX_FILE = 12_000_000;
const PAGE_MS = 15_000;

const READ = `(() => {
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 600).map(a => ({ href: a.href, text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) })).filter(l => l.text || /openapi|swagger|postman/i.test(l.href));
  const readme = !!document.querySelector('meta[name="readme-deploy"], meta[name="readme-version"]') || Array.from(document.scripts).some(s => /cdn\\.readme\\.io|readme-deploy/.test(s.src));
  // Docs sites that draw themselves (ReadMe, Mintlify, Next-based portals) carry the API description inside the
  // page's own data: every such block is searched for a document that says it is OpenAPI or Swagger and has paths.
  let best = null, bestPaths = 0, visits = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 9 || ++visits > 150000) return;
    if (!Array.isArray(node) && (typeof node.openapi === 'string' || typeof node.swagger === 'string') && node.paths && typeof node.paths === 'object') {
      const count = Object.keys(node.paths).length;
      if (count > bestPaths) { best = node; bestPaths = count; }
      return;
    }
    const keys = Array.isArray(node) ? node.length : Object.keys(node);
    if (Array.isArray(node)) { for (let i = 0; i < Math.min(keys, 300); i++) walk(node[i], depth + 1); }
    else for (const key of keys.slice(0, 300)) walk(node[key], depth + 1);
  };
  const blocks = [];
  const props = document.querySelector('#ssr-props');
  if (props && props.getAttribute('data-initial-props')) blocks.push(props.getAttribute('data-initial-props'));
  for (const script of Array.from(document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__')).slice(0, 8)) if (script.textContent && script.textContent.length < 12000000) blocks.push(script.textContent);
  for (const block of blocks) { try { walk(JSON.parse(block), 0); } catch (e) {} }
  let embedded = null;
  if (best) { try { embedded = JSON.stringify(best); if (embedded.length > 12000000) embedded = null; } catch (e) {} }
  return { text: ((document.body && document.body.innerText) || '').slice(0, 200000), links, readme, embedded };
})()`;

export const referenceTab = (id: string): string => `ref-${id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

export function referencePorts(page: Page): ReferencePorts {
  return {
    now: Date.now,
    // A page that never settles (an endless stream, a script that will not yield) is given up on, not waited for.
    open: url => Promise.race([openPage(url), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), PAGE_MS + 20_000))]),
    async fetch(url) {
      const response = await page.request.get(url, { timeout: 12_000, maxRedirects: 4 }).catch(quiet('agent/computer/connector-reference-live'));
      if (!response?.ok()) return undefined;
      const text = await response.text().catch(() => '');
      return text.length > 200 && text.length <= MAX_FILE ? text : undefined;
    },
  };
  async function openPage(url: string): ReturnType<ReferencePorts['open']> {
    {
      const loaded: Array<{ url: string; text: string }> = [];
      const pending: Array<Promise<void>> = [];
      const onResponse = (response: { url(): string; status(): number; headers(): Record<string, string>; text(): Promise<string> }): void => {
        if (loaded.length >= 40 || response.status() !== 200 || !worthReading(response.url(), response.headers()['content-type'] ?? '')) return;
        const size = Number(response.headers()['content-length'] ?? 0);
        if (size > MAX_FILE) return;
        pending.push(response.text().then(text => { if (text.length <= MAX_FILE && text.length > 200) loaded.push({ url: response.url(), text }); }).catch(quiet('agent/computer/connector-reference-live')));
      };
      page.on('response', onResponse);
      try {
        const response = await page.goto(url, { timeout: PAGE_MS, waitUntil: 'domcontentloaded' }).catch(() => null);
        if (!response || response.status() >= 400) return { url, ok: false, text: '', links: [], readme: false, loaded: [] };
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(quiet('agent/computer/connector-reference-live'));
        await page.waitForTimeout(600).catch(quiet('agent/computer/connector-reference-live'));
        await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, 4_000))]);
        const read = await Promise.race([page.evaluate(READ), new Promise((_, reject) => setTimeout(() => reject(new Error('slow page')), 8_000))]).catch(() => ({ text: '', links: [], readme: false, embedded: null })) as { text: string; links: Array<{ href: string; text: string }>; readme: boolean; embedded: string | null };
        const here = page.url() || url;
        // The description inside the page's own data comes first: it is the one this vendor's docs are drawn from.
        return { url: here, ok: true, text: read.text, links: read.links, readme: read.readme, loaded: [...(read.embedded ? [{ url: here, text: read.embedded }] : []), ...loaded] };
      } finally { page.off('response', onResponse); }
    }
  }
}

/** Search one vendor's site for its API reference in a tab of its own. Never throws. */
export async function findReferenceRendered(stateDir: string, id: string, homepage: string, budgetMs = 100_000): Promise<ReferenceSearch> {
  const { openComputerPage, closeComputerPage } = await import('./browser.js');
  const tab = referenceTab(id);
  try {
    const page = await openComputerPage(stateDir, tab);
    return await Promise.race([searchReference(homepage, referencePorts(page), budgetMs), new Promise<ReferenceSearch>(resolve => setTimeout(() => resolve({ docsUrls: [], visited: [] }), budgetMs + 45_000))]);
  } catch (error) {
    quiet('agent/computer/connector-reference-live')(error instanceof Error ? error.message : String(error));
    return { docsUrls: [], visited: [] };
  } finally { await Promise.race([closeComputerPage(stateDir, tab).catch(quiet('agent/computer/connector-reference-live')), new Promise(resolve => setTimeout(resolve, 8_000))]); }
}
