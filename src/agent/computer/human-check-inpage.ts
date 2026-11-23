/** Checks a page draws itself, outside any widget frame: a button to hold, a sum the browser works out, a slider,
 * a picture of characters to type, or a challenge box this solver has no special reader for. */
import type { Page } from 'playwright-core';
import { spot, toTarget, visitorClick, visitorDrag, within, type Box, type Hands } from './human-check-hands.js';
import { quiet } from '../../runtime/lifecycle-log.js';

/** Finds a press-and-hold button on the page (runs in the page). */
export const HOLD_BUTTON = `(() => {
    const el = Array.from(document.querySelectorAll('#px-captcha, [id^="px-captcha"], [class*="px-captcha"], [aria-label*="Press & Hold" i], [aria-label*="Press and Hold" i]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 20 && r.bottom > 0 && r.top < innerHeight; })
      || Array.from(document.querySelectorAll('button, [role="button"], div, p')).find(e => { const r = e.getBoundingClientRect(); return r.width > 60 && r.width < 500 && r.height > 20 && r.height < 140 && /^press (and|&) hold$/i.test((e.textContent || '').trim()) && r.bottom > 0 && r.top < innerHeight; });
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`;

/** "Press and hold" (PerimeterX / HUMAN): a button that wants the pointer held down for several seconds. It is
 * held like a finger -- small tremors, no fixed duration -- until the button goes away or says it is done. */
export async function solvePressHold(page: Page, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const button = await page.evaluate(HOLD_BUTTON).catch(() => null) as Box | null;
  if (!button) return false;
  trace?.('press and hold: holding the button');
  const x = button.x + button.width * (0.4 + random() * 0.2), y = button.y + button.height * (0.4 + random() * 0.2);
  await page.mouse.move(x - 40 - random() * 40, y - 20 + random() * 10);
  await page.mouse.move(x, y, { steps: 6 + Math.floor(random() * 5) });
  await sleep(150 + random() * 250);
  await page.mouse.down();
  const startUrl = page.url();
  // Released whatever happens: a run stopped mid-hold never leaves the button held down.
  try {
    // Held until the button is gone, the page moves on, or 15 seconds pass; then a moment longer, as people do.
    for (let held = 0; held < 15_000; held += 400) {
      await sleep(400);
      await page.mouse.move(x + (random() - 0.5) * 1.6, y + (random() - 0.5) * 1.6);
      if (page.url() !== startUrl || !await page.evaluate(HOLD_BUTTON).catch(() => null)) break;
    }
    await sleep(200 + random() * 300);
  } finally { await page.mouse.up(); }
  return true;
}

/** Where a proof-of-work check stands (runs in the page). */
export const POW_STATE = `(() => {
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return b.width > 4 && b.height > 4 && b.bottom > 0 && b.top < innerHeight ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; };
    const frc = document.querySelector('.frc-captcha, frc-captcha');
    const altcha = document.querySelector('altcha-widget');
    if (!frc && !altcha) return null;
    const value = sel => { const f = document.querySelector(sel); return f ? String(f.value || '') : ''; };
    const frcValue = value('[name="frc-captcha-solution"], [name="frc-captcha-response"]');
    const altchaRoot = altcha ? (altcha.shadowRoot || altcha) : null;
    const done = (frc && frcValue.length > 20 && !frcValue.startsWith('.')) || (altcha && (value('[name="altcha"]').length > 20 || !!(altchaRoot && altchaRoot.querySelector('[data-state="verified"], .altcha[data-state="verified"]'))));
    const box = frc || altcha;
    const where = box.getBoundingClientRect();
    // A widget with no size is not shown to the visitor: a "floating" ALTCHA appears only when its own form is submitted (urlr's
    // link shortener on the home page). It is in nobody's way until then, and a form that needs it shows it.
    if (!done && where.width <= 4 && where.height <= 4) return null;
    if (where.top > innerHeight - 40 || where.bottom < 40) box.scrollIntoView({ block: 'center' });
    // Friendly Captcha v2 draws its box in a frame; v1 has a start button; ALTCHA has a checkbox.
    const press = frc ? (frc.querySelector('iframe.frc-i-widget') || (frc.shadowRoot || frc).querySelector('button.frc-button, button')) : altchaRoot ? altchaRoot.querySelector('input[type="checkbox"]') : null;
    return { done: !!done, press: r(press), kind: frc ? 'Friendly Captcha' : 'ALTCHA' };
  })()`;

