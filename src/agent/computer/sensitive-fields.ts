/** The one rule that keeps typed credentials out of what the agent reads: any page can be
 * read, but the VALUE of a password, one-time-code or card field never is. Nothing here
 * guesses which pages are "sign-in pages". */
import type { Page } from 'playwright-core';
import { allComputerPages, computerBrowserPids } from './browser.js';
import { secretRef } from './secret-scrubber.js';
import { quiet } from '../../runtime/lifecycle-log.js';

/** A card box that does not carry the standard cc-* autocomplete: named for the number or the security code. */
const CARD_BOX = ['cardnumber', 'card-number', 'card_number', 'ccnumber', 'cc-number', 'cc_number'].flatMap(word => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]).join(', ')
  + ', ' + ['cvc', 'cvv', 'csc', 'cvc2', 'cvv2', 'securitycode', 'security-code', 'security_code'].flatMap(word => [`input[name="${word}" i]`, `input[id="${word}" i]`]).join(', ');
export const SENSITIVE = `input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete^="cc-"], input[autocomplete*=" cc-"], ${CARD_BOX}`;
const MIN_LENGTH = 3;

/** What the sensitive fields on the page hold right now (including a password shown by a "show" toggle). */
export async function sensitiveValues(page: Page, readableOnly = false): Promise<string[]> {
  // Every frame: a payment provider's hosted card fields are one frame per box, and a card number typed there is shown back
  // regrouped ("4242 4242 4242 4242"), which no exact match of the value that was typed would catch.
  const values: string[] = [];
  let frames: ReturnType<Page['frames']> = [];
  try { frames = page.frames(); } catch (error) { if (readableOnly) throw error; return []; } // The page is closing.
  for (const frame of frames) {
    if (frame.isDetached()) continue;
    try {
      // A visible child document can belong to an iframe hidden by its parent document.
      let frameVisible = true;
      if (readableOnly) for (let ancestor = frame; ancestor.parentFrame(); ancestor = ancestor.parentFrame()!) {
        const element = await ancestor.frameElement();
        try {
          if (!await element.evaluate(node => {
            const element = node as unknown as {
              checkVisibility(options: { checkOpacity: boolean; checkVisibilityCSS: boolean }): boolean;
              getBoundingClientRect(): { width: number; height: number; top: number; left: number; bottom: number; right: number };
              ownerDocument: { defaultView: { innerWidth: number; innerHeight: number } | null };
            };
            const rect = element.getBoundingClientRect();
            const view = element.ownerDocument.defaultView;
            return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !!view && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
          })) { frameVisible = false; break; }
        } finally { await element.dispose(); }
      }
      if (!frameVisible) continue;
      values.push(...await frame.locator('input').evaluateAll((nodes, { selector, onlyReadable }) => nodes.filter(node => {
        const field = node as unknown as {
          matches(selector: string): boolean;
          getAttribute(name: string): string | null;
          labels?: ArrayLike<{ textContent: string | null }>;
          ownerDocument: { getElementById(id: string): { textContent: string | null } | null };
        };
        const labelled = field.getAttribute('aria-labelledby')?.split(/\s+/).map(id => field.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
        const label = labelled || field.getAttribute('aria-label') || Array.from(field.labels ?? []).map(label => label.textContent ?? '').join(' ');
        if (!field.matches(selector) && !/\b(?:card\s*number|credit card|debit card|cvv|cvc|csc|card security code)\b/i.test(label ?? '')) return false;
        if (!onlyReadable) return true;
        const element = node as unknown as {
          type?: string;
          checkVisibility(options: { checkOpacity: boolean; checkVisibilityCSS: boolean }): boolean;
          getBoundingClientRect(): { width: number; height: number; top: number; left: number; bottom: number; right: number };
          ownerDocument: { defaultView: { innerWidth: number; innerHeight: number } | null };
        };
        // Native password inputs paint masking glyphs, not their value. A revealed password
        // becomes a text input (with its autocomplete/name still identifying the secret).
        if (element.type === 'password') return false;
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const rect = element.getBoundingClientRect();
        const view = element.ownerDocument.defaultView;
        return !!view && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
      }).map(node => (node as unknown as { value?: string }).value ?? ''), { selector: SENSITIVE, onlyReadable: readableOnly }));
    } catch (error) {
      if (readableOnly) throw error; // A screenshot guard must distinguish unreadable from empty.
      // Text scrubbing can still use the other frames while this one navigates.
    }
  }
  return [...new Set(values.filter(value => value.length >= MIN_LENGTH))];
}

/** Runs in the page: values of plain text inputs, read-only inputs and textareas that are key-shaped, or that
 * sit next to a "key", "token" or "secret" label (its accessible name, placeholder, name, id, <label>, or the text
 * just before it). A site may show its API key in an ordinary text box; the accessibility text carries that value. */
function keyFieldValuesInPage(): string[] {
  const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<Record<string, unknown>> } }).document;
  const NAMED = /(?:^|[^a-z])(?:api[ _-]?|access[ _-]?|auth[ _-]?|private[ _-]?|client[ _-]?|app[ _-]?)?(?:key|token|secret|credential)s?(?![a-z])/i;
  const SHAPED = (value: string): boolean => {
    if (value.length < 12 || value.length > 600 || !/^[A-Za-z0-9_\-+/=.:~]+$/.test(value) || /^https?:|@/.test(value) || /^\d+$/.test(value)) return false;
    if (!/[A-Za-z]/.test(value) || !(/\d/.test(value) || (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value)))) return false;
    return new Set(value).size >= 6;
  };
  const out = new Set<string>();
  for (const element of Array.from(doc.querySelectorAll('input, textarea'))) {
    const type = String(element['type'] ?? 'text').toLowerCase();
    if (['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color', 'image', 'reset'].includes(type)) continue;
    const value = String(element['value'] ?? '').trim();
    if (value.length < 8 || /\s/.test(value) && value.length < 20) continue;
    const labels = Array.from((element['labels'] as ArrayLike<{ textContent: string | null }> | null) ?? []).map(label => label.textContent ?? '').join(' ');
    const get = (name: string): string => String((element['getAttribute'] as (n: string) => string | null).call(element, name) ?? '');
    const before = (() => {
      let text = '';
      let node = element as { previousSibling?: { textContent?: string | null } | null; parentElement?: Record<string, unknown> | null };
      for (let step = 0; step < 3 && !text.trim(); step++) { text = node.previousSibling?.textContent ?? ''; if (!text.trim() && node.parentElement) node = node.parentElement as typeof node; }
      return text.trim().slice(-60);
    })();
    const hint = [labels, get('aria-label'), get('placeholder'), get('name'), get('id'), get('title'), before].join(' ');
    // A box that names a key holds one only if it is not the key's NAME, label or note ("Token name": ClikDeploy) and the value is not a
    // plain word: masking an ordinary word hid it everywhere for the rest of the process (every "ClikDeploy" in the loop's messages).
    const nameBox = /\b(?:name|label|title|description|note|nickname|alias)\b/i.test(hint);
    const plainWord = /^[A-Za-z][A-Za-z._-]*$/.test(value) && value.length <= 14;
    if (SHAPED(value) || (NAMED.test(hint) && !nameBox && !plainWord)) out.add(value);
  }
  return [...out];
}

