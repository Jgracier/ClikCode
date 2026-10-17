/** Finds a freshly created API key on the page without a person: the key the
 * site's own request returned, and any new key-looking text that appeared on
 * the page since just before the click. The decision is a score, and it only
 * answers when one candidate clearly leads. Values stay in the worker. */
import type { Page } from 'playwright-core';

export type Found = { value: string; keyName?: string };
export type Decision = { kind: 'found'; value: string } | { kind: 'none' } | { kind: 'ambiguous' };

/** Field names that mean "this is the credential", not just any token (a CSRF token is not). */
const STRONG_KEY = /api.?key|secret|access.?token|private.?key|auth.?token|bearer|credential/i;
const PREFIXED = /^(?:[a-z]{2,12}(?:_[a-z]+)*_[A-Za-z0-9]{12,}|sk-|ghp_|github_pat_|AKIA|AIza|xox[abp]-|eyJ)/;
const WORTH_SAVING_HINT = /\bcopy\b|won'?t be (?:shown|displayed|visible)|only (?:once|time)|(?:save|store) (?:this|it|your)|make sure to (?:copy|save)|never (?:be )?shown again/i;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Long, unbroken, mixed text with a digit: shaped like a key, not a word, URL or email. */
export function keyShaped(value: string): boolean {
  if (value.length < 16 || value.length > 512 || !/^[A-Za-z0-9_\-+/=.:~]+$/.test(value)) return false;
  if (/^https?:|@/.test(value) || !/\d/.test(value) || /^\d+$/.test(value)) return false;
  return entropy(value) >= 3;
}

function walk(node: unknown, key: string | undefined, out: Found[], depth = 0): void {
  if (depth > 6 || out.length > 200) return;
  if (typeof node === 'string') { if (keyShaped(node)) out.push({ value: node, ...(key ? { keyName: key } : {}) }); return; }
  if (Array.isArray(node)) { for (const item of node.slice(0, 50)) walk(item, key, out, depth + 1); return; }
  if (node && typeof node === 'object') for (const [name, child] of Object.entries(node).slice(0, 100)) walk(child, name, out, depth + 1);
}

/** Pure decision from what was seen. Eligible: new on the page, or returned
 * under a field name that says it is a credential. */
export function decide(input: { before: ReadonlySet<string>; after: readonly string[]; responses: readonly Found[]; hint: boolean }): Decision {
  const scored = new Map<string, number>();
  const responseFor = new Map<string, Found>();
  for (const found of input.responses) responseFor.set(found.value, found);
  const candidates = new Set<string>([...input.after.filter(value => !input.before.has(value) && keyShaped(value)), ...responseFor.keys()]);
  for (const value of candidates) {
    const onPage = input.after.includes(value) && !input.before.has(value);
    const response = responseFor.get(value);
    const strong = !!response?.keyName && STRONG_KEY.test(response.keyName);
    if (!onPage && !strong) continue;
    scored.set(value, (onPage ? 3 : 0) + (response ? 2 : 0) + (strong ? 2 : 0) + (PREFIXED.test(value) ? 2 : 0) + (value.length >= 24 ? 1 : 0) + (input.hint ? 1 : 0));
  }
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || top[1] < 5) return { kind: 'none' };
  if (next && next[1] > top[1] - 2) return { kind: 'ambiguous' };
  return { kind: 'found', value: top[0] };
}

type Snapshot = { tokens: string[]; hint: boolean };

/** Runs in the page: every input value, copy-button payload and word of visible text. */
function pageTokens(): Snapshot {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string; getAttribute(name: string): string | null }> } }).document;
  const tokens = new Set<string>();
  for (const word of doc.body.innerText.split(/\s+/)) tokens.add(word.replace(/^[("'`]+|[)"'`,.;]+$/g, ''));
  for (const element of Array.from(doc.querySelectorAll('input, textarea'))) if (element.value) tokens.add(element.value);
  for (const element of Array.from(doc.querySelectorAll('[data-clipboard-text], [data-copy], [data-value], [data-key], [data-secret]'))) {
    for (const name of ['data-clipboard-text', 'data-copy', 'data-value', 'data-key', 'data-secret']) { const attribute = element.getAttribute(name); if (attribute) tokens.add(attribute); }
  }
  return { tokens: [...tokens].filter(token => token.length >= 16 && token.length <= 512), hint: false };
}

async function snapshot(page: Page): Promise<Snapshot> {
  try {
    const taken = await page.evaluate(pageTokens);
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText);
    return { tokens: taken.tokens, hint: WORTH_SAVING_HINT.test(text) };
  } catch { return { tokens: [], hint: false }; } // A navigation can destroy the document mid-read.
}

export type Finder = { look(): Promise<Decision>; dispose(): void };

/** Take the "before" picture and start listening to the site's own requests. */
export async function armFinder(page: Page): Promise<Finder> {
  const before = new Set((await snapshot(page)).tokens);
  const responses: Found[] = [];
  const listen = async (response: import('playwright-core').Response): Promise<void> => {
    try {
      const type = response.request().resourceType();
      if ((type !== 'fetch' && type !== 'xhr') || !/json/i.test(response.headers()['content-type'] ?? '')) return;
      const body = await response.text();
      if (body.length > 500_000) return;
      walk(JSON.parse(body), undefined, responses);
    } catch { /* a redirect or aborted request has no body to read */ }
  };
  page.on('response', listen);
  return {
    async look() {
      const now = await snapshot(page);
      return decide({ before, after: now.tokens, responses, hint: now.hint });
    },
    dispose() { page.off('response', listen); },
  };
}
