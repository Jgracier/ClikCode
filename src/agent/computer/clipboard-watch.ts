/** Fallback when the key cannot be found on its own: wait for a copy made ON
 * THE PAGE (the site's Copy button, or a keyboard copy of a selection, on the
 * computer or through the phone handoff). The page's own copy is observed, not
 * the computer's shared clipboard, so another program copying something else
 * can never be mistaken for the key. */
import type { Page } from 'playwright-core';

type Hooked = { __clikcodeCopied?: string | null; navigator: { clipboard?: { writeText(text: string): Promise<void> } }; document: { getSelection(): { toString(): string } | null; addEventListener(type: string, listener: () => void, capture: boolean): void } };

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
  w.document.addEventListener('copy', () => {
    const selected = String(w.document.getSelection() ?? '');
    if (selected) w.__clikcodeCopied = selected;
  }, true);
}

/** A single line a person could have copied as a key: no spaces inside, bounded. */
export function plausibleCopy(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text || text.length < 8 || text.length > 4096 || /\s/.test(text)) return undefined;
  return text;
}

export async function waitForCopiedSecret(page: Page, signal: AbortSignal): Promise<string | undefined> {
  try {
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
  } catch { /* the paste prompt still works */ }
  const read = (): Promise<string | null | undefined> =>
    page.evaluate(() => (globalThis as unknown as Hooked).__clikcodeCopied).catch(() => undefined);
  while (!signal.aborted && !page.isClosed()) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const found = plausibleCopy(await read());
    if (found) {
      await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; }).catch(() => undefined);
      return found;
    }
  }
  return undefined;
}