/** Values the agent must never read from a page's text inputs. */
export async function keyFieldValues(page: Page): Promise<string[]> {
  try { return await page.evaluate(keyFieldValuesInPage); }
  catch { return []; } // The page is navigating.
}


type PageSecret = { value: string; label: string };

/** Runs in each frame: every credential the page shows as text. A value in a table cell, definition list or label/value pair
 * whose column header, row label or term names a key, secret, token, password or API; an opaque high-entropy token in a code block,
 * an input, or a data attribute. Nothing about the page's layout is assumed beyond that. */
function pageSecretsInPage(): PageSecret[] {
  type El = { tagName: string; textContent: string | null; children: ArrayLike<El>; previousElementSibling: El | null; nextElementSibling: El | null; parentElement: El | null; cellIndex?: number; cells?: ArrayLike<El>; rows?: ArrayLike<El>; attributes: ArrayLike<{ name: string; value: string }>; value?: string; getAttribute(name: string): string | null; querySelectorAll(selector: string): ArrayLike<El>; closest(selector: string): El | null };
  const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<El> } }).document;
  const LABEL = /key|secret|token|password|passcode|credential|api/i;
  const norm = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
  const entropy = (text: string): number => { const counts = new Map<string, number>(); for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1); let bits = 0; for (const n of counts.values()) { const p = n / text.length; bits -= p * Math.log2(p); } return bits; };
  const opaque = (value: string): boolean => value.length >= 16 && value.length <= 8000 && /^[A-Za-z0-9_\-+/=.:~]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && entropy(value) >= 3
    && !/^https?:|@/.test(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^[a-z][a-z-]*\/[\w-]+$/.test(value);
  const found = new Map<string, string>();
  const add = (label: string, raw: string | null | undefined, labelled: boolean): void => {
    const value = norm(raw);
    if (value.length < 8 || value.length > 8000 || /\s/.test(value) || /[•●*…]/.test(value) || /^https?:|@/.test(value) || /^\[secret/.test(value)) return;
    if ((labelled && (/\d/.test(value) || value.length >= 20)) || opaque(value)) { if (!found.has(value)) found.set(value, norm(label).slice(0, 80)); }
  };
  // Table cells: the column header, the row's own th, or the first cell of the row names the value.
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    let headers: string[] = [];
    for (const row of rows) {
      const cells = Array.from(row.children);
      if (cells.length && cells.every(cell => cell.tagName === 'TH')) { headers = cells.map(cell => norm(cell.textContent)); continue; }
      cells.forEach((cell, at) => {
        if (cell.tagName === 'TH') return;
        const candidates = [headers[at] ?? '', at > 0 ? norm(cells[0]!.textContent) : '', ...cells.filter(other => other.tagName === 'TH' && other !== cell).map(other => norm(other.textContent))];
        const label = candidates.find(text => LABEL.test(text) && text.length <= 60);
        if (label) {
          // The whole cell text, and any word or input inside it ("abc123… Copy" shows the key as its first word).
          add(label, cell.textContent, true);
          for (const word of norm(cell.textContent).split(' ')) add(label, word, true);
          for (const input of Array.from(cell.querySelectorAll('input, textarea, code, pre, span, a'))) add(label, input.value ?? input.textContent, true);
        }
      });
    }
  }
  // Definition lists and label/value pairs: a term or a label element that names a credential, and the element after it.
  for (const term of Array.from(doc.querySelectorAll('dt, th[scope="row"], label, [class*="label"], strong, b'))) {
    const label = norm(term.textContent);
    if (!LABEL.test(label) || label.length > 60) continue;
    for (let next = term.nextElementSibling, steps = 0; next && steps < 2; next = next.nextElementSibling, steps++) {
      if (term.tagName === 'DT' && next.tagName !== 'DD') break;
      add(label, next.value ?? next.textContent, true);
      for (const inner of Array.from(next.querySelectorAll('input, textarea, code, pre, span'))) add(label, inner.value ?? inner.textContent, true);
    }
  }
  for (const element of Array.from(doc.querySelectorAll('code, pre, samp, kbd, input, textarea'))) {
    const type = String(element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'password' || type === 'hidden' && !opaque(element.value ?? '')) continue;
    const text = norm(element.value ?? element.textContent);
    add('', text, false);
    // A token wrapped over several lines is one token.
    const parts = (element.value ?? element.textContent ?? '').trim().split(/\s+/);
    if (parts.length > 1 && parts.length <= 400) add('', parts.join(''), false);
  }
  for (const element of Array.from(doc.querySelectorAll('*')).slice(0, 6000)) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('data-')) continue;
      const named = LABEL.test(attribute.name) && !/api-?(?:url|host|base|endpoint)|keyboard|tokenizer/i.test(attribute.name);
      if (/(?:^|-)(?:id|testid|ref|url|href|src|reactid)$/.test(attribute.name) && !named) continue;
      add(attribute.name, attribute.value, named && attribute.value.length >= 8 || attribute.value.length >= 20 && opaque(attribute.value));
    }
  }
  return [...found].map(([value, label]) => ({ value, label }));
}

