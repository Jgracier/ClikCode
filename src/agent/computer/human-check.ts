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

/** A challenge frame that is shown. A hidden one is parked thousands of pixels off the page; a shown one can still
 * hang partly above a small window (hCaptcha centres its challenge on the checkbox), so any real overlap counts. */
const shownPuzzleBox = (box: Box | undefined): box is Box => !!box && box.width >= 250 && box.height >= 200 && box.y > -1500 && box.x > -1500 && box.y + box.height > 60 && box.x + box.width > 60;

/** A challenge that wants an answer is on screen. */
async function puzzleShown(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (PUZZLE.test(frame.url()) && shownPuzzleBox(await boxOf(frame))) return true;
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
    if (shownPuzzleBox(box)) return { widget: /hcaptcha/i.test(frame.url()) ? 'hcaptcha' : 'recaptcha', frame, box };
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
  /** The whole-grid vision ask, used only when the challenge's layout cannot be read; defaults to the Gateway model. */
  ask?: (image: { mimeType: string; data: string }) => Promise<{ ok: true; answer: CaptchaAskAnswer } | { ok: false; error: string }>;
  /** The where-to-click ask for free-form challenges; defaults to the Gateway model (captcha-model.ts askClickPoints). */
  askPoints?: (image: { mimeType: string; data: string }, instruction: string) => Promise<Array<{ x: number; y: number }> | undefined>;
  /** The one-square ask; defaults to the Gateway model (captcha-model.ts askTileMatch). */
  askTile?: (question: import('./captcha-model.js').TileQuestion) => Promise<boolean | undefined>;
  /** Source of randomness for the human-like pacing; tests inject a fixed one. */
  random?: () => number;
  signal?: AbortSignal;
  waitMs?: number;
  /** One line per round (instruction, squares picked, what the widget said after Verify), for logs and diagnosis. */
  trace?: (line: string) => void;
}

/** What the vision ask answers: which tiles match, or that it could not read the challenge. */
export type CaptchaAskAnswer = { tiles: number[] } | { unreadable: true };

/** A challenge as the widget itself lays it out: the instruction, the target word, each square's place on the page
 * (frame offset added), a key per square that changes when the widget swaps its picture, and the confirm button. */
interface PuzzleLayout { instruction: string; target: string; tiles: Array<Box & { key: string; selected: boolean }>; verify?: Box; dynamic: boolean; tileSelector: string }

/** Runs inside the challenge frame (a string: this project has no DOM types). Returns the layout or null. */
const READ_LAYOUT = `(() => {
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
  const recaptcha = Array.from(document.querySelectorAll('td.rc-imageselect-tile'));
  if (recaptcha.length) {
    const desc = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical');
    const instruction = clean(desc && desc.innerText);
    const strong = desc && desc.querySelector('strong');
    const verify = document.querySelector('#recaptcha-verify-button');
    return {
      instruction, target: clean(strong && strong.textContent) || instruction,
      tiles: recaptcha.map(td => { const img = td.querySelector('img'); return Object.assign(rect(td), { key: (img ? img.src + '|' + img.style.top + '|' + img.style.left : ''), selected: td.classList.contains('rc-imageselect-tileselected') }); }),
      verify: verify ? rect(verify) : undefined, dynamic: /none left/i.test(instruction), tileSelector: 'td.rc-imageselect-tile',
    };
  }
  const hcaptcha = Array.from(document.querySelectorAll('.task-image'));
  if (hcaptcha.length) {
    const prompt = document.querySelector('.prompt-text');
    const instruction = clean(prompt && prompt.innerText);
    const verify = document.querySelector('.button-submit');
    return {
      instruction, target: instruction.replace(/^please (?:click|select)(?: on)?(?: each| all)?(?: images?| squares?)?(?: containing| with| of)?\\s*/i, '') || instruction,
      tiles: hcaptcha.map((tile, index) => { const image = tile.querySelector('.image'); return Object.assign(rect(tile), { key: index + '|' + (image ? image.style.background : ''), selected: tile.getAttribute('aria-pressed') === 'true' }); }),
      verify: verify ? rect(verify) : undefined, dynamic: false, tileSelector: '.task-image',
    };
  }
  return null;
})()`;

