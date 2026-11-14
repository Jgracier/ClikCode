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

export type HumanCheckWidget = 'recaptcha' | 'turnstile' | 'hcaptcha' | 'text' | 'slider';
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
    // Invisible reCAPTCHA shows only its "protected by" badge, which is checkbox-sized but has nothing to press.
    if (!kind || /[?&]size=invisible/.test(frame.url())) continue;
    const box = await boxOf(frame);
    if (!box || box.width < 100 || box.height < 40 || box.height > 150 || box.y < 0) continue;
    // Only a box a visitor can see and reach counts: not one inside a closed form, under a banner, or below the fold.
    const reachable = await frame.frameElement().then(el => el.evaluate((node: unknown) => {
      const g = globalThis as unknown as { innerHeight: number; innerWidth: number; document: { elementFromPoint(x: number, y: number): unknown } };
      const el = node as { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; contains(other: unknown): boolean; scrollIntoView(options: unknown): void };
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(30, r.width / 2), y = r.top + r.height / 2;
      if (y > g.innerHeight || x > g.innerWidth) { el.scrollIntoView({ block: 'center' }); return 'scrolled'; }
      const hit = g.document.elementFromPoint(x, y);
      if (hit === node || el.contains(hit)) return 'yes';
      // A widget inside a shadow root (Turnstile) is reported as its host element.
      let root = (node as { getRootNode(): { host?: { contains(other: unknown): boolean; getRootNode(): unknown } } }).getRootNode();
      while (root.host) { if (root.host === hit || root.host.contains(hit)) return 'yes'; root = root.host.getRootNode() as typeof root; }
      return 'no';
    })).catch(() => 'yes');
    if (reachable === 'no') continue;
    if (reachable === 'scrolled') { const moved = await boxOf(frame); if (moved) return { widget: kind[0], box: moved }; }
    return { widget: kind[0], box };
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
    const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<{ value?: string; getBoundingClientRect?(): { width: number } }> } }).document;
    if (Array.from(doc.querySelectorAll('#g-recaptcha-response, [name="g-recaptcha-response"], [name="cf-turnstile-response"], [name="h-captcha-response"], [name="lot_number"], [name="geetest_validate"]')).some(field => (field.value ?? '').length > 8)) return true;
    // GeeTest shows its success state on its own button instead of filling a field the page can see at once.
    return Array.from(doc.querySelectorAll('[class*="geetest_lock_success"], [class*="geetest_success_radar"], [class*="geetest_btn_click"][class*="geetest_success"]')).some(el => (el.getBoundingClientRect?.().width ?? 0) > 0);
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
  askPoints?: (images: Array<{ mimeType: string; data: string }>, instruction: string) => Promise<Array<{ x: number; y: number }> | undefined>;
  /** Go to reCAPTCHA's audio challenge straight away instead of after two picture rounds. */
  audioFirst?: boolean;
  /** Speech-to-text for an audio challenge clip; defaults to the Gateway (captcha-model.ts askTranscript). */
  transcribe?: (audio: Buffer, mimeType: string) => Promise<string | undefined>;
  /** Reads a "type what you see" captcha picture; defaults to the Gateway model (captcha-model.ts askCaptchaText). */
  askText?: (image: { mimeType: string; data: string }) => Promise<string | undefined>;
  /** Where to drag on a drag puzzle; defaults to the Gateway model (captcha-model.ts askDrag). */
  askDrag?: (image: { mimeType: string; data: string }, instruction: string) => Promise<import('./captcha-model.js').DragAnswer | undefined>;
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

/** A drag like a hand makes it: press on the piece, set off slowly, speed up, overshoot a little, settle back,
 * pause, let go. The path wobbles vertically and is never the same twice. */
