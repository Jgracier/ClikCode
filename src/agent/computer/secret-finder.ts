/** Finds a freshly created API key on the page without a person: the key the
 * site's own request returned, and any new key-looking text that appeared on
 * the page since just before the click. The decision is a score, and it only
 * answers when one candidate clearly leads. Values stay in the worker. */
import type { Page } from 'playwright-core';
import { isSecretRef, secretRef } from './secret-scrubber.js';

export type Found = { value: string; keyName?: string };
export type Decision = { kind: 'found'; value: string } | { kind: 'none' } | { kind: 'ambiguous' };

/** The longest opaque token taken as a key (a personal access token can be a signed JWT of 1,000 characters or more). */
export const MAX_KEY_LENGTH = 8000;

/** Field names that mean "this is the credential", not just any token (a CSRF token is not). */
const STRONG_KEY = /api.?key|secret|access.?token|private.?key|auth.?token|bearer|credential/i;
const PREFIXED = /^(?:[a-z]{2,12}(?:_[a-z]+)*_[A-Za-z0-9]{12,}|sk-|ghp_|github_pat_|AKIA|AIza|AQ\.|xox[abp]-|eyJ)/;
/** A word that names the credential, so the value right after it is the credential ("API Key AQ.xxxx"). */
const LABEL_THEN_VALUE = /\b(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?token|token|key|credential|password)s?(?:[ \t]*[:=][ \t]*|[ \t]+)([A-Za-z0-9_\-+/=.:~]{16,8000})/gi;
/** A UUID right after a "secret" label ("secret-key=7456…"): all lower-case hex, so it is no mixed-case token, yet it is the credential. */
const SECRET_UUID = /(\bsecret[ _-]?(?:key|token)?s?(?:[ \t]*[:=][ \t]*|[ \t]+))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
/** Upper and lower case together with a digit, or (no digit) enough randomness that it is not a word. */
const mixedCase = (value: string): boolean => /[a-z]/.test(value) && /[A-Z]/.test(value) && (/\d/.test(value) || entropy(value) >= 4.5);

export function labelledValues(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(LABEL_THEN_VALUE)) found.add(match[1]!.replace(/[.,;:)]+$/, ''));
  return found;
}
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
  if (value.length < 16 || value.length > MAX_KEY_LENGTH || !/^[A-Za-z0-9_\-+/=.:~]+$/.test(value)) return false;
  // Keys are rarely over ~130 characters; a longer token must be a JWT (dotted segments) or plainly random, never a word, path or URL.
  if (value.length > 130 && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) && !(mixedCase(value) && entropy(value) >= 4.2)) return false;
  if (/^https?:|@/.test(value) || /^\d+$/.test(value)) return false;
  // Most keys carry a digit; one without (hf_ + letters) must be prefixed or plainly random.
  if (!/\d/.test(value) && !PREFIXED.test(value) && !(value.length >= 32 && mixedCase(value))) return false;
  // A resource path such as projects/831963658327 names a thing, it is not a credential.
  if (/^[a-z][a-z-]*\/[\w-]+$/.test(value)) return false;
  return entropy(value) >= 3;
}

/** A long token that a code block, textarea or copy wrapped over several lines or with spaces, put back in one piece; otherwise the text as it was. */
export function compactToken(text: string): string {
  const trimmed = text.trim();
  if (!/\s/.test(trimmed)) return trimmed;
  const parts = trimmed.split(/\s+/);
  const joined = parts.join('');
  return parts.length <= 400 && joined.length >= 100 && joined.length <= MAX_KEY_LENGTH && parts.every(part => /^[A-Za-z0-9_\-+/=.:~]+$/.test(part)) && keyShaped(joined) ? joined : trimmed;
}

function walk(node: unknown, key: string | undefined, out: Found[], depth = 0): void {
  if (depth > 6 || out.length > 200) return;
  if (typeof node === 'string') { if (keyShaped(node)) out.push({ value: node, ...(key ? { keyName: key } : {}) }); return; }
  if (Array.isArray(node)) { for (const item of node.slice(0, 50)) walk(item, key, out, depth + 1); return; }
  if (node && typeof node === 'object') for (const [name, child] of Object.entries(node).slice(0, 100)) walk(child, name, out, depth + 1);
}

/** Pure decision from what was seen. Eligible: new on the page, or returned
 * under a field name that says it is a credential. */
