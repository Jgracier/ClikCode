/** The "I'm not a robot" / "Verify you are human" checkbox. ClikCode's browser is the user's own Chrome on their own
 * connection, so most of these clear with the one press any visitor makes. That press is all `pressHumanCheck` does.
 * A puzzle that wants an answer is solved by `solveHumanCheck`: a picture of the challenge goes to the account's own
 * Gateway vision model, its answer is played back into the page at a visitor's pace -- jittered cursor paths, uneven
 * pauses between tiles, no two runs alike -- so the interaction reads as a person, not a script. This is ClikCode's
 * built-in captcha solving, the same capability other agents get from an external solving service, except nothing
 * leaves this machine but the puzzle's pixels. What it cannot read or answer still falls through to the managed cloud
 * browser or the user. */
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

// ── solving a puzzle ────────────────────────────────────────────────────────────────────────────────────────

/** The challenge frame of the widget whose checkbox was pressed: the visible puzzle frame, not the hidden one. */
async function findPuzzle(page: Page): Promise<{ widget: HumanCheckWidget; frame: Frame; box: Box } | undefined> {
  for (const frame of page.frames()) {
    if (!PUZZLE.test(frame.url())) continue;
    const box = await boxOf(frame);
    if (box && box.width >= 250 && box.height >= 200 && box.y > -50 && box.x > -50) return { widget: CHECKBOX.find(([, pattern]) => pattern.test(frame.url()))?.[0] ?? 'recaptcha', frame, box };
  }
  return undefined;
}

/** Where each tile of an N-tile grid sits inside the challenge frame: the grid fills the frame minus its edges,
 * so a tile's centre is found without knowing the site's exact markup. The grid does not fill the whole frame:
 * a reCAPTCHA challenge spends about 90px on its instruction header and about 60px on its button footer, so the
 * tile area is the frame minus those bands. */
const GRID_HEADER = 90, GRID_FOOTER = 60;
function tileCentres(box: Box, columns: number, rows: number): Array<{ x: number; x2: number; y: number; y2: number }> {
  const out: Array<{ x: number; x2: number; y: number; y2: number }> = [];
  const top = box.y + Math.min(GRID_HEADER, box.height * 0.2);
  const gridHeight = Math.max(box.height - GRID_HEADER - GRID_FOOTER, box.height * 0.5);
  const w = box.width / columns, h = gridHeight / rows;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    out.push({ x: box.x + column * w, x2: box.x + (column + 1) * w, y: top + row * h, y2: top + (row + 1) * h });
  }
  return out;
}

/** A move-and-click that reads like a person: the cursor wanders to the tile instead of teleporting, and every
 * pause is different. Two solves of the same page never produce the same mouse trail, which is what keeps
 * automation-blind widgets from noticing anything. */
async function visitorClick(mouse: Page['mouse'], at: { x: number; x2: number; y: number; y2: number }, random: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const tx = at.x + (at.x2 - at.x) * (0.35 + random() * 0.3), ty = at.y + (at.y2 - at.y) * (0.35 + random() * 0.3);
  await mouse.move(tx - (30 + random() * 60), ty - (10 + random() * 30));
  await mouse.move(tx + (random() - 0.5) * 24, ty + (random() - 0.5) * 16, { steps: 4 + Math.floor(random() * 5) });
  await mouse.move(tx, ty, { steps: 3 + Math.floor(random() * 4) });
  await sleep(80 + random() * 220);
  await mouse.down();
  await sleep(45 + random() * 90);
  await mouse.up();
  await sleep(120 + random() * 380);
}

export interface SolveDeps {
  sleep?: (ms: number) => Promise<void>;
  /** The vision ask; defaults to the account's Gateway model (captcha-model.ts). */
  ask?: (image: { mimeType: string; data: string }) => Promise<{ ok: true; answer: CaptchaAskAnswer } | { ok: false; error: string }>;
  /** Source of randomness for the human-like pacing; tests inject a fixed one. */
  random?: () => number;
  signal?: AbortSignal;
  waitMs?: number;
}