/** Proof-of-work checks (Friendly Captcha, ALTCHA): nothing to answer, the browser does a sum. Their box is
 * pressed if it wants a press, then the work is waited out (up to 45 seconds). `done`: the widget says the work is
 * finished. `gone`: the widget left the page while it worked (the caller decides whether anything is still in the
 * way). `unfinished`: it never said so. False: there is no proof-of-work check. A page that cannot be read for a
 * moment (it is navigating) is looked at again, never taken as finished. */
export async function waitProofOfWork(page: Page, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<false | 'done' | 'gone' | 'unfinished'> {
  type Read = { done: boolean; press: Box | null; kind: string } | null;
  const UNREADABLE = Symbol('unreadable');
  let state = await page.evaluate(POW_STATE).catch(() => null) as Read;
  if (!state) return false;
  if (state.done) return 'done';
  trace?.(`proof of work (${state.kind}): ${state.press ? 'pressing its box and ' : ''}waiting for the browser to finish`);
  // Its box is pressed near the left edge, where the tick is.
  if (state.press) await visitorClick(page.mouse, toTarget({ ...state.press, width: Math.min(state.press.width, 60) }), random, sleep);
  for (let waited = 0; waited < 45_000; waited += 1_000) {
    await sleep(1_000);
    const read = await page.evaluate(POW_STATE).catch(() => UNREADABLE) as Read | typeof UNREADABLE;
    if (read === UNREADABLE) continue;
    if (!read) return 'gone';
    if (read.done) return 'done';
  }
  return 'unfinished';
}

/** Whether a field beside a picture is a "type the characters you see" captcha (runs in the page and in tests). `field`:
 * its own names (`nameId`: name and id), its label text (`label`: label, placeholder, aria-label), the short text of its
 * block (`block`), its `autocomplete`, and whether its form takes a payment card (`formHasCard`). `picture`: the
 * likeliest picture, whether its own names say captcha (`named`) and how far it is from the field (`distance`, px).
 * A picture beside a "verification code" or "security code" field is not enough: a one-time code sent by text
 * message and a card's security code sit beside logos and card pictures every day, and typing a guessed picture into
 * them is the worst thing this solver could do. It takes a captcha-named field, an instruction that names the picture,
 * or a code field beside a picture named for a captcha -- and never a one-time-code or payment field. */
export const TEXT_CAPTCHA_RULE = `((field, picture) => {
    const auto = String(field.autocomplete || '').toLowerCase();
    if (/one-time-code/.test(auto) || /(^|\\s)cc-/.test(auto) || field.formHasCard) return false;
    const payment = /card|cvv|cvc|csc|cc-?(?:num|exp|csc|name)|payment|billing|expir/i;
    if (payment.test(field.nameId) || payment.test(field.label)) return false;
    const oneTime = /one.?time|\\botp\\b|totp|2fa|mfa|passcode|authenticat|we (?:sent|texted|emailed)|sent (?:to|you)|text message|\\bsms\\b|check your (?:email|phone|inbox)/i;
    if (oneTime.test(field.nameId) || oneTime.test(field.label) || oneTime.test(field.block)) return false;
    if (!picture) return false;
    const captchaNamed = /captcha|securimage|kaptcha|anti-?spam/i;
    const pictured = /captcha|(?:text|characters|letters|code|word|numbers?)s? (?:\\w+ )?(?:that )?you see|in the (?:image|picture)|(?:image|picture) (?:below|above|shown)|shown in the (?:image|picture)|stop spam|not a robot|are you (?:a )?human/i;
    if (captchaNamed.test(field.nameId) || captchaNamed.test(field.label)) return picture.distance <= 600;
    if (pictured.test(field.label) || pictured.test(field.block)) return picture.named || picture.distance <= 400;
    if (picture.named && /code|characters|text|word|verif/i.test(field.label + ' ' + field.nameId)) return picture.distance <= 400;
    return false;
  })`;

/** Finds a "type the characters you see" captcha and marks its field and picture (runs in the page). */
export const TEXT_CAPTCHA = `(() => {
    const seen = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && el.type !== 'hidden'; };
    const rule = ${TEXT_CAPTCHA_RULE};
    const labelOf = input => { const l = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); return [input.placeholder, input.getAttribute('aria-label'), l ? l.textContent : '', input.closest('label') ? input.closest('label').textContent : ''].join(' ').replace(/\\s+/g, ' '); };
    const boxes = Array.from(document.querySelectorAll('input:not([type]), input[type=text], input[type=tel], input[type=number]'));
    // The instruction is often not a <label> but text in the field's own block ("To help stop spam, please type the text you
    // see in the image below" in a form-group): the nearest container where this is the only visible box, read when short.
    const blockOf = input => { for (let el = input.parentElement, up = 0; el && up < 4; el = el.parentElement, up++) { if (boxes.filter(b => el.contains(b) && seen(b)).length > 1) return ''; const text = (el.innerText || '').replace(/\\s+/g, ' ').trim(); if (text) return text.length <= 400 ? text : ''; } return ''; };
    const pics = Array.from(document.querySelectorAll('img, canvas')).filter(p => { if (!seen(p)) return false; const r = p.getBoundingClientRect(); return r.width >= 50 && r.width <= 450 && r.height >= 18 && r.height <= 180; });
    const pictureFor = input => {
      const near = input.getBoundingClientRect();
      const of = p => { const r = p.getBoundingClientRect(); return { el: p, named: /captcha|securimage|kaptcha/i.test([p.src, p.alt, p.id, typeof p.className === 'string' ? p.className : ''].join(' ')), distance: Math.hypot(r.x + r.width / 2 - (near.x + near.width / 2), r.y + r.height / 2 - (near.y + near.height / 2)) }; };
      return pics.map(of).sort((a, b) => (a.named ? 0 : 400) + a.distance - ((b.named ? 0 : 400) + b.distance))[0] || null;
    };
    const cardIn = form => !!(form && form.querySelector('[autocomplete^="cc-" i], [autocomplete*=" cc-" i], [name*="cardnumber" i], [name*="card_number" i], [name*="cvv" i], [name*="cvc" i]'));
    let found = null;
    for (const input of boxes) {
      if (!seen(input) || /recaptcha|hcaptcha|turnstile|email|phone|name|company/i.test((input.name || '') + ' ' + (input.id || ''))) continue;
      const picture = pictureFor(input);
      const field = { nameId: (input.name || '') + ' ' + (input.id || ''), label: labelOf(input), block: blockOf(input), autocomplete: input.getAttribute('autocomplete') || '', formHasCard: cardIn(input.form) };
      if (rule(field, picture && { named: picture.named, distance: picture.distance })) { found = { input, picture }; break; }
    }
    if (!found) return null;
    found.input.setAttribute('data-clikcode-captcha-field', '1');
    found.picture.el.setAttribute('data-clikcode-captcha-picture', '1');
    return { filled: String(found.input.value || '').length > 0 };
  })()`;

/** How a text captcha's picture is watched before it is read: a look every `LOOK_MS`; once it has changed, `AFTER_CHANGE_MS` more; a picture
 * that never changes is taken once it has held still for `STILL_MS`; `MOST_MS` in all. */
export const TEXT_PICTURE_WATCH = { LOOK_MS: 500, AFTER_CHANGE_MS: 1_000, STILL_MS: 4_000, MOST_MS: 9_000 };

/** The text captcha's picture once it shows its code. A picture drawn by the page's script can show a stand-in first: NeutrinoAPI's canvas
 * says "Generating..." for about three seconds (2026-11-23: the first look was read, both voters agreed on "Generating...", and the code
 * typed was refused three times), and others fade in or swap a loading image. So the picture is watched: one that changed has been drawn
 * (an animated one keeps changing, and any frame of it reads), and one that holds still long enough is what it is. */
async function settledPicture(page: Page, sleep: (ms: number) => Promise<void>): Promise<Buffer | undefined> {
  const { LOOK_MS, AFTER_CHANGE_MS, STILL_MS, MOST_MS } = TEXT_PICTURE_WATCH;
  const take = async (): Promise<Buffer | undefined> => {
    try { return await page.locator('[data-clikcode-captcha-picture="1"]').first().screenshot({ type: 'png', timeout: 8_000 }); } catch { return undefined; }
  };
  let last = await take();
  if (!last) return undefined;
  let still = 0, changedFor = -1;
  for (let waited = 0; waited < MOST_MS; waited += LOOK_MS) {
    await sleep(LOOK_MS);
    const now = await take();
    if (!now) return last;
    if (changedFor >= 0) changedFor += LOOK_MS;
    else if (!now.equals(last)) changedFor = 0;
    else still += LOOK_MS;
    last = now;
    if (changedFor >= AFTER_CHANGE_MS || (changedFor < 0 && still >= STILL_MS)) return last;
  }
  return last;
}

/** A classic "type the characters you see" captcha: a small picture beside a field asking for its code. The picture
 * is read by the vision models and typed in at a visitor's pace. `typed`: the field reads back what was typed.
 * `mismatch`: something was typed but the field does not hold it (another field had focus, or the page rewrote it).
 * False: nothing was typed. Whether the site accepts the code shows only when the form is sent. */
export async function solveTextCaptcha(page: Page, askText: (image: { mimeType: string; data: string }) => Promise<string | undefined>, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<'typed' | 'mismatch' | false> {
  const marked = await page.evaluate(TEXT_CAPTCHA).catch(() => null);
  if (!marked) return false;
  const shot = await settledPicture(page, sleep);
  if (!shot) return false;
  const text = await askText({ mimeType: 'image/png', data: shot.toString('base64') });
  if (!text) { trace?.('text captcha: the picture could not be read'); return false; }
  trace?.(`text captcha: typing ${text.length} characters`);
  const field = page.locator('[data-clikcode-captcha-field="1"]').first();
  await field.click({ timeout: 5_000 }).catch(quiet('agent/computer/human-check-inpage'));
  await field.fill('').catch(quiet('agent/computer/human-check-inpage'));
  for (const char of text) { await page.keyboard.type(char); await sleep(60 + random() * 140); }
  const held = await field.inputValue({ timeout: 3_000 }).catch(quiet('agent/computer/human-check-inpage'));
  const same = (a: string): string => a.replace(/\s+/g, '').toLowerCase();
  return held !== undefined && same(held) === same(text) ? 'typed' : 'mismatch';
}

/** Finds a slider check drawn in the page (Alibaba's "slide to verify" and the like) and marks its box (runs in
 * the page). Only a handle inside something named for a captcha or verification counts: a picture carousel has
 * a slider too. */
export const SLIDER = `(() => {
  const seen = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const home = '.nc-container, .nc_wrapper, [class*="captcha" i], [id*="captcha" i], [class*="verify" i], [id*="verify" i]';
  const handle = Array.from(document.querySelectorAll('.btn_slide, .nc_iconfont.btn_slide, [class*="slider" i][class*="btn" i], [class*="slider" i][class*="handle" i], [class*="slide" i][class*="button" i], [class*="slide" i][class*="block" i], [role="slider"]')).find(e => seen(e) && e.closest(home) && !e.closest('[class*="geetest"]'));
  if (!handle) return null;
  const box = handle.closest(home);
  const track = handle.parentElement;
  const r = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  document.querySelectorAll('[data-clikcode-slider]').forEach(e => e.removeAttribute('data-clikcode-slider'));
  box.setAttribute('data-clikcode-slider', '1');
  const at = r(handle), along = r(track);
  // A handle already at the far end of its track has been slid: nothing to drag, but no verdict either (only the page's own
  // answer field, or the box going away, says the slide was accepted).
  if (at.x + at.width / 2 > along.x + along.width - at.width) return { slid: true };
  return { slid: false, handle: at, track: along, box: r(box), text: (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160), picture: !!box.querySelector('canvas, img, [class*="bg"]') };
})()`;

/** A slider check: a handle on a track, often under a picture with a gap. With a picture, the voting models say
 * where the handle is and where the piece fits, and the handle is dragged that far; a bare "slide to the end"
 * track is dragged to its end. */
export async function solveSlider(hands: Hands): Promise<boolean> {
  const { page, random, sleep, trace, asks } = hands;
  const found = await page.evaluate(SLIDER).catch(() => null) as { slid: false; handle: Box; track: Box; box: Box; text: string; picture: boolean } | { slid: true } | null;
  if (!found || found.slid) return false;
  const start = { x: found.handle.x + found.handle.width / 2, y: found.handle.y + found.handle.height / 2 };
  let distance = found.track.x + found.track.width - found.handle.width / 2 - start.x;
  if (found.picture) {
    let shot: Buffer;
    try { shot = await page.locator('[data-clikcode-slider="1"]').first().screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }); } catch { return false; }
    const drag = (await asks.drags({ mimeType: 'image/jpeg', data: shot.toString('base64') }, found.text || 'Drag the slider so the piece fits into its gap'))?.[0];
    if (!drag) { trace?.(`slider ("${found.text}"): the voters did not agree where the piece goes`); return false; }
    distance = (drag.to.x - drag.from.x) * found.box.width;
  }
  if (!(distance > 4)) return false;
  trace?.(`slider ("${found.text}"): dragging ${Math.round(distance)}px`);
  await visitorDrag(page.mouse, start, { x: start.x + distance, y: start.y }, random, sleep);
  return true;
}