export function decide(input: { before: ReadonlySet<string>; after: readonly string[]; responses: readonly Found[]; hint: boolean; labelled?: ReadonlySet<string>; existing?: boolean }): Decision {
  const scored = new Map<string, number>();
  const responseFor = new Map<string, Found>();
  for (const found of input.responses) responseFor.set(found.value, found);
  const candidates = new Set<string>([...input.after.filter(value => !input.before.has(value) && keyShaped(value)), ...responseFor.keys()]);
  // The lines of a wrapped token are not tokens of their own once the whole token is there.
  for (const value of [...candidates]) if ([...candidates].some(other => other.length > value.length && other.includes(value))) candidates.delete(value);
  for (const value of candidates) {
    const onPage = input.after.includes(value) && !input.before.has(value);
    const response = responseFor.get(value);
    const strong = !!response?.keyName && STRONG_KEY.test(response.keyName);
    if (!onPage && !strong) continue;
    // Text that was already on the page proves nothing by being there: it must say it is a
    // key (a label before it, or a known key prefix), or any long id would be taken.
    if (input.existing && !strong && !input.labelled?.has(value) && !PREFIXED.test(value)) continue;
    scored.set(value, (onPage ? 3 : 0) + (response ? 2 : 0) + (strong ? 2 : 0) + (PREFIXED.test(value) ? 2 : 0) + (input.labelled?.has(value) ? 2 : 0) + (mixedCase(value) ? 1 : 0) + (value.length >= 24 ? 1 : 0) + (input.hint ? 1 : 0));
  }
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || top[1] < 5) return { kind: 'none' };
  if (next && next[1] > top[1] - 2) return { kind: 'ambiguous' };
  return { kind: 'found', value: top[0] };
}

type Snapshot = { tokens: string[]; hint: boolean; labelled: Set<string> };

/** Runs in the page: every input value, copy-button payload and word of visible text. */
function pageTokens(withMasked: boolean): Snapshot {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string; type?: string; getAttribute(name: string): string | null }> } }).document;
  const tokens = new Set<string>();
  for (const word of doc.body.innerText.split(/\s+/)) tokens.add(word.replace(/^[("'`]+|[)"'`,.;]+$/g, ''));
  // A masked field's value is not shown: it counts only once a Show button has turned it into text (or when the page's current key is wanted).
  for (const element of Array.from(doc.querySelectorAll('input, textarea'))) if (element.value && (withMasked || element.type !== 'password')) tokens.add(element.value);
  // A token shown in a code block or textarea may be wrapped over lines: the pieces joined are the token.
  for (const element of Array.from(doc.querySelectorAll('pre, code, textarea, samp, [class*="token"], [class*="secret"]')) as unknown as { value?: string; textContent: string | null }[]) {
    const text = (element.value || element.textContent || '').trim();
    if (text.length >= 100 && text.length <= 16000 && /\s/.test(text)) {
      const parts = text.split(/\s+/);
      if (parts.length <= 400 && parts.every(part => /^[A-Za-z0-9_\-+/=.:~]+$/.test(part))) tokens.add(parts.join(''));
    }
  }
  for (const element of Array.from(doc.querySelectorAll('[data-clipboard-text], [data-copy], [data-value], [data-key], [data-secret]'))) {
    for (const name of ['data-clipboard-text', 'data-copy', 'data-value', 'data-key', 'data-secret']) { const attribute = element.getAttribute(name); if (attribute) tokens.add(attribute); }
  }
  return { tokens: [...tokens].filter(token => token.length >= 16 && token.length <= 8000), hint: false, labelled: new Set<string>() };
}

async function snapshot(page: Page, withMasked = false): Promise<Snapshot> {
  try {
    const taken = await page.evaluate(pageTokens, withMasked);
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText);
    return { tokens: taken.tokens, hint: WORTH_SAVING_HINT.test(text), labelled: labelledValues(text) };
  } catch { return { tokens: [], hint: false, labelled: new Set<string>() }; } // A navigation can destroy the document mid-read.
}

type Finder = { look(): Promise<Decision>; dispose(): void };

/** Take the "before" picture and start listening to the site's own requests. */
/** With `existing`, nothing counts as already there: a key the page is showing now (an account's current key) is taken. */
export async function armFinder(page: Page, existing = false): Promise<Finder> {
  const before = existing ? new Set<string>() : new Set((await snapshot(page)).tokens);
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
      const now = await snapshot(page, existing);
      return decide({ before, after: now.tokens, responses, hint: now.hint, labelled: now.labelled, existing });
    },
    dispose() { page.off('response', listen); },
  };
}