/** What the vision ask answers: which tiles match, or that it could not read the challenge. */
export type CaptchaAskAnswer = { tiles: number[] } | { unreadable: true };

/** Answer a shown puzzle: screenshot the challenge, ask the vision model which tiles match, click them like a
 * visitor would, then confirm. reCAPTCHA often asks several grids in one challenge ("select all buses" then more
 * buses), so rounds continue while the widget keeps asking; each round re-reads the grid, so a mid-challenge
 * instruction change is followed too. Resolves `cleared` when the page holds an accepted answer, else `still-there`
 * when the budget runs out. Never throws: an unsolvable puzzle is a result, not a failure. */
export async function solveHumanCheck(page: Page, deps: SolveDeps = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const ask = deps.ask ?? ((image) => import('./captcha-model.js').then(m => m.askCaptchaModel(image, { ...(deps.signal ? { signal: deps.signal } : {}) })));
  const budgetMs = deps.waitMs ?? 120_000;
  const began = Date.now();
  let firstWidget: HumanCheckWidget | undefined;
  let repressed = 0;
  while (Date.now() - began < budgetMs) {
    const found = await findPuzzle(page);
    if (!found) {
      // The challenge may have expired ("Verification challenge expired"): the checkbox is back and a visitor
      // presses it again. Up to three presses; the answer field says whether any of them was accepted.
      if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: firstWidget };
      if (await findCheckbox(page) && repressed < 3) {
        repressed++;
        await pressHumanCheck(page, { waitMs: 8_000 });
        await sleep(1_500);
        continue;
      }
      return { outcome: (await humanCheckAnswered(page)) ? 'cleared' : 'none', ...(firstWidget ? { widget: firstWidget } : {}) };
    }
    firstWidget ??= found.widget;
    if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: firstWidget };
    let bytes: Buffer;
    try { bytes = await (await found.frame.frameElement()).screenshot({ timeout: 10_000 }) as Buffer; }
    catch { return { outcome: 'still-there', widget: firstWidget }; }
    const reply = await ask({ mimeType: 'image/jpeg', data: bytes.toString('base64') });
    // An unreadable or empty answer is not a refusal: reCAPTCHA deliberately blurs and noises its grids.
    // Wait out the widget's own refresh and try the next round with a fresh screenshot.
    if (!reply.ok || 'unreadable' in reply.answer || !reply.answer.tiles.length) {
      await sleep(3_000);
      continue;
    }
    const tiles: number[] = reply.answer.tiles;
    // reCAPTCHA and hCaptcha grids are square (3x3 or 4x4); the count tells us which.
    const side = tiles.length <= 9 ? 3 : 4;
    const centres = tileCentres(found.box, side, side);
    for (const index of [...new Set(tiles)].sort((a: number, b: number) => a - b).slice(0, side * side)) {
      const at = centres[index];
      if (!at) continue;
      await visitorClick(page.mouse, at, random, sleep);
    }
    // Confirm inside the same frame, wherever the widget put its Verify/Next button.
    const confirm = { x: found.box.x + found.box.width * 0.5, x2: found.box.x + found.box.width, y: found.box.y + found.box.height * 0.85, y2: found.box.y + found.box.height };
    await visitorClick(page.mouse, confirm, random, sleep);
    for (let waited = 0; waited < 20_000; waited += 600) {
      await sleep(600);
      if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: firstWidget };
      const again = await findPuzzle(page);
      // No puzzle left and the page moved on: solved.
      if (!again && !await findCheckbox(page)) return { outcome: 'cleared', widget: firstWidget };
      // The widget asked again (a fresh grid, or the same one with more to pick): loop for another round
      // while the budget lasts. A short pause first: the widget is mid-refresh.
      if (again) { await sleep(1_500); break; }
    }
  }
  return (await humanCheckAnswered(page)) ? { outcome: 'cleared' } : { outcome: 'still-there', ...(firstWidget ? { widget: firstWidget } : {}) };
}