/** Finds a challenge box drawn in the page and marks it (runs in the page). `known` lists the ones a visitor is
 * certainly being asked to answer (AWS WAF's); `any` adds anything named for a captcha or challenge that holds a
 * picture, for a check this solver has never seen. */
const challengeBox = (any: boolean): string => `(() => {
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 150 && r.width < 900 && r.height < 900 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; };
  const known = 'awswaf-captcha, [id*="aws-waf-captcha"], [class*="amzn-captcha"]';
  const loose = '[class*="captcha" i], [id*="captcha" i], [class*="challenge" i], [id*="challenge" i]';
  let el = Array.from(document.querySelectorAll(known)).find(shown);
  // The innermost box that holds the picture, so the page around it is not in the shot. A box holding a frame is a widget's, not the page's.
  if (!el && ${any}) el = Array.from(document.querySelectorAll(loose)).filter(e => shown(e) && e.querySelector('canvas, img, svg') && !e.querySelector('iframe')).sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
  if (!el) return null;
  document.querySelectorAll('[data-clikcode-box]').forEach(e => e.removeAttribute('data-clikcode-box'));
  el.setAttribute('data-clikcode-box', '1');
  const r = el.getBoundingClientRect();
  const text = (el.shadowRoot ? el.shadowRoot.textContent : el.innerText) || '';
  return { x: r.x, y: r.y, width: r.width, height: r.height, text: text.replace(/\\s+/g, ' ').trim().slice(0, 160) };
})()`;
export const KNOWN_BOX = challengeBox(false);
const ANY_BOX = challengeBox(true);