/** Hides credential-looking values in text the agent is about to read (a page's accessibility text).
 *
 * Default-deny: a long, unbroken, random-looking token is hidden wherever it sits, because every leak so far
 * was a page layout a "hide it only after the word secret" rule did not expect. What is kept is what the
 * agent needs: page refs, URLs (their own lines), UUIDs and ordinary words. A hidden value is never lost to
 * the agent: capture_secret takes it from the page without showing it. */
export function hideKeyLikeText(text: string): { text: string; hidden: number } {
  const labelled = labelledValues(text);
  const copyHint = WORTH_SAVING_HINT.test(text);
  let hidden = 0;
  text = text.replace(SECRET_UUID, (match, label?: string, uuid?: string) => { hidden++; const shown = secretRef(uuid ?? match); return typeof label === 'string' ? `${label}${shown}` : shown; });
  // A long run of digits is an id or a secret (a 39-digit client secret), not a number a person reads: 24 or more digits are hidden.
  const longNumber = (bare: string): boolean => /^\d{24,}$/.test(bare);
  // Also a plain run of letters and digits with the spread of a random string, in any case (an old-style 20-character API key).
  const randomLooking = (bare: string): boolean => keyShaped(bare) && (mixedCase(bare) || PREFIXED.test(bare) || (bare.length >= 32 && /^[0-9a-f]+$/i.test(bare)) || (/^[A-Za-z0-9]{20,}$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare) && entropy(bare) >= 3.6));
  const lines = text.split('\n').map(line => {
    const isUrl = /^\s*- \/url:/.test(line);
    return line.replace(/[A-Za-z0-9_\-+/=.:~]{20,}/g, token => {
      const bare = token.replace(/[.,;:)]+$/, '');
      if (longNumber(bare)) { if (isUrl) return token; hidden++; return secretRef(bare); }
      if (!keyShaped(bare)) return token;
      // A URL line keeps its address, except a value a label or an invitation to copy has marked as a key.
      const marked = (mixedCase(bare) && labelled.has(bare)) || (copyHint && bare.length >= 32);
      if (isUrl ? !marked : !(marked || randomLooking(bare))) return token;
      hidden++;
      return secretRef(bare) + token.slice(bare.length);
    });
  });
  // A short credential (a 15-character app key and secret) is too short for the shape rules above, but a
  // letters-and-digits token on, or right under, a line that names a secret, token, key or password is one.
  const NAMED = /\b(?:secret|token|api[ _-]?key|app[ _-]?key|client[ _-]?secret|password|credential)s?\b/i;
  const guarded = lines.map((line, index) => {
    if (!NAMED.test(line) && !(index > 0 && NAMED.test(lines[index - 1]!))) return line;
    return line.replace(/(?<![\w-])[A-Za-z0-9_-]{12,23}(?![\w-])/g, token => {
      if (!/\d/.test(token) || !/[A-Za-z]/.test(token) || /^ref=|^f\d*e\d+$/.test(token)) return token;
      hidden++;
      return secretRef(token);
    });
  });
  // A text box whose name says key/token/secret, or whose value is shaped like one, shows it as `textbox "API key" [ref=e5]: value`.
  const BOX = /^(\s*- (?:textbox|searchbox|text|textarea)\b[^\n]*?\]):\s+(\S{8,})\s*$/;
  const boxed = guarded.map(line => {
    const match = BOX.exec(line);
    if (!match) return line;
    const value = match[2]!.replace(/^"|"$/g, '');
    const named = /(?:^|[^a-z])(?:key|token|secret|credential)s?(?![a-z])/i.test(match[1]!);
    const shaped = value.length >= 12 && /^[A-Za-z0-9_\-+/=.:~]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value) && !/^https?:|@/.test(value);
    if (value === '[secret hidden]' || value === '[hidden]' || isSecretRef(value) || !(named || shaped)) return line;
    hidden++;
    return `${match[1]}: ${secretRef(value)}`;
  });
  return { text: boxed.join('\n'), hidden };
}
