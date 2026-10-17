/** Takes what the site's own Copy button copies. The page's own copy is observed, not the
 * computer's shared clipboard, so another program copying something else can never be
 * mistaken for the key. */
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

/** The site's own button for copying the new key: "Copy", "Copy key", "Copy API key to
 * clipboard", "Copy token". Buttons that copy something else (a name, an id, a cURL
 * command) say so and do not match. */
const COPY_KEY_BUTTON = /^copy(?: (?:the |your )?(?:new )?(?:api )?(?:secret )?(?:key|token|secret|value|password))?(?: to clipboard)?$/i;

/** Several Copy buttons (an access key id, a secret key, a code snippet): the one whose
 * surroundings say "secret", else the first. */
async function secretOne(buttons: import('playwright-core').Locator): Promise<import('playwright-core').Locator> {
  const count = Math.min(await buttons.count(), 8);
  for (let index = 0; index < count; index++) {
    // Climb to the nearest ancestor that names what it holds ("Access Key ID:", "Secret Key:").
    const near = await buttons.nth(index).evaluate(element => {
      type Node = { parentElement: Node | null; textContent: string | null };
      for (let node = (element as unknown as Node).parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
        const label = /(?:access|secret)[ _-]?key|api[ _-]?key|token/i.exec(node.textContent?.slice(0, 300) ?? '');
        if (label) return label[0];
      }
      return '';
    }).catch(() => '');
    if (/secret/i.test(near)) return buttons.nth(index);
  }
  return buttons.first();
}

/** Press that button and take what the page copies. What the site itself puts on
 * the clipboard is the key by definition, so no guess about its shape is needed. */
export async function copyWithSiteButton(page: Page, waitMs = 3_000): Promise<string | undefined> {
  const buttons = page.getByRole('button', { name: COPY_KEY_BUTTON }).locator('visible=true');
  try {
    if (!await buttons.count()) return undefined;
    const button = await secretOne(buttons);
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
    await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; });
    await button.click({ timeout: 3_000 });
  } catch { return undefined; }
  for (let waited = 0; waited < waitMs; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const found = plausibleCopy(await page.evaluate(() => (globalThis as unknown as Hooked).__clikcodeCopied).catch(() => undefined));
    if (found) {
      await page.evaluate(() => { (globalThis as unknown as Hooked).__clikcodeCopied = null; }).catch(() => undefined);
      return found;
    }
  }
  return undefined;
}