async function readLayout(frame: Frame, box: Box): Promise<PuzzleLayout | undefined> {
  try {
    const read = await frame.evaluate(READ_LAYOUT) as (Omit<PuzzleLayout, 'verify'> & { verify?: Box }) | null;
    if (!read || !read.tiles.length) return undefined;
    const shift = <T extends Box>(b: T): T => ({ ...b, x: b.x + box.x, y: b.y + box.y });
    return { ...read, tiles: read.tiles.map(shift), ...(read.verify ? { verify: shift(read.verify) } : {}) };
  } catch { return undefined; }
}

const toTarget = (b: Box) => ({ x: b.x, x2: b.x + b.width, y: b.y, y2: b.y + b.height });

/** Outline one square in red inside the challenge, take a picture of the whole challenge, take the outline away. */
async function outlinedShot(frame: Frame, layout: PuzzleLayout, index: number): Promise<Buffer | undefined> {
  const mark = `(() => { const tile = document.querySelectorAll(${JSON.stringify(layout.tileSelector)})[${index}]; if (!tile) return false;
    const r = tile.getBoundingClientRect(); const box = document.createElement('div'); box.id = 'clikcode-outline';
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:4px solid #ff0000;box-sizing:border-box;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    document.body.appendChild(box); return true; })()`;
  const unmark = `(() => { const box = document.getElementById('clikcode-outline'); if (box) box.remove(); })()`;
  try {
    if (!await frame.evaluate(mark)) return undefined;
    return await (await frame.frameElement()).screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }) as Buffer;
  } catch { return undefined; }
  finally { await frame.evaluate(unmark).catch(() => undefined); }
}

/** Ask about each listed square and return the indices that hold the target. The pictures are taken one after
 * another (the outline is shared page state); the asks then run together. */
async function matchingTiles(frame: Frame, layout: PuzzleLayout, indices: number[], askTile: NonNullable<SolveDeps['askTile']>, timing: { shotsMs: number; asksMs: number } = { shotsMs: 0, asksMs: 0 }): Promise<number[]> {
  const size = Math.round(Math.sqrt(layout.tiles.length)) || 3;
  const shots: Array<[number, Buffer]> = [];
  let at = Date.now();
  for (const index of indices) { const shot = await outlinedShot(frame, layout, index); if (shot) shots.push([index, shot]); }
  timing.shotsMs = Date.now() - at; at = Date.now();
  const answers = await Promise.all(shots.map(async ([index, shot]) => {
    const yes = await askTile({ image: { mimeType: 'image/jpeg', data: shot.toString('base64') }, instruction: layout.instruction, target: layout.target, size }).catch(() => undefined);
    return yes ? index : -1;
  }));
  timing.asksMs = Date.now() - at;
  return answers.filter(index => index >= 0);
}

/** Make room for a challenge that hangs off a small window: the tab's viewport grows to hold the whole frame (only
 * this tab, and only when needed). Says whether it changed anything, so the caller re-reads the moved frame. */
async function fitPuzzle(page: Page, box: Box): Promise<boolean> {
  try {
    const [width, height] = await page.evaluate('[innerWidth, innerHeight]') as [number, number];
    if (box.y >= 0 && box.x >= 0 && box.y + box.height <= height && box.x + box.width <= width) return false;
    const want = { width: Math.max(width, Math.ceil(box.width + 80)), height: Math.max(height, Math.ceil(box.height + 120)) };
    if (want.width === width && want.height === height) return false;
    await page.setViewportSize(want);
    return true;
  } catch { return false; }
}