async function visitorDrag(mouse: Page['mouse'], from: { x: number; y: number }, to: { x: number; y: number }, random: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  await mouse.move(from.x - 20 - random() * 30, from.y + (random() - 0.5) * 20);
  await mouse.move(from.x, from.y, { steps: 5 + Math.floor(random() * 4) });
  await sleep(120 + random() * 200);
  await mouse.down();
  await sleep(90 + random() * 150);
  const overshoot = 3 + random() * 6, dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const steps = 18 + Math.floor(random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const reach = ease * (1 + overshoot / len);
    await mouse.move(from.x + dx * reach, from.y + dy * reach + Math.sin(t * Math.PI) * (random() - 0.5) * 6);
    await sleep(8 + random() * 22);
  }
  await mouse.move(to.x + (random() - 0.5) * 2, to.y + (random() - 0.5) * 2, { steps: 4 });
  await sleep(150 + random() * 250);
  await mouse.up();
}

/** A slider check drawn in the page itself (GeeTest, Alibaba's "slide to verify", similar): a handle on a track,
 * usually under a picture with a gap. The model says where the handle is and where the piece fits; the handle is
 * dragged that far along its track. A plain "slide to the end" track is dragged to its end. */
async function solveSlider(page: Page, askDrag: (image: { mimeType: string; data: string }, instruction: string) => Promise<import('./captcha-model.js').DragAnswer | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void, pressedTrigger = false, askPoints?: (images: Array<{ mimeType: string; data: string }>, instruction: string) => Promise<Array<{ x: number; y: number }> | undefined>): Promise<boolean> {
  const found = await page.evaluate(`(() => {
    const seen = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
    const handle = Array.from(document.querySelectorAll('.geetest_btn, .geetest_slider_button, .geetest_slider_button_new, .btn_slide, .nc_iconfont.btn_slide, [class*="slider"][class*="btn"], [class*="slider"][class*="handle"], [class*="slide"][class*="button"], [class*="captcha"][class*="slider"] [role="slider"]')).find(seen);
    if (!handle) return null;
    const box = handle.closest('.geetest_box, .geetest_panel_box, .geetest_widget, .geetest_holder, .nc-container, [class*="captcha"], [class*="verify"]') || handle.parentElement;
    const track = handle.parentElement;
    const r = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    box.setAttribute('data-clikcode-slider', '1');
    const text = (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    const picture = !!box.querySelector('canvas, img, [class*="bg"]');
    return { handle: r(handle), track: r(track), box: r(box), text, picture };
  })()`).catch(() => null) as { handle: Box; track: Box; box: Box; text: string; picture: boolean } | null;
  if (!found) {
    // A slider check often starts as a button ("Click to verify"); press it once and look again.
    const trigger = await page.evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('[class*="geetest_btn_click"], .geetest_radar_tip, .geetest_radar_btn, .nc_iconfont.btn_slide')).find(e => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight; });
      if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`).catch(() => null) as Box | null;
    if (!trigger || pressedTrigger) return askPoints ? solveInPageBox(page, askPoints, random, sleep, trace) : false;
    trace?.('slider check: pressing its button');
    await visitorClick(page.mouse, toTarget(trigger), random, sleep);
    await sleep(3_000);
    return solveSlider(page, askDrag, random, sleep, trace, true, askPoints);
  }
  const start = { x: found.handle.x + found.handle.width / 2, y: found.handle.y + found.handle.height / 2 };
  let distance = found.track.x + found.track.width - found.handle.width / 2 - start.x;
  if (found.picture) {
    let shot: Buffer;
    try { shot = await page.locator('[data-clikcode-slider="1"]').first().screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }); } catch { return false; }
    const answer = await askDrag({ mimeType: 'image/jpeg', data: shot.toString('base64') }, found.text || 'Drag the slider so the piece fits into its gap');
    if (!answer) return false;
    distance = (answer.to.x - answer.from.x) * found.box.width;
  }
  if (!(distance > 4)) return false;
  trace?.(`slider ("${found.text}"): dragging ${Math.round(distance)}px`);
  await visitorDrag(page.mouse, start, { x: start.x + distance, y: start.y }, random, sleep);
  return true;
}

/** GeeTest's "select N images with <example>": a 3x3 drawing and a small example picture. The example is taken at
 * its full size, each square is cut out and compared with it by the voting models, and the N best are clicked. */
async function solveGeetestMatch(page: Page, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const info = await page.evaluate(`(() => {
    const ex = document.querySelector('[class*="geetest_ques_tips"] img');
    const grid = Array.from(document.querySelectorAll('[class*="geetest_svg_item"], [class*="geetest_subitem"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 150 && r.height > 150; });
    const tips = document.querySelector('[class*="geetest_text_tips"]');
    if (!ex || !grid) return null;
    const r = grid.getBoundingClientRect();
    return { src: ex.src, grid: { x: r.x, y: r.y, width: r.width, height: r.height }, text: tips ? tips.textContent.trim() : '' };
  })()`).catch(() => null) as { src: string; grid: Box; text: string } | null;
  if (!info) return false;
  let example: Buffer | undefined;
  try {
    if (info.src.startsWith('data:')) example = Buffer.from(info.src.slice(info.src.indexOf(',') + 1), 'base64');
    else { const res = await page.request.get(info.src, { timeout: 10_000 }); if (res.ok()) example = await res.body(); }
  } catch { example = undefined; }
  if (!example) return false;
  const mime = /\.png(?:$|\?)/i.test(info.src) || example[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const want = Math.max(1, Number(/select\s+(\d+)/i.exec(info.text)?.[1] ?? 1));
  const { askSameAsExample } = await import('./captcha-model.js');
  const w = info.grid.width / 3, h = info.grid.height / 3;
  const cells = Array.from({ length: 9 }, (_, i) => ({ x: info.grid.x + (i % 3) * w, y: info.grid.y + Math.floor(i / 3) * h, width: w, height: h }));
  const shots = await Promise.all(cells.map(cell => page.screenshot({ type: 'png', clip: { x: cell.x + 3, y: cell.y + 3, width: cell.width - 6, height: cell.height - 6 }, timeout: 8_000 }).catch(() => undefined)));
  const scores = await Promise.all(shots.map(shot => shot ? askSameAsExample({ mimeType: mime, data: example!.toString('base64') }, { mimeType: 'image/png', data: shot.toString('base64') }) : Promise.resolve(undefined)));
  const ranked = scores.map((score, index) => ({ index, score: score ?? 0 })).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, want);
  if (!ranked.length) { trace?.(`GeeTest match ("${info.text}"): nothing matched the example`); return false; }
  trace?.(`GeeTest match ("${info.text}"): clicking ${ranked.map(c => `${c.index}(${c.score.toFixed(2)})`).join(' ')}`);
  for (const { index } of ranked) await visitorClick(page.mouse, toTarget(cells[index]!), random, sleep);
  return true;
}

/** A challenge drawn in the page itself with no slider (GeeTest's "select the image that matches", icon order,
 * nine-square): a picture of the challenge box goes to the voting models, the spots they agree on are clicked,
 * then the box's own confirm button if it has one. */
async function solveInPageBox(page: Page, askPoints: (images: Array<{ mimeType: string; data: string }>, instruction: string) => Promise<Array<{ x: number; y: number }> | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const box = await page.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('[class*="geetest_box"], [class*="geetest_panel_box"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 200 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; });
    if (!el) return null;
    el.setAttribute('data-clikcode-box', '1');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
  })()`).catch(() => null) as (Box & { text: string }) | null;
  if (!box) return false;
  if (await solveGeetestMatch(page, random, sleep, trace)) return true;
  let shot: Buffer;
  try { shot = await page.locator('[data-clikcode-box="1"]').first().screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }); } catch { return false; }
  const instruction = `${box.text}. A small picture in the top corner, if any, is the example to match.`;
  const points = await askPoints([{ mimeType: 'image/jpeg', data: shot.toString('base64') }], instruction);
  if (!points?.length) { trace?.(`in-page check ("${box.text}"): no agreed spot`); return false; }
  trace?.(`in-page check ("${box.text}"): clicking ${points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
  for (const p of points.slice(0, 9)) {
    const x = box.x + p.x * box.width, y = box.y + p.y * box.height;
    await visitorClick(page.mouse, { x: x - 4, x2: x + 4, y: y - 4, y2: y + 4 }, random, sleep);
  }
  const submit = await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[data-clikcode-box="1"] [class*="geetest_submit"], [data-clikcode-box="1"] [class*="geetest_commit"]')).find(e => e.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
  if (submit) await visitorClick(page.mouse, toTarget(submit), random, sleep);
  return true;
}

/** A classic "type the characters you see" captcha: a small picture beside a field asking for its code. The picture
 * is read by the vision model and typed in at a visitor's pace. Says whether it typed anything; whether the site
 * accepts it shows when the form is sent. */
async function solveTextCaptcha(page: Page, askText: (image: { mimeType: string; data: string }) => Promise<string | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const marked = await page.evaluate(`(() => {
    const seen = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && el.type !== 'hidden'; };
    const asks = /captcha|security ?code|verification ?code|verify ?code|characters|code (shown|above|below|in the image)|text (shown|in the image)|type the (code|text|characters)|enter the (code|text|characters)|antispam|human/i;
    const labelOf = input => { const l = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); return [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), l ? l.textContent : '', input.closest('label') ? input.closest('label').textContent : ''].join(' '); };
    const input = Array.from(document.querySelectorAll('input:not([type]), input[type=text], input[type=tel], input[type=number]')).find(i => seen(i) && asks.test(labelOf(i)) && !/recaptcha|hcaptcha|turnstile|email|phone|name|company/i.test((i.name || '') + ' ' + (i.id || '')));
    if (!input) return false;
    const near = input.getBoundingClientRect();
    const pics = Array.from(document.querySelectorAll('img, canvas')).filter(p => { if (!seen(p)) return false; const r = p.getBoundingClientRect(); return r.width >= 50 && r.width <= 450 && r.height >= 18 && r.height <= 180; });
    const score = p => { const r = p.getBoundingClientRect(); const named = /captcha|securimage|code|verif|kaptcha/i.test([p.src, p.alt, p.id, p.className].join(' ')) ? 0 : 400; return named + Math.hypot(r.x + r.width / 2 - (near.x + near.width / 2), r.y + r.height / 2 - (near.y + near.height / 2)); };
    const pic = pics.sort((a, b) => score(a) - score(b))[0];
    if (!pic || score(pic) > 600) return false;
    input.setAttribute('data-clikcode-captcha-field', '1');
    pic.setAttribute('data-clikcode-captcha-picture', '1');
    return true;
  })()`).catch(() => false);
  if (!marked) return false;
  let shot: Buffer;
  try { shot = await page.locator('[data-clikcode-captcha-picture="1"]').first().screenshot({ type: 'png', timeout: 8_000 }); } catch { return false; }
  const text = await askText({ mimeType: 'image/png', data: shot.toString('base64') });
  if (!text) { trace?.('text captcha: the picture could not be read'); return false; }
  trace?.(`text captcha: typing ${text.length} characters`);
  const field = page.locator('[data-clikcode-captcha-field="1"]').first();
  await field.click({ timeout: 5_000 }).catch(() => undefined);
  await field.fill('').catch(() => undefined);
  for (const char of text) { await page.keyboard.type(char); await sleep(60 + random() * 140); }
  return true;
}

/** reCAPTCHA's audio challenge: switch to it, fetch the clip, have it transcribed, type the words, verify.
 * `refused` means Google would not serve audio here (or it could not be heard) and the pictures are back. */
async function solveRecaptchaAudio(page: Page, frame: Frame, box: Box, transcribe: (audio: Buffer, mimeType: string) => Promise<string | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<'typed' | 'refused'> {
  const READ = `(() => {
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; };
    const source = document.querySelector('#audio-source');
    const link = document.querySelector('.rc-audiochallenge-tdownload-link');
    const refused = document.querySelector('.rc-doscaptcha-header, .rc-doscaptcha-body');
    return { toAudio: r(document.querySelector('#recaptcha-audio-button')), toImage: r(document.querySelector('#recaptcha-image-button')), field: r(document.querySelector('#audio-response')), verify: r(document.querySelector('#recaptcha-verify-button')),
      src: (source && source.src) || (link && link.href) || '', refused: !!(refused && refused.getBoundingClientRect().height > 0), said: (document.querySelector('.rc-audiochallenge-error-message') || {}).innerText || '' };
  })()`;
  type Read = { toAudio: Box | null; toImage: Box | null; field: Box | null; verify: Box | null; src: string; refused: boolean; said: string };
  const read = async (): Promise<Read | undefined> => { try { return await frame.evaluate(READ) as Read; } catch { return undefined; } };
  const inPage = (b: Box) => toTarget({ ...b, x: b.x + box.x, y: b.y + box.y });
  const backToPictures = async (state: Read | undefined): Promise<'refused'> => { if (state?.toImage) await visitorClick(page.mouse, inPage(state.toImage), random, sleep); return 'refused'; };
  let state = await read();
  if (!state) return 'refused';
  if (!state.field) {
    if (!state.toAudio) return 'refused';
    trace?.('audio: switching to the spoken challenge');
    await visitorClick(page.mouse, inPage(state.toAudio), random, sleep);
    // The spoken challenge takes a moment to load; a refusal shows at once.
    for (let waited = 0; waited < 7_000; waited += 700) { await sleep(700); state = await read(); if (!state || state.refused || (state.field && state.src)) break; }
  }
  if (!state || state.refused || !state.field || !state.src) { trace?.(`audio: not offered here${state?.refused ? ' (Google refused it)' : ''}`); return backToPictures(state); }
  let clip: Buffer | undefined;
  try { const res = await page.context().request.get(state.src, { timeout: 15_000 }); if (res.ok()) clip = await res.body(); } catch { clip = undefined; }
  if (!clip || clip.length < 1_000) { trace?.('audio: the clip could not be fetched'); return backToPictures(state); }
  const heard = await transcribe(clip, 'audio/mpeg');
  const { cleanTranscript } = await import('./captcha-model.js');
  const words = heard ? cleanTranscript(heard) : '';
  if (words.length < 3) { trace?.('audio: nothing could be made out'); return backToPictures(state); }
  trace?.(`audio: typing ${words.split(' ').length} words`);
  await visitorClick(page.mouse, inPage(state.field), random, sleep);
  for (const char of words) { await page.keyboard.type(char); await sleep(40 + random() * 110); }
  await sleep(300 + random() * 400);
  const after = await read();
  if (after?.verify) await visitorClick(page.mouse, inPage(after.verify), random, sleep);
  else await page.keyboard.press('Enter');
  return 'typed';
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
  const transcribe = deps.transcribe ?? ((audio, mimeType) => import('./captcha-model.js').then(m => m.askTranscript(audio, mimeType, signal)));
  const askText = deps.askText ?? ((image) => import('./captcha-model.js').then(m => m.askCaptchaText(image, signal)));
  const askDrag = deps.askDrag ?? ((image, instruction) => import('./captcha-model.js').then(m => m.askDrag(image, instruction, signal)));
  const askPoints = deps.askPoints ?? ((images, instruction) => import('./captcha-model.js').then(m => m.askClickPoints(images, instruction, signal)));
  const budgetMs = deps.waitMs ?? 180_000;
  const began = Date.now();
  let firstWidget: HumanCheckWidget | undefined;
  let repressed = 0;
  let refreshed = 0;
  let inPageTries = 0, textTried = false;
  let pictureRounds = deps.audioFirst ? 2 : 0, audio: 'untried' | 'on' | 'refused' = 'untried';
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
      if (await humanCheckAnswered(page)) return { outcome: 'cleared', ...(firstWidget ? { widget: firstWidget } : {}) };
      // No widget challenge: the page may carry its own check -- a slider to drag, or a picture of characters to type.
      if (!firstWidget && inPageTries < 4) {
        inPageTries++;
        const slid = await solveSlider(page, askDrag, random, sleep, deps.trace, false, askPoints);
        if (slid) { await sleep(2_000); continue; }
      }
      if (!firstWidget && !textTried) {
        textTried = true;
        const typed = await solveTextCaptcha(page, askText, random, sleep, deps.trace);
        if (typed) return { outcome: 'cleared', widget: 'text' };
      }
      return { outcome: 'none', ...(firstWidget ? { widget: firstWidget } : {}) };
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
    // reCAPTCHA offers the same check as a spoken clip. After two picture rounds that did not clear, the clip is
    // listened to instead: it is transcribed by the Gateway's speech-to-text and typed in. Google sometimes refuses
    // audio ("automated queries"); then it is back to the pictures for the rest of the budget.
    if (found.widget === 'recaptcha' && audio !== 'refused' && (audio === 'on' || pictureRounds >= 2)) {
      const heard = await solveRecaptchaAudio(page, found.frame, found.box, transcribe, random, sleep, deps.trace);
      if (heard === 'refused') { audio = 'refused'; await sleep(1_000); continue; }
      audio = 'on';
      for (let waited = 0; waited < 8_000; waited += 500) { await sleep(500); if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: firstWidget }; if (!await findPuzzle(page)) break; }
      continue;
    }
    pictureRounds++;
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
      const drag = instruction && /\b(?:drag|slide|move)\b/i.test(instruction) ? await askDrag(grid, instruction) : undefined;
      let points: Array<{ x: number; y: number }> | undefined;
      if (instruction && !drag && !/\b(?:drag|slide)\b/i.test(instruction)) {
        // A puzzle about motion is answered from a few frames, half a second apart, not one still.
        const frames = [grid];
        if (/\b(?:mov(?:e|es|ing)|visit(?:ed|s)?|path|went|travel(?:s|led)?|jump(?:s|ed)?)\b/i.test(instruction)) {
          for (let i = 0; i < 4; i++) {
            await sleep(500);
            try { frames.push({ mimeType: 'image/jpeg', data: (await (await found.frame.frameElement()).screenshot({ type: 'jpeg', quality: 80, timeout: 8_000 }) as Buffer).toString('base64') }); } catch { break; }
          }
        }
        points = await askPoints(frames, instruction);
      }
      if (drag) {
        deps.trace?.(`"${instruction}": dragging (${drag.from.x.toFixed(2)},${drag.from.y.toFixed(2)}) to (${drag.to.x.toFixed(2)},${drag.to.y.toFixed(2)})`);
        const at = (p: { x: number; y: number }) => ({ x: found.box.x + p.x * found.box.width, y: found.box.y + p.y * found.box.height });
        await visitorDrag(page.mouse, at(drag.from), at(drag.to), random, sleep);
        const submit = await found.frame.evaluate(`(() => { const b = document.querySelector('.button-submit'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
        confirm = submit ? toTarget({ ...submit, x: submit.x + found.box.x, y: submit.y + found.box.y }) : { x: found.box.x + found.box.width * 0.8, x2: found.box.x + found.box.width * 0.95, y: found.box.y + found.box.height - 50, y2: found.box.y + found.box.height - 20 };
      } else if (points?.length) {
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
