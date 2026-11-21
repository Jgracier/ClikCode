/** What a [ref=eN] from a page view points at, for as long as that element is on the page.
 *
 * The browser keeps a reference on the element itself, but only answers for the references of the LAST read of the page, and a
 * read gives a reference only to what can be clicked at that moment. So a reference the agent was shown a call ago stops resolving
 * as soon as anything reads the page while a menu covers that element, or once the page redraws the element as a new node. Neither
 * means the control is gone. A reference is therefore resolved in three steps: as it is; after a fresh read (the same element gets
 * the same reference back); and, when the page drew a new node, by the role and name the agent was shown for it, if exactly one
 * visible element still answers to them. */
import type { Frame, Locator, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';

export const REF = /^(?:f\d+)?e\d+$/;

export interface RefName { role: string; name: string }

/** `- button "Save" [ref=e12]`, also inside the quotes YAML puts around a line with a colon in it. */
const REF_LINE = /^\s*- ('?)([a-z]+)(?: "((?:[^"\\]|\\.)*)")?[^\n]*\[ref=((?:f\d+)?e\d+)\]/;
const MAX_REMEMBERED = 6_000;

/** Every reference a page view shows, with the role and name shown beside it. */
export function refNames(snapshot: string): Map<string, RefName> {
  const found = new Map<string, RefName>();
  for (const line of snapshot.split('\n')) {
    const match = REF_LINE.exec(line);
    if (!match) continue;
    const name = (match[3] ?? '').replace(/\\(["\\])/g, '$1');
    found.set(match[4]!, { role: match[2]!, name: match[1] ? name.replace(/''/g, '\'') : name });
  }
  return found;
}

const remembered = sharedState('page-ref-names', () => new WeakMap<Page, Map<string, RefName>>());

/** Keep what this view called each reference. References are never reused within a tab, so views add up; the oldest go first. */
export function rememberRefs(page: Page, snapshot: string): void {
  const known = remembered.get(page) ?? new Map<string, RefName>();
  for (const [ref, named] of refNames(snapshot)) { known.delete(ref); known.set(ref, named); }
  for (const ref of known.keys()) { if (known.size <= MAX_REMEMBERED) break; known.delete(ref); }
  remembered.set(page, known);
}

export function rememberedRef(page: Page, ref: string): RefName | undefined { return remembered.get(page)?.get(ref); }

const present = async (locator: Locator): Promise<boolean> => (await locator.count().catch(() => 0)) > 0;

/** The element `ref` points at. Throws, saying what the reference was and what the page has now, when it is not there. */
export async function resolveRef(page: Page, ref: string): Promise<Locator> {
  const byRef = page.locator(`aria-ref=${ref}`);
  // A reference into a frame that has since navigated makes the browser throw instead of counting zero: the same fact.
  if (await present(byRef)) return byRef;
  await page.ariaSnapshot({ mode: 'ai', timeout: 8_000 } as never).catch(() => undefined);
  if (await present(byRef)) return byRef;
  const was = remembered.get(page)?.get(ref);
  let matches = 0;
  if (was?.name && was.role !== 'generic' && was.role !== 'text') {
    const scopes: Array<Page | Frame> = [page, ...page.frames().filter(frame => frame !== page.mainFrame() && frame.url() && frame.url() !== 'about:blank')];
    let only: Locator | undefined;
    for (const scope of scopes) {
      const same = scope.getByRole(was.role as never, { name: was.name, exact: true }).locator('visible=true');
      const count = await same.count().catch(() => 0);
      if (count) { matches += count; only = same.first(); }
    }
    if (matches === 1 && only) return only;
  }
  const what = was?.name ? ` It was the ${was.role} "${was.name}"${matches > 1 ? `, and ${matches} elements answer to that now` : ', which the page no longer shows'}.` : '';
  throw new Error(`Nothing on the page has the reference ${ref} now: the page removed or replaced that element after it was read.${what} Observe the page again, or name the control by its visible text.`);
}
