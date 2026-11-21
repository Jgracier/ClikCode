/** Picking one option of a dropdown, whatever the page built it from.
 *
 * A <select> takes the option directly. Anything else is opened, the option is looked for among what the list shows (an option or
 * menu item anywhere; inside the open list also a button, checkbox, radio, link or plain text, which is what many design systems
 * draw their options with), the list's search box is used only when the option is not already there, and the option is clicked.
 * It never presses Enter on a guess: when no option says the text, it says so and names what the list offers, with the list left
 * open and unfiltered. The result says what was picked and what the control shows afterwards. */
import type { Frame, Locator, Page } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';

/** Roles that are an option wherever they are. */
const OPTION_ROLES = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'] as const;
/** Roles that are an option only inside an open list: outside one, a button that says "Pro" is just a button. */
const LISTED_ROLES = ['button', 'checkbox', 'radio', 'link'] as const;
const OPEN_LIST = '[role=listbox], [role=menu], [role=tree], [role=dialog], [role=alertdialog], [aria-modal=true], dialog[open], [popover]';
const SOUGHT_MS = 1_500;

const scopesOf = (page: Page): Array<Page | Frame> => [page, ...page.frames().filter(frame => frame !== page.mainFrame() && frame.url() && frame.url() !== 'about:blank')];
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The option's own element, not the control that opened the list (which may show the same words once a value is chosen). */
async function notTheControl(candidate: Locator, control: Locator): Promise<boolean> {
  const handle = await control.elementHandle({ timeout: 1_500 }).catch(() => null);
  if (!handle) return true;
  try { return !(await candidate.evaluate((node, other) => node === other || (node as unknown as { contains(n: unknown): boolean }).contains(other) || (other as unknown as { contains(n: unknown): boolean }).contains(node), handle, { timeout: 1_500 })); }
  catch { return false; }
  finally { await handle.dispose().catch(quiet('agent/computer/page-choose')); }
}

/** The visible option that says `text`: by its exact name first; a looser match only when exactly one option fits it. */
async function findOption(page: Page, control: Locator, text: string): Promise<Locator | undefined> {
  const loose = new RegExp(escaped(text), 'i');
  for (const exact of [true, false]) {
    const name = exact ? text : loose;
    for (const scope of scopesOf(page)) {
      const listed = scope.locator(OPEN_LIST);
      const candidates = [
        ...OPTION_ROLES.map(role => scope.getByRole(role, { name, exact })),
        ...LISTED_ROLES.map(role => listed.getByRole(role, { name, exact })),
        listed.getByText(name, { exact }),
      ];
      for (const candidate of candidates) {
        const visible = candidate.locator('visible=true');
        const count = await visible.count().catch(() => 0);
        if (!count || (!exact && count !== 1)) continue;
        for (let at = 0; at < Math.min(count, 4); at++) if (await notTheControl(visible.nth(at), control)) return visible.nth(at);
      }
    }
  }
  return undefined;
}

async function soughtOption(page: Page, control: Locator, text: string, ms = SOUGHT_MS): Promise<Locator | undefined> {
  for (const until = Date.now() + ms; ;) {
    const option = await findOption(page, control, text);
    if (option || Date.now() >= until) return option;
    await page.waitForTimeout(120);
  }
}

/** Whether the keyboard is in a box that takes text (a list's search box), so typing narrows the list instead of going nowhere. */
const inTextBox = (page: Page): Promise<boolean> => page.evaluate(() => {
  const active = (globalThis as unknown as { document: { activeElement: { tagName: string; type?: string; readOnly?: boolean; isContentEditable?: boolean } | null } }).document.activeElement;
  if (!active) return false;
  if (active.isContentEditable) return true;
  if (active.tagName === 'TEXTAREA') return !active.readOnly;
  return active.tagName === 'INPUT' && !active.readOnly && /^(?:text|search|email|tel|url|)$/.test((active.type ?? '').toLowerCase());
}).catch(() => false);

/** A few of the options the open list shows, for the message when the wanted one is not among them. */
async function offered(page: Page, limit = 12): Promise<string[]> {
  const names: string[] = [];
  const take = async (found: Locator): Promise<void> => {
    for (const raw of await found.locator('visible=true').allInnerTexts().catch(() => [] as string[])) {
      const name = raw.replace(/\s+/g, ' ').trim();
      if (name && name.length <= 80 && !names.includes(name)) names.push(name);
      if (names.length >= limit + 1) return;
    }
  };
  for (const scope of scopesOf(page)) {
    for (const role of OPTION_ROLES) if (names.length <= limit) await take(scope.getByRole(role));
    for (const role of LISTED_ROLES) if (!names.length) await take(scope.locator(OPEN_LIST).getByRole(role));
  }
  return names;
}

const shownIn = (control: Locator): Promise<string> => control.evaluate(node => {
  const el = node as unknown as { value?: unknown; innerText?: string };
  return (typeof el.value === 'string' && el.value ? el.value : el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}, undefined, { timeout: 1_500 }).catch(() => '');

/** Choose `text` in the dropdown `control`. `open` clicks the control the way every other click is made. */
export async function chooseOption(page: Page, control: Locator, text: string, open: (control: Locator) => Promise<void>): Promise<string> {
  if (await control.evaluate(element => (element as unknown as { tagName: string }).tagName, undefined, { timeout: 3_000 }).catch(() => '') === 'SELECT') {
    await control.selectOption({ label: text }, { timeout: 10_000 }).catch(() => control.selectOption(text, { timeout: 10_000 }));
    return `Chose "${text}".`;
  }
  if (await control.getAttribute('aria-expanded', { timeout: 1_500 }).catch(() => null) !== 'true') await open(control);
  let option = await soughtOption(page, control, text);
  let typed = false;
  if (!option && await inTextBox(page)) {
    // The list is longer than what it draws (it loads or filters as one types): narrow it with its own search box.
    await page.keyboard.insertText(text);
    typed = true;
    option = await soughtOption(page, control, text, 2_500);
  }
  if (!option) {
    // Nothing was chosen, so the list is put back as it was: all of it showing, for the next try.
    if (typed) { await page.keyboard.press('ControlOrMeta+a').catch(quiet('agent/computer/page-choose')); await page.keyboard.press('Backspace').catch(quiet('agent/computer/page-choose')); await page.waitForTimeout(200); }
    const names = await offered(page);
    const list = names.length ? ` The list offers: ${names.slice(0, 12).map(name => `"${name}"`).join(', ')}${names.length > 12 ? ', and more' : ''}.` : ' No list of options opened: this may be a plain text box (use fill), or it opens some other way (click it and observe).';
    throw new Error(`No option says "${text}", so nothing was chosen.${list}`);
  }
  const picked = (await option.innerText({ timeout: 1_500 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 80) || text;
  await option.click({ timeout: 5_000 });
  await page.waitForTimeout(150);
  const shown = await shownIn(control);
  return `Chose "${picked}"${shown ? `; the control now shows "${shown}"` : ''}.`;
}
