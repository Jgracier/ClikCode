/** reCAPTCHA's two challenges: the picture grid, answered one outlined square at a time, and the spoken clip,
 * transcribed and typed. (hCaptcha's classic tile grid shares the same reader.) */
import type { Frame, Page } from 'playwright-core';
import { cleanTranscript } from './captcha-model.js';
import { toTarget, visitorClick, type Asks, type Box, type Hands } from './human-check-hands.js';

/** A challenge as the widget itself lays it out: the instruction, the target word, each square's place on the page
 * (frame offset added), a key per square that changes when the widget swaps its picture, and the confirm button. */
export interface PuzzleLayout {
  instruction: string; target: string; tiles: Array<Box & { key: string; selected: boolean }>; verify?: Box; dynamic: boolean; tileSelector: string;
  /** Set when the widget is the page itself (AWS WAF): the places are already page coordinates, and a picture of the challenge is this region of the page, not a frame. */
  region?: Box;
}

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
  const aws = Array.from(document.querySelectorAll('button.amzn-grid-cell')).filter(cell => cell.getBoundingClientRect().width > 4);
  if (aws.length) {
    const root = document.querySelector('.amzn-captcha-root') || document.body;
    const prompt = document.querySelector('#amzn-grid-instructions');
    const emphasis = prompt && prompt.querySelector('em, strong, b');
    const instruction = clean(prompt && prompt.innerText);
    const confirm = Array.from(root.querySelectorAll('button')).find(b => /^confirm$/i.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 0);
    return {
      instruction, target: clean(emphasis && emphasis.textContent) || instruction,
      // One picture is drawn on a canvas; the squares are transparent buttons over it, and a ticked one says so.
      tiles: aws.map((cell, index) => Object.assign(rect(cell), { key: String(index), selected: cell.getAttribute('aria-checked') === 'true' })),
      verify: confirm ? rect(confirm) : undefined, dynamic: false, tileSelector: 'button.amzn-grid-cell', region: rect(root),
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

export async function readLayout(frame: Frame, box: Box): Promise<PuzzleLayout | undefined> {
  try {
    const read = await frame.evaluate(READ_LAYOUT) as (Omit<PuzzleLayout, 'verify'> & { verify?: Box }) | null;
    if (!read || !read.tiles.length) return undefined;
    // A frame reports places inside itself and is offset by where it sits on the page; the page itself is already in page coordinates.
    const shift = <T extends Box>(b: T): T => read.region ? b : ({ ...b, x: b.x + box.x, y: b.y + box.y });
    return { ...read, tiles: read.tiles.map(shift), ...(read.verify ? { verify: shift(read.verify) } : {}) };
  } catch { return undefined; }
}

/** Outline one square in red inside the challenge, take a picture of the whole challenge, take the outline away. */
async function outlinedShot(frame: Frame, layout: PuzzleLayout, index: number): Promise<Buffer | undefined> {
  const mark = `(() => { const tile = document.querySelectorAll(${JSON.stringify(layout.tileSelector)})[${index}]; if (!tile) return false;
    const r = tile.getBoundingClientRect(); const box = document.createElement('div'); box.id = 'clikcode-outline';
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:4px solid #ff0000;box-sizing:border-box;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    document.body.appendChild(box); return true; })()`;
  const unmark = `(() => { const box = document.getElementById('clikcode-outline'); if (box) box.remove(); })()`;
  try {
    if (!await frame.evaluate(mark)) return undefined;
    // A widget that is the page itself has no frame to photograph: its own region of the page is the picture.
    if (layout.region) return await frame.page().screenshot({ type: 'jpeg', quality: 88, timeout: 8_000, clip: layout.region });
    return await (await frame.frameElement()).screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }) as Buffer;
  } catch { return undefined; }
  finally { await frame.evaluate(unmark).catch(() => undefined); }
}

/** Ask about each listed square and return the indices that hold the target. The pictures are taken one after
 * another (the outline is shared page state); the asks then run together. */
export async function matchingTiles(frame: Frame, layout: PuzzleLayout, indices: number[], askTile: Asks['tile'], timing: { shotsMs: number; asksMs: number } = { shotsMs: 0, asksMs: 0 }): Promise<number[]> {
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

/** reCAPTCHA's audio challenge: switch to it, fetch the clip, have it transcribed, type the words, verify.
 * `refused` means Google would not serve audio here (or it could not be heard) and the pictures are back. */
export async function solveRecaptchaAudio(page: Page, frame: Frame, box: Box, transcribe: (audio: Buffer, mimeType: string) => Promise<string | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<'typed' | 'refused'> {
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

/** One round of the picture grid: ask about every unselected square, click the matches (again for the squares a
 * "click until none are left" grid replaces), and say where the Verify button is. Undefined when the challenge's
 * layout could not be read. */
export async function gridRound(hands: Hands, frame: Frame, box: Box): Promise<{ confirm: { x: number; x2: number; y: number; y2: number } } | undefined> {
  const { page, random, sleep, trace, asks } = hands;
  const layout = await readLayout(frame, box);
  if (!layout) return undefined;
  // Squares already selected (a half-finished round) are left as they are; only the others are asked about.
  let pending = layout.tiles.map((tile, index) => tile.selected ? -1 : index).filter(index => index >= 0);
  let current = layout;
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const timing = { shotsMs: 0, asksMs: 0 };
    const hits = await matchingTiles(frame, current, pending, asks.tile, timing);
    trace?.(`${current.tiles.length} squares, "${current.instruction}" pass ${pass + 1}: asked ${pending.length}, picked [${hits.join(',')}] (pictures ${Math.round(timing.shotsMs / 100) / 10}s, answers ${Math.round(timing.asksMs / 100) / 10}s)`);
    for (const index of hits) { const at = current.tiles[index]; if (at) await visitorClick(page.mouse, toTarget(at), random, sleep); }
    if (!hits.length) break;
    // A "click until none are left" grid does not keep a clicked square selected: it fades a new picture into it.
    // That, not the wording of the instruction (which comes in the visitor's language), is how one is told apart.
    // Only a grid of nine separate photos is ever one of those; a single photo cut into sixteen never is.
    if (!current.dynamic && current.tiles.length !== 9) break;
    const clicked = current.dynamic ? undefined : await readLayout(frame, box);
    if (!current.dynamic && !hits.some(index => clicked?.tiles[index] && !clicked.tiles[index]!.selected)) break;
    // Ask only about the squares that changed.
    await sleep(3_500 + random() * 1_000);
    const next = await readLayout(frame, box);
    if (!next) break;
    pending = hits.filter(index => next.tiles[index] && next.tiles[index]!.key !== current.tiles[index]?.key);
    current = { ...next, dynamic: true };
  }
  const verify = (await readLayout(frame, box))?.verify ?? layout.verify;
  return { confirm: verify ? toTarget(verify) : { x: box.x + box.width * 0.7, x2: box.x + box.width * 0.95, y: box.y + box.height - 50, y2: box.y + box.height - 15 } };
}
