/** The "I'm not a robot" / "Verify you are human" checkbox. ClikCode's browser is the user's own Chrome on their own
 * connection, so most of these clear with the one press any visitor makes. That press is all this does: it never answers an
 * image, audio or text puzzle. A puzzle, or a box that will not clear, is for the managed cloud browser or the user. */
import type { Frame, Page } from 'playwright-core';
import { sleep as realSleep } from '../../runtime/sleep.js';

export type HumanCheckWidget = 'recaptcha' | 'turnstile' | 'hcaptcha';
export interface HumanCheckResult {
  /** cleared: the check accepted the press. puzzle: it asked for more than a press. still-there: pressed, nothing changed. none: no checkbox on the page. */
  outcome: 'cleared' | 'puzzle' | 'still-there' | 'none';
  widget?: HumanCheckWidget;
}

const CHECKBOX: Array<[HumanCheckWidget, RegExp]> = [
  ['recaptcha', /recaptcha\/(?:api2|enterprise)\/anchor/i],
  ['hcaptcha', /hcaptcha\.com\/.*frame=checkbox/i],
  ['turnstile', /challenges\.cloudflare\.com\//i],
];
const PUZZLE = /recaptcha\/(?:api2|enterprise)\/bframe|hcaptcha\.com\/.*frame=challenge|arkoselabs|funcaptcha/i;

type Box = { x: number; y: number; width: number; height: number };
async function boxOf(frame: Frame): Promise<Box | undefined> {
  try { return (await (await frame.frameElement()).boundingBox()) ?? undefined; }
  catch { return undefined; }
}

/** The checkbox widget on the page: a frame of checkbox size (a puzzle is far taller). */
async function findCheckbox(page: Page): Promise<{ widget: HumanCheckWidget; box: Box } | undefined> {
  for (const frame of page.frames()) {
    const kind = CHECKBOX.find(([, pattern]) => pattern.test(frame.url()));
    if (!kind) continue;
    const box = await boxOf(frame);
    if (box && box.width >= 100 && box.height >= 40 && box.height <= 150 && box.y >= 0) return { widget: kind[0], box };
  }
  return undefined;
}

/** A challenge that wants an answer is on screen (a hidden one sits far off the page). */
async function puzzleShown(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (!PUZZLE.test(frame.url())) continue;
    const box = await boxOf(frame);
    if (box && box.width >= 250 && box.height >= 250 && box.y > -50 && box.x > -50) return true;
  }
  return false;
}

/** The page holds an accepted answer (the hidden field each widget fills in once it is satisfied). */
export async function humanCheckAnswered(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
    return Array.from(doc.querySelectorAll('#g-recaptcha-response, [name="g-recaptcha-response"], [name="cf-turnstile-response"], [name="h-captcha-response"]')).some(field => (field.value ?? '').length > 20);
  }).catch(() => false);
}

export async function pressHumanCheck(page: Page, deps: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  if (await puzzleShown(page)) return { outcome: 'puzzle' };
  const found = await findCheckbox(page);
  if (!found) return { outcome: 'none' };
  if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: found.widget };
  const startUrl = page.url();
  const x = found.box.x + Math.min(30, found.box.width * 0.15), y = found.box.y + found.box.height / 2;
  await page.mouse.move(x - 40, y - 12);
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.click(x, y);
  for (let waited = 0; waited < (deps.waitMs ?? 12_000); waited += 500) {
    await sleep(500);
    if (await puzzleShown(page)) return { outcome: 'puzzle', widget: found.widget };
    if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: found.widget };
    // A whole-page check ("Just a moment…") has no answer field: it lets the visitor through by moving on or removing itself.
    if (page.url() !== startUrl || !await findCheckbox(page)) return { outcome: 'cleared', widget: found.widget };
  }
  return { outcome: 'still-there', widget: found.widget };
}
