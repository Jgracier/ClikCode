/** The one rule that keeps typed credentials out of what the agent reads: any page can be
 * read, but the VALUE of a password, one-time-code or card field never is. Nothing here
 * guesses which pages are "sign-in pages". */
import type { Page } from 'playwright-core';
import { allComputerPages, computerBrowserPids } from './browser.js';

export const SENSITIVE = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete^="cc-"]';
const MIN_LENGTH = 3;

/** What the sensitive fields on the page hold right now (including a password shown by a "show" toggle). */
export async function sensitiveValues(page: Page): Promise<string[]> {
  try {
    const values = await page.locator(SENSITIVE).evaluateAll(nodes => nodes.map(node => (node as unknown as { value?: string }).value ?? ''));
    return [...new Set(values.filter(value => value.length >= MIN_LENGTH))];
  } catch { return []; } // The page is navigating, or has no such field.
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
    if (SHAPED(value) || NAMED.test(hint)) out.add(value);
  }
  return [...out];
}

/** Values the agent must never read from a page's text inputs. */
export async function keyFieldValues(page: Page): Promise<string[]> {
  try { return await page.evaluate(keyFieldValuesInPage); }
  catch { return []; } // The page is navigating.
}

/** `text` with every sensitive field value, and every key-like text-box value, on the page replaced. */
export async function maskSensitive(page: Page, text: string): Promise<string> {
  let out = text;
  for (const value of [...await sensitiveValues(page), ...await keyFieldValues(page)].sort((a, b) => b.length - a.length)) out = out.split(value).join('[hidden]');
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

/** A typed or revealed credential is in a tab a screenshot could show: the front tab of a window that is not
 * minimized (a tab behind it, or a closed window, is not on screen). With `windowPid`, only when that window is
 * the ClikCode browser itself: a picture of another app cannot hold the browser's fields. */
export async function credentialOnScreen(stateDir: string, windowPid?: number): Promise<boolean> {
  let pages: Page[];
  try { pages = await allComputerPages(stateDir); }
  catch { return false; } // No ClikCode browser is open.
  if (windowPid !== undefined) {
    const pids = await computerBrowserPids(stateDir);
    if (!windowMayShowBrowser(pids, windowPid)) return false;
  }
  for (const page of pages) {
    if (!(await sensitiveValues(page)).length) continue;
    if (await page.evaluate(() => (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState !== 'hidden').catch(() => true)) return true;
  }
  return false;
}
