/** Arkose Labs (FunCaptcha). */
import type { Frame } from 'playwright-core';
import { spokenDigits } from './captcha-model.js';
import { fetchAsTab } from './tab-fetch.js';
import { frameShot, spot, toTarget, visitorClick, within, type Box, type Hands } from './human-check-hands.js';
import { tapKey } from './human-input.js';

/** The most candidates a carousel is stepped through (Arkose shows up to about a dozen). */
const MAX_OPTIONS = 20;

/** The carousel's length from its own short texts and labels ("2 of 6", "Image 2 of 6.", "3/5"); 0 when none says (runs in the
 * page and in tests). */
export const CAROUSEL_TOTAL = `((texts) => {
  for (const text of texts) {
    const m = /^\\s*(?:image|option|picture|choice)?\\s*(\\d+)\\s*(?:of|\\/)\\s*(\\d+)\\s*[.)]?\\s*$/i.exec(text);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2]) && Number(m[2]) >= 2 && Number(m[2]) <= ${MAX_OPTIONS}) return Number(m[2]);
  }
  return 0;
})`;

/** One step of an Arkose (FunCaptcha) game. Its puzzles share one shape: an instruction, sometimes a start
 * button, then either arrows that step through candidate pictures with a Submit button, or a set of pictures to
 * click one of. With arrows, every candidate is looked at once, the voting models pick the one that answers the
 * instruction, and the arrows are pressed back to it before Submit. Without arrows the models say where to click.
 * `stuck` means nothing could be done this round. */
export async function playArkose(hands: Hands, frame: Frame, box: Box): Promise<'played' | 'stuck'> {
  const { page, random, sleep, trace, asks } = hands;
  const READ = `(() => {
    const seen = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 6 && r.height > 6 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const clickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(seen);
    const label = e => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).replace(/\\s+/g, ' ').trim();
    const find = re => clickable.find(e => re.test(label(e)));
    const heading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], [role="text"], legend, p')).filter(seen).map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(t => t.length > 12).sort((a, b) => b.length - a.length)[0] || '';
    const nextEl = find(/next|right arrow/i) || document.querySelector('.right-arrow');
    const submitEl = find(/^submit\\b/i);
    // The count is the carousel's own ("2 of 6", or an image labelled "Image 2 of 6"): read inside the widget that holds the
    // arrows and Submit, from short texts and labels only -- never from any "N of M" in the page's body text.
    let scope = nextEl ? nextEl.parentElement : null;
    while (scope && submitEl && !scope.contains(submitEl)) scope = scope.parentElement;
    const texts = scope ? Array.from(scope.querySelectorAll('*')).slice(0, 600).flatMap(e => [e.children.length === 0 ? (e.textContent || '') : '', e.getAttribute('aria-label') || '', e.getAttribute('alt') || '']).filter(t => t && t.length <= 40) : [];
    return { instruction: heading.slice(0, 240), start: r(find(/^(verify|start|begin|start puzzle|solve|continue|try again)\\b/i)), next: r(nextEl), submit: r(submitEl), total: (${CAROUSEL_TOTAL})(texts) };
  })()`;
  type Read = { instruction: string; start: Box | null; next: Box | null; submit: Box | null; total: number };
  const read = async (): Promise<Read | undefined> => { try { return await frame.evaluate(READ) as Read; } catch { return undefined; } };
  const inPage = (b: Box) => toTarget({ ...b, x: b.x + box.x, y: b.y + box.y });
  const shot = () => frameShot(frame);
  let state = await read();
  if (!state) return 'stuck';
  if (state.start && !state.next && !state.submit) {
    trace?.('Arkose: starting the puzzle');
    await visitorClick(page.mouse, inPage(state.start), random, sleep);
    await sleep(2_500);
    state = await read();
    if (!state) return 'stuck';
  }
  if (state.next && state.submit) {
    // Step through every candidate once. Arkose's carousel wraps, so after the last one it is back at the first.
    const options: Array<{ mimeType: string; data: string }> = [];
    // The widget's own count when it shows one; otherwise stepped until the first picture comes round again.
    const count = state.total >= 2 ? Math.min(state.total, MAX_OPTIONS) : MAX_OPTIONS;
    for (let i = 0; i < count; i++) {
      const picture = await shot();
      if (!picture) return 'stuck';
      // A carousel of unknown length: stop when the first picture comes round again.
      if (!state.total && i > 1 && picture.data === options[0]!.data) break;
      options.push(picture);
      await visitorClick(page.mouse, inPage(state.next), random, sleep);
      await sleep(500 + random() * 300);
    }
    const pick = await asks.pick(options, state.instruction);
    if (!pick) { trace?.(`Arkose ("${state.instruction}"): the voters did not agree on one of ${options.length}`); return 'stuck'; }
    trace?.(`Arkose ("${state.instruction}"): picture ${pick} of ${options.length}`);
    // Every candidate was stepped past once, so the carousel is back at the first picture.
    for (let i = 0; i < pick - 1; i++) { await visitorClick(page.mouse, inPage(state.next), random, sleep); await sleep(350 + random() * 250); }
    const again = await read();
    if (again?.submit) await visitorClick(page.mouse, inPage(again.submit), random, sleep);
    return 'played';
  }
  const picture = await shot();
  if (!picture || !state.instruction) return 'stuck';
  const points = await asks.points([picture], state.instruction);
  if (!points?.length) { trace?.(`Arkose ("${state.instruction}"): no agreed spot`); return 'stuck'; }
  trace?.(`Arkose ("${state.instruction}"): clicking (${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)})`);
  await visitorClick(page.mouse, spot(within(box, points[0]!)), random, sleep);
  const after = await read();
  if (after?.submit) await visitorClick(page.mouse, inPage(after.submit), random, sleep);
  return 'played';
}

