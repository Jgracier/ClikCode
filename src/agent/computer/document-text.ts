/** When a tab shows a document rather than a web page (a PDF, plain text, JSON, XML, CSV, an image), the page's
 * accessibility tree is empty or useless. The document is fetched again through the browser's own request context
 * (same cookies, so a PDF behind a sign-in works) and read: a PDF as text with page markers, capped, a text-like
 * document as its text. The PDF reader is pdf.js, through the `unpdf` package, loaded only when a PDF is opened. */
import type { Page } from 'playwright-core';
import { hideKeyLikeText } from './secret-finder.js';
import { scrubSecrets } from './secret-scrubber.js';
import { sharedState } from './shared-state.js';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 30_000;

type Cached = { url: string; kind: 'pdf'; pages: string[]; total: number } | { url: string; kind: 'text'; text: string } | { url: string; kind: 'other'; note: string };
const cache = sharedState('page-document-text', () => new WeakMap<Page, Cached>());
const requested = sharedState('page-document-pages', () => new WeakMap<Page, string>());

/** The pages the agent asked for with `observe`'s `pages` ("3", "2-5", "1,4-6"), for the next view of this tab. */
export function requestDocumentPages(page: Page, pages: string | undefined): void { if (pages) requested.set(page, pages); else requested.delete(page); }

/** "3" / "2-5" / "1,4-6" as page numbers, within 1..total. Undefined for nothing usable. */
export function parsePageRange(spec: string, total: number): number[] | undefined {
  const wanted = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) return undefined;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let number = Math.max(1, from); number <= Math.min(total, to) && wanted.size < 500; number++) wanted.add(number);
  }
  return wanted.size ? [...wanted].sort((a, b) => a - b) : undefined;
}

/** The text of a PDF, one string per page. */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  let unpdf: typeof import('unpdf');
  try { unpdf = await import('unpdf'); }
  catch { throw new Error('Reading a PDF needs the unpdf package, which is not installed. Reinstall ClikCode, or download the file and read it with another tool.'); }
  const pdf = await unpdf.getDocumentProxy(bytes);
  const { text } = await unpdf.extractText(pdf, { mergePages: false });
  return text.map(page => page.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
}

/** The pages to show: those asked for, else from the first until the cap is reached. */
export function renderPdf(pages: readonly string[], spec: string | undefined, cap = MAX_DOCUMENT_CHARS): string {
  const total = pages.length;
  const chosen = (spec ? parsePageRange(spec, total) : undefined) ?? pages.map((_page, index) => index + 1);
  const out: string[] = [];
  let used = 0;
  let last = 0;
  for (const number of chosen) {
    const body = pages[number - 1] ?? '';
    const block = `--- page ${number} of ${total} ---\n${body || '(no text on this page: it may be a scan or an image)'}`;
    if (used + block.length > cap && out.length) break;
    out.push(used + block.length > cap ? `${block.slice(0, cap - used)}\n(… page cut at the size limit)` : block);
    used += block.length;
    last = number;
  }
  const rest = chosen.filter(number => number > last);
  if (rest.length) out.push(`(… ${rest.length} more page${rest.length === 1 ? '' : 's'}: observe with pages: "${rest[0]}-${Math.min(total, rest[0]! + 9)}" to read on)`);
  if (!pages.some(page => page.trim())) out.push('This PDF has no text layer (a scan). Take a screenshot to read it.');
  return out.join('\n\n');
}

const TEXTLIKE = /^(?:text\/[\w.+-]+|application\/(?:json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-ndjson|yaml|x-yaml|csv))$/i;

/** The content type of the document in the tab, or undefined for an ordinary web page. */
export async function documentType(page: Page): Promise<string | undefined> {
  let type: string;
  try { type = String(await page.evaluate(() => (globalThis as unknown as { document: { contentType: string } }).document.contentType)).split(';')[0]!.trim().toLowerCase(); }
  catch { return undefined; }
  if (!type || type === 'text/html' || type === 'application/xhtml+xml') return undefined;
  return type;
}

async function load(page: Page, type: string): Promise<Cached> {
  const url = page.url();
  if (type.startsWith('image/')) return { url, kind: 'other', note: `This tab shows an image (${type}). Take a screenshot to see it.` };
  const isPdf = type === 'application/pdf';
  if (!isPdf && !TEXTLIKE.test(type)) return { url, kind: 'other', note: `This tab shows a ${type} document, which cannot be read as a page.` };
  if (!/^https?:/i.test(url)) return { url, kind: 'other', note: `This ${type} document (${url.slice(0, 40)}…) cannot be fetched for reading.` };
  const response = await page.context().request.get(url, { timeout: 30_000, maxRedirects: 5 });
  if (!response.ok()) throw new Error(`The document could not be fetched again to be read (HTTP ${response.status()}).`);
  const declared = Number(response.headers()['content-length']);
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) throw new Error(`The document is ${(declared / 1024 / 1024).toFixed(0)} MB, over the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit for reading it.`);
  const body = await response.body();
  if (body.length > MAX_DOCUMENT_BYTES) throw new Error(`The document is over the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit for reading it.`);
  if (isPdf) {
    const pages = await pdfPages(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return { url, kind: 'pdf', pages, total: pages.length };
  }
  return { url, kind: 'text', text: body.toString('utf8') };
}

/** What a document tab holds, as text for the agent; undefined when the tab is an ordinary web page. */
export async function documentView(page: Page): Promise<string | undefined> {
  const type = await documentType(page);
  if (!type) return undefined;
  let found = cache.get(page);
  if (!found || found.url !== page.url()) {
    try { found = await load(page, type); }
    catch (error) { return `This tab shows a ${type} document that could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; }
    cache.set(page, found);
  }
  const wanted = requested.get(page);
  requested.delete(page);
  const body = found.kind === 'pdf' ? renderPdf(found.pages, wanted)
    : found.kind === 'text' ? (found.text.length > MAX_DOCUMENT_CHARS ? `${found.text.slice(0, MAX_DOCUMENT_CHARS)}\n(… ${found.text.length - MAX_DOCUMENT_CHARS} more characters cut)` : found.text)
      : found.note;
  const shown = hideKeyLikeText(scrubSecrets(body));
  const kind = found.kind === 'pdf' ? `PDF, ${found.total} page${found.total === 1 ? '' : 's'}` : type;
  return `Document (${kind}): ${page.url().replace(/[?#].*$/, '')}\n\n${shown.text}${shown.hidden ? `\n\n[${shown.hidden} key-like value${shown.hidden === 1 ? '' : 's'} hidden.]` : ''}`;
}
