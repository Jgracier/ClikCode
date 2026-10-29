/** Takes what the site's own Copy button copies. The page's own copy is observed, not the
 * computer's shared clipboard, so another program copying something else can never be
 * mistaken for the key. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Page } from 'playwright-core';
import { compactToken, MAX_KEY_LENGTH } from './secret-finder.js';

type Hooked = { __clikcodeCopied?: string | null; navigator: { clipboard?: { writeText(text: string): Promise<void>; write?(items: unknown[]): Promise<void> } }; document: { getSelection(): { toString(): string } | null; addEventListener(type: string, listener: () => void, capture: boolean): void; execCommand?(command: string, ...rest: unknown[]): boolean } };

/** Runs in the page. Idempotent: installed once per document. */
function hookCopy(): void {
  const w = globalThis as unknown as Hooked;
  if (w.__clikcodeCopied !== undefined) return;
  w.__clikcodeCopied = null;
  const clipboard = w.navigator.clipboard;
  if (clipboard) {
    const original = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) => { w.__clikcodeCopied = String(text); return original(text); };
  }
  // Sites copy three ways: writeText, write (a ClipboardItem, which is how many dialogs do it) and the
  // old execCommand. Missing one is how a Copy button "copies nothing".
  if (clipboard?.write) {
    const originalWrite = clipboard.write.bind(clipboard);
    clipboard.write = async (items: unknown[]) => {
      try {
        const item = items[0] as { getType?(type: string): Promise<{ text(): Promise<string> }> } | undefined;
        const blob = await item?.getType?.('text/plain');
        if (blob) w.__clikcodeCopied = await blob.text();
      } catch { /* the page's own copy still goes ahead */ }
      return originalWrite(items);
    };
  }
  if (w.document.execCommand) {
    const originalExec = w.document.execCommand.bind(w.document);
    w.document.execCommand = (command: string, ...rest: unknown[]) => {
      if (command === 'copy') { const selected = String(w.document.getSelection() ?? ''); if (selected) w.__clikcodeCopied = selected; }
      return originalExec(command, ...rest);
    };
  }
  w.document.addEventListener('copy', () => {
    const selected = String(w.document.getSelection() ?? '');
    if (selected) w.__clikcodeCopied = selected;
  }, true);
}

/** A single line a person could have copied as a key: no spaces inside, bounded. */
export function plausibleCopy(value: string | null | undefined): string | undefined {
  const text = compactToken(value ?? '');
  if (!text || text.length < 8 || text.length > MAX_KEY_LENGTH || /\s/.test(text)) return undefined;
  return text;
}

/** The site's own button for copying the new key: "Copy", "Copy key", "Copy API key to
 * clipboard", "Copy token". Buttons that copy something else (a name, an id, a cURL
 * command) say so and do not match. */
export const COPY_KEY_BUTTON = /^copy\b(?: [\w'’-]+){0,5}?(?: to clipboard)?$/i;
/** A button whose own name says it copies something that is not the credential. */
export const COPIES_OTHER = /\b(?:id|identifier|name|url|uri|link|curl|command|snippet|endpoint|email|address|username)\b/i;

/** What a Copy button's nearest label says it copies, as a rank: a secret, token or password
 * is the credential; an id, name or address is not. Pure so it can be tested. */
export function copyRank(label: string): number {
  const text = label.toLowerCase();
  if (/secret|private|token|password|passphrase/.test(text)) return 3;
  if (/\b(?:id|identifier|name|url|uri|endpoint|region|email|username|user)\b/.test(text)) return 0;
  return /key|credential|bearer/.test(text) ? 2 : 1;
}

/** The words near a Copy button that say what it copies, for the result line (never the nearby text itself, which may hold the value). */
const LABEL_WORDS = /\b(?:access key id|secret access key|secret key|client secret|client id|access key|api key|private key|key id|secret|token|password|passphrase)\b/i;

/** Several Copy buttons (an access key id, a secret key, a code snippet): the one whose
 * surroundings rank highest as the credential; the first when nothing tells them apart. */
async function bestCopy(buttons: import('playwright-core').Locator): Promise<{ button: import('playwright-core').Locator; label: string }> {
  const count = Math.min(await buttons.count(), 8);
  let best = 0; let bestRank = -1; let bestLabel = '';
  for (let index = 0; index < count; index++) {
    // Climb to the nearest ancestor that names what it holds ("Access Key ID:", "Secret Key:").
    const near = await buttons.nth(index).evaluate(element => {
      type Node = { parentElement: Node | null; textContent: string | null };
      for (let node = (element as unknown as Node).parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
        const text = (node.textContent ?? '').slice(0, 80);
        if (/key|token|secret|password|credential|bearer|\bid\b|name|url|endpoint/i.test(text)) return text;
      }
      return '';
    }).catch(() => '');
    const rank = copyRank(near);
    if (rank > bestRank) { best = index; bestRank = rank; bestLabel = LABEL_WORDS.exec(near)?.[0] ?? ''; }
  }
  return { button: buttons.nth(best), label: bestLabel };
}

/** Listen for copies from now on, so a click that itself copies (the agent pressed a Copy button as the trigger) is not lost. */
export async function listenForCopies(page: Page): Promise<void> {
  try {
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
    await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; });
  } catch { /* a page that is navigating cannot be hooked; the other ways still work */ }
}

/** What the page copied since `listenForCopies`, if it looks like a key. */
export async function copiedSince(page: Page): Promise<string | undefined> {
  return plausibleCopy(await page.evaluate(() => (globalThis as unknown as Hooked).__clikcodeCopied).catch(quiet('agent/computer/clipboard-watch')));
}

/** The system clipboard as this page sees it, when the browser lets it be read. A last resort behind the
 * page's own copy: it is trusted only when it CHANGED across the click, so something already there is never taken. */
export async function readClipboard(page: Page): Promise<string | undefined> {
  try { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); } catch { /* not grantable here */ }
  return page.evaluate(async () => {
    try { return await (globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }).navigator.clipboard.readText(); } catch { return undefined; }
  }).catch(quiet('agent/computer/clipboard-watch'));
}

/** Press that button and take what the page copies. What the site itself puts on
 * the clipboard is the key by definition, so no guess about its shape is needed. */
export async function copyWithSiteButton(page: Page, waitMs = 3_000): Promise<{ value: string; label: string } | undefined> {
  const buttons = page.getByRole('button', { name: COPY_KEY_BUTTON }).filter({ hasNotText: COPIES_OTHER }).locator('visible=true');
  let label = '';
  let before: string | undefined;
  try {
    if (!await buttons.count()) return undefined;
    before = await readClipboard(page);
    const chosen = await bestCopy(buttons);
    label = chosen.label;
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
    await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; });
    await chosen.button.click({ timeout: 3_000 });
  } catch { return undefined; }
  for (let waited = 0; waited < waitMs; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const found = plausibleCopy(await page.evaluate(() => (globalThis as unknown as Hooked).__clikcodeCopied).catch(quiet('agent/computer/clipboard-watch')));
    if (found) {
      await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; }).catch(quiet('agent/computer/clipboard-watch'));
      return { value: found, label };
    }
  }
  const after = plausibleCopy(await readClipboard(page));
  return after && after !== before?.trim() ? { value: after, label } : undefined;
}