/** Arkose's spoken challenge, for when the pictures did not work: its audio button is pressed, the clip is
 * fetched and transcribed, and the digits heard are typed in. Says whether it typed an answer. (Built from
 * Arkose's published markup; its keys are bound to their owners' sites, so this has only met a mock.) */
export async function arkoseAudio(hands: Hands, frame: Frame, box: Box): Promise<boolean> {
  const { page, random, sleep, trace, asks } = hands;
  const READ = `(() => {
    const seen = e => { const r = e.getBoundingClientRect(); return r.width > 6 && r.height > 6 && getComputedStyle(e).visibility !== 'hidden'; };
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const label = e => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '') + ' ' + (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : '')).toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(seen);
    const clip = document.querySelector('audio');
    const src = clip ? (clip.currentSrc || clip.src || (clip.querySelector('source') || {}).src || '') : '';
    return { toggle: r(buttons.find(e => /audio/.test(label(e)))), play: r(buttons.find(e => /\\bplay\\b/.test(label(e)))), field: r(Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])')).find(seen)), submit: r(buttons.find(e => /submit|verify/.test(label(e)))), src };
  })()`;
  type Read = { toggle: Box | null; play: Box | null; field: Box | null; submit: Box | null; src: string };
  const read = async (): Promise<Read | undefined> => { try { return await frame.evaluate(READ) as Read; } catch { return undefined; } };
  const inPage = (b: Box) => toTarget({ ...b, x: b.x + box.x, y: b.y + box.y });
  let state = await read();
  if (!state) return false;
  if (!state.field) {
    if (!state.toggle) return false;
    trace?.('Arkose audio: switching to the spoken challenge');
    await visitorClick(page.mouse, inPage(state.toggle), random, sleep);
    await sleep(2_500);
    state = await read();
    if (!state?.field) return false;
  }
  if (!state.src && state.play) { await visitorClick(page.mouse, inPage(state.play), random, sleep); await sleep(1_500); state = await read() ?? state; }
  if (!state.src || !state.field) return false;
  let clip: Buffer | undefined;
  try {
    if (state.src.startsWith('data:')) clip = Buffer.from(state.src.slice(state.src.indexOf(',') + 1), 'base64');
    else { const res = await fetchAsTab(page, new URL(state.src, frame.url()).href, { timeoutMs: 15_000, frame }); if (res.ok) clip = res.body; }
  } catch { clip = undefined; }
  if (!clip) return false;
  const digits = spokenDigits(await asks.transcribe(clip, /\.wav(?:$|\?)/i.test(state.src) ? 'audio/wav' : 'audio/mpeg') ?? '');
  if (!digits) { trace?.('Arkose audio: no digits heard'); return false; }
  trace?.(`Arkose audio: typing ${digits.length} digits`);
  await visitorClick(page.mouse, inPage(state.field), random, sleep);
  for (const digit of digits) { await tapKey(page, digit, { random }); await sleep(90 + random() * 160); }
  const after = await read();
  if (after?.submit) await visitorClick(page.mouse, inPage(after.submit), random, sleep); else await page.keyboard.press('Enter');
  return true;
}