/** A challenge box with no reader of its own (AWS WAF's grid, or one never seen before): a picture of the box
 * goes to the voting models with whatever the box says, the spots they agree on are clicked, then the box's own
 * confirm button if it has one. */
export async function solveChallengeBox(hands: Hands): Promise<boolean> {
  const { page, random, sleep, trace, asks } = hands;
  const box = await page.evaluate(ANY_BOX).catch(() => null) as (Box & { text: string }) | null;
  if (!box) return false;
  let shot: Buffer;
  try { shot = await page.locator('[data-clikcode-box="1"]').first().screenshot({ type: 'jpeg', quality: 88, timeout: 8_000 }); } catch { return false; }
  const instruction = `${box.text || 'Answer the challenge shown'}. A small picture in the top corner, if any, is the example to match.`;
  const points = await asks.points([{ mimeType: 'image/jpeg', data: shot.toString('base64') }], instruction);
  if (!points?.length) { trace?.(`in-page check ("${box.text}"): no agreed spot`); return false; }
  trace?.(`in-page check ("${box.text}"): clicking ${points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
  for (const p of points.slice(0, 9)) await visitorClick(page.mouse, spot(within(box, p)), random, sleep);
  await sleep(500);
  const submit = await page.evaluate(`(() => {
    const box = document.querySelector('[data-clikcode-box="1"]'); if (!box) return null;
    const root = box.shadowRoot || box;
    const buttons = Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(e => e.getBoundingClientRect().width > 0);
    // The confirm button by its type or its place: a submit button, else the last button in the box.
    const b = buttons.find(e => e.type === 'submit' || /confirm|verify|submit|done|check/i.test((e.textContent || '') + ' ' + (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : ''))) || (buttons.length > 1 ? buttons[buttons.length - 1] : null);
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`).catch(() => null) as Box | null;
  if (submit) await visitorClick(page.mouse, toTarget(submit), random, sleep);
  return true;
}

/** Whether the marked slider or challenge box is still on the page. */
export async function markGone(page: Page, mark: 'slider' | 'box'): Promise<boolean> {
  return page.evaluate(`(() => { const e = document.querySelector('[data-clikcode-${mark}="1"]'); if (!e) return true; const r = e.getBoundingClientRect(); return r.width < 8 || r.height < 8 || getComputedStyle(e).visibility === 'hidden'; })()`).then(Boolean).catch(() => false);
}