/** What the page shows as credentials in text, in every frame (see pageSecretsInPage). */
export async function pageSecrets(page: Page): Promise<PageSecret[]> {
  const out = new Map<string, string>();
  let frames: ReturnType<Page['frames']> = [];
  try { frames = page.frames(); } catch { return []; }
  for (const frame of frames) {
    if (frame.isDetached()) continue;
    try { for (const found of await frame.evaluate(pageSecretsInPage)) if (!out.has(found.value)) out.set(found.value, found.label); }
    catch { /* fail-open-ok: a frame that is navigating or cross-origin cannot be read */ }
  }
  return [...out].map(([value, label]) => ({ value, label }));
}

/** A page secret named by its label ("API key", "Token"), or the only one the page shows when no label is given. Undefined when it is not clear. */
export async function findLabelledSecret(page: Page, label?: string): Promise<string | undefined> {
  const all = await pageSecrets(page);
  const words = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!words) return new Set(all.map(item => item.value)).size === 1 ? all[0]!.value : undefined;
  const matches = all.filter(item => item.label && item.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(words));
  const distinct = [...new Set(matches.map(item => item.value))];
  // A cell can hold the key as a whole and as a word inside it: the longest one is the key.
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** `text` with every sensitive field value, and every key-like text-box value, on the page replaced. */
export async function maskSensitive(page: Page, text: string): Promise<string> {
  let out = text;
  for (const value of (await sensitiveValues(page)).sort((a, b) => b.length - a.length)) out = out.split(value).join('[hidden]');
  // A key shown as text is replaced by a placeholder capture_secret can be aimed at, so it is never needed in the model's context.
  const shown = new Set<string>([...await keyFieldValues(page), ...(await pageSecrets(page)).map(item => item.value)]);
  for (const value of [...shown].sort((a, b) => b.length - a.length)) { const ref = secretRef(value); if (out.includes(value)) out = out.split(value).join(ref); }
  return out;
}