/** Answer a shown puzzle the way a person does. The challenge's own layout is read from the page (instruction,
 * target, every square's position, the Verify button), each square is asked about on its own -- far more reliable
 * than asking for a list of indices over the whole grid -- and the matches are clicked at a visitor's pace. A
 * "click until none are left" grid swaps in new pictures where it was clicked; those are asked about again until
 * none match. Rounds continue while the widget keeps asking (reCAPTCHA often serves several grids), an expired
 * challenge is pressed again, and when the layout cannot be read the whole picture is asked about instead.
 * Resolves `cleared` when the page holds an accepted answer, else `still-there` when the budget runs out. Never throws. */
export async function solveHumanCheck(page: Page, deps: SolveDeps = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const signal = deps.signal ? { signal: deps.signal } : {};
  const ask = deps.ask ?? ((image) => import('./captcha-model.js').then(m => m.askCaptchaModel(image, signal)));
  const askTile = deps.askTile ?? ((question) => import('./captcha-model.js').then(m => m.askTileMatch(question, signal)));
  const askPoints = deps.askPoints ?? ((image, instruction) => import('./captcha-model.js').then(m => m.askClickPoints(image, instruction, signal)));
  const budgetMs = deps.waitMs ?? 180_000;
  const began = Date.now();
  let firstWidget: HumanCheckWidget | undefined;
  let repressed = 0;
  let refreshed = 0;
  while (Date.now() - began < budgetMs) {
    if (deps.signal?.aborted) break;
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
    // Every square must be on screen to be clicked: a challenge taller than a small window is given room first.
    if (await fitPuzzle(page, found.box)) { await sleep(800); continue; }
    let bytes: Buffer;
    try { bytes = await (await found.frame.frameElement()).screenshot({ type: 'jpeg', quality: 85, timeout: 10_000 }) as Buffer; }
    catch { return { outcome: 'still-there', widget: firstWidget }; }
    const grid = { mimeType: 'image/jpeg', data: bytes.toString('base64') };
    let confirm: { x: number; x2: number; y: number; y2: number };
    const layout = await readLayout(found.frame, found.box);
    if (layout) {
      // Squares already selected (a half-finished round) are left as they are; only the others are asked about.
      let pending = layout.tiles.map((tile, index) => tile.selected ? -1 : index).filter(index => index >= 0);
      let current = layout;
      for (let pass = 0; pass < 6 && pending.length; pass++) {
        const timing = { shotsMs: 0, asksMs: 0 };
        const hits = await matchingTiles(found.frame, current, pending, askTile, timing);
        deps.trace?.(`${current.tiles.length} squares, "${current.instruction}" pass ${pass + 1}: asked ${pending.length}, picked [${hits.join(',')}] (pictures ${Math.round(timing.shotsMs / 100) / 10}s, answers ${Math.round(timing.asksMs / 100) / 10}s)`);
        for (const index of hits) { const at = current.tiles[index]; if (at) await visitorClick(page.mouse, toTarget(at), random, sleep); }
        if (!current.dynamic || !hits.length) break;
        // A dynamic grid fades a new picture into each clicked square; ask only about the squares that changed.
        await sleep(3_500 + random() * 1_000);
        const next = await readLayout(found.frame, found.box);
        if (!next) break;
        pending = hits.filter(index => next.tiles[index] && next.tiles[index]!.key !== current.tiles[index]?.key);
        current = next;
      }
      const verify = (await readLayout(found.frame, found.box))?.verify ?? layout.verify;
      confirm = verify ? toTarget(verify) : { x: found.box.x + found.box.width * 0.7, x2: found.box.x + found.box.width * 0.95, y: found.box.y + found.box.height - 50, y2: found.box.y + found.box.height - 15 };
    } else if (found.widget === 'hcaptcha') {
      // hCaptcha draws most challenges on a canvas: a grid of pictures, or one picture to click a spot on. A visitor
      // clicks where the answer is, so the model is asked where; a drag puzzle (or one it cannot place) is swapped
      // for another challenge, up to five times, before this check is left to a person.
      const instruction = String(await found.frame.evaluate(`((document.querySelector('.prompt-text') || {}).innerText || '').replace(/\\s+/g, ' ').trim()`).catch(() => ''));
      const points = instruction && !/\bdrag\b/i.test(instruction) ? await askPoints(grid, instruction) : undefined;
      if (points?.length) {
        deps.trace?.(`"${instruction}": clicking ${points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
        for (const p of points.slice(0, 9)) {
          const x = found.box.x + p.x * found.box.width, y = found.box.y + p.y * found.box.height;
          await visitorClick(page.mouse, { x: x - 4, x2: x + 4, y: y - 4, y2: y + 4 }, random, sleep);
        }
        const submit = await found.frame.evaluate(`(() => { const b = document.querySelector('.button-submit'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
        confirm = submit ? toTarget({ ...submit, x: submit.x + found.box.x, y: submit.y + found.box.y }) : { x: found.box.x + found.box.width * 0.8, x2: found.box.x + found.box.width * 0.95, y: found.box.y + found.box.height - 50, y2: found.box.y + found.box.height - 20 };
      } else {
        if (refreshed >= 5) return { outcome: 'still-there', widget: firstWidget };
        refreshed++;
        deps.trace?.(`"${instruction}": no spot to click, asking for another challenge`);
        const refresh = await found.frame.evaluate(`(() => { const b = document.querySelector('.refresh.button, .refresh'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
        if (!refresh) return { outcome: 'still-there', widget: firstWidget };
        await visitorClick(page.mouse, toTarget({ ...refresh, x: refresh.x + found.box.x, y: refresh.y + found.box.y }), random, sleep);
        await sleep(2_500);
        continue;
      }
    } else {
      const reply = await ask(grid);
      // An unreadable or empty answer is not a refusal: reCAPTCHA deliberately blurs and noises its grids.
      // Wait out the widget's own refresh and try the next round with a fresh screenshot.
      if (!reply.ok || 'unreadable' in reply.answer || !reply.answer.tiles.length) { await sleep(3_000); continue; }
      const tiles: number[] = reply.answer.tiles;
      const side = Math.max(...tiles) >= 9 ? 4 : 3;
      const centres = tileCentres(found.box, side, side);
      for (const index of [...new Set(tiles)].sort((a: number, b: number) => a - b).slice(0, side * side)) {
        const at = centres[index];
        if (at) await visitorClick(page.mouse, at, random, sleep);
      }
      confirm = { x: found.box.x + found.box.width * 0.5, x2: found.box.x + found.box.width, y: found.box.y + found.box.height * 0.85, y2: found.box.y + found.box.height };
    }
    await visitorClick(page.mouse, confirm, random, sleep);
    for (let waited = 0; waited < 20_000; waited += 600) {
      await sleep(600);
      if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: firstWidget };
      const again = await findPuzzle(page);
      // No puzzle left and the page moved on: solved.
      if (!again && !await findCheckbox(page)) return { outcome: 'cleared', widget: firstWidget };
      // The widget asked again (a fresh grid, or "please also check the new images"): another round.
      if (again) {
        if (deps.trace) {
          const said = await Promise.resolve().then(() => again.frame.evaluate(`(() => Array.from(document.querySelectorAll('[class*="rc-imageselect-error"], .rc-imageselect-incorrect-response')).filter(el => el.offsetParent !== null).map(el => el.innerText.trim()).join(' | '))()`)).catch(() => '');
          deps.trace(`after verify: ${String(said) || 'a new challenge'}`);
        }
        await sleep(1_500);
        break;
      }
    }
  }
  return (await humanCheckAnswered(page)) ? { outcome: 'cleared' } : { outcome: 'still-there', ...(firstWidget ? { widget: firstWidget } : {}) };
}