/** Whether a picture of the window owned by `windowPid` could show the ClikCode browser's fields. The browser's
 * process ids come from Chrome itself (CDP SystemInfo), so this is one integer comparison on every OS: Linux, macOS
 * and Windows all report the OS process id that `list_windows` names as the window's owner. A window with no pid, or a
 * browser that cannot list its processes, is guarded as if it were the browser. */
export function windowMayShowBrowser(browserPids: readonly number[] | undefined, windowPid: number | undefined): boolean {
  if (windowPid === undefined || !browserPids) return true;
  return browserPids.includes(windowPid);
}

/** Inspection failed: refuse the screenshot without claiming that a credential was detected. */
export class CredentialInspectionUnavailable extends Error {
  constructor() { super('Could not inspect the browser for sensitive fields; no screenshot was taken. This is an inspection failure, not a detected credential. Retry when the browser is available.'); }
}

const BROWSER_CLOSED = /^(?:ClikCode browser|The managed cloud browser) is closed\b/;

/** A typed or revealed credential is in a tab a screenshot could show: the front tab of a window that is not
 * minimized (a tab behind it, or a closed window, is not on screen). With `windowPid`, only when that window is
 * the ClikCode browser itself: a picture of another app cannot hold the browser's fields. */
export async function credentialOnScreen(stateDir: string, windowPid?: number, options: { listPages?: (stateDir: string) => Promise<Page[]> } = {}): Promise<boolean> {
  let pages: Page[];
  try { pages = await (options.listPages ?? allComputerPages)(stateDir); }
  catch (error) {
    // No ClikCode browser open: nothing of it can be on screen. Any other failure to list its tabs is not proof that none shows a
    // typed password, so the picture is refused (fail closed).
    if (error instanceof Error && BROWSER_CLOSED.test(error.message)) return false;
    throw new CredentialInspectionUnavailable();
  }
  if (windowPid !== undefined) {
    const pids = await computerBrowserPids(stateDir).catch(quiet('agent/computer/sensitive-fields'));
    if (!windowMayShowBrowser(pids, windowPid)) return false;
  }
  for (const page of pages) {
    try {
      if (await page.evaluate(() => (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState === 'hidden')) continue;
      if ((await sensitiveValues(page, true)).length) return true;
    } catch {
      if (page.isClosed()) continue;
      throw new CredentialInspectionUnavailable();
    }
  }
  return false;
}
