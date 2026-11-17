/** The "I'm not a robot" / "Verify you are human" check. ClikCode's browser is the user's own Chrome on their own
 * connection, so most of these clear with the one press any visitor makes. That press is all `pressHumanCheck` does.
 * A check that wants an answer is solved by `solveHumanCheck`: pictures of the challenge go to the account's own
 * Gateway models, and the answer they agree on is played back into the page at a visitor's pace -- jittered cursor
 * paths, uneven pauses, no two runs alike -- so the interaction reads as a person, not a script. This is ClikCode's
 * built-in captcha solving, the capability other agents get from an external solving service, except nothing leaves
 * this machine but the puzzle's pixels. What it cannot answer is left for the user.
 *
 * This file is the way in: what is on the page (`detectHumanCheck`), the press, and the loop that hands each
 * family to its own solver (human-check-grid, -hcaptcha, -geetest, -arkose, -inpage). */
import type { Frame, Page } from 'playwright-core';
import { sleep as realSleep } from '../../runtime/sleep.js';
import { newMeter, type AskOptions } from './captcha-model.js';
import { arkoseAudio, playArkose } from './human-check-arkose.js';
import { GEETEST_STATE, geetestStep } from './human-check-geetest.js';
import { gridRound, readLayout, solveRecaptchaAudio } from './human-check-grid.js';
import { boxOf, fitPuzzle, frameShot, gatewayAsks, spot, visitorClick, within, type Asks, type Box, type Hands } from './human-check-hands.js';
import { hcaptchaRound, type HcaptchaMemo } from './human-check-hcaptcha.js';
import { HOLD_BUTTON, KNOWN_BOX, POW_STATE, SLIDER, TEXT_CAPTCHA, markGone, solveChallengeBox, solvePressHold, solveSlider, solveTextCaptcha, waitProofOfWork } from './human-check-inpage.js';

export type HumanCheckWidget = 'recaptcha' | 'turnstile' | 'hcaptcha' | 'text' | 'slider' | 'hold' | 'geetest' | 'arkose' | 'pow' | 'box';
export interface HumanCheckResult {
  /** cleared: the check accepted the answer. puzzle: it asked for more than a press. still-there: tried, nothing changed. none: no check on the page. */
  outcome: 'cleared' | 'puzzle' | 'still-there' | 'none';
  widget?: HumanCheckWidget;
}

const CHECKBOX: Array<[HumanCheckWidget, RegExp]> = [
  ['recaptcha', /recaptcha\/(?:api2|enterprise)\/anchor/i],
  ['hcaptcha', /hcaptcha\.com\/.*frame=checkbox/i],
  ['turnstile', /challenges\.cloudflare\.com\//i],
];
const PUZZLE = /recaptcha\/(?:api2|enterprise)\/bframe|hcaptcha\.com\/.*frame=challenge|arkoselabs|funcaptcha/i;

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

/** The challenge frame that is up: the visible puzzle frame, not a hidden one. */
async function findPuzzle(page: Page): Promise<{ widget: HumanCheckWidget; frame: Frame; box: Box } | undefined> {
  for (const frame of page.frames()) {
    const byUrl = PUZZLE.test(frame.url());
    // A widget may serve its challenge from a frame its own name does not match (Onfleet got hCaptcha in a frame
    // under the customer's domain): the markup decides, not the address.
    const byMarkup = byUrl ? undefined : await puzzleByMarkup(frame);
    if (!byUrl && !byMarkup) continue;
    const box = await boxOf(frame);
    if (!shownPuzzleBox(box)) continue;
    const widget: HumanCheckWidget = byMarkup ?? (/hcaptcha/i.test(frame.url()) ? 'hcaptcha' : /arkoselabs|funcaptcha/i.test(frame.url()) ? 'arkose' : 'recaptcha');
    // Arkose nests its game in a frame inside its own frame: the innermost one holds the puzzle.
    if (widget === 'arkose') {
      let inner = frame, innerBox = box;
      for (const child of page.frames()) {
        let up = child.parentFrame(), inside = false;
        while (up) { if (up === frame) { inside = true; break; } up = up.parentFrame(); }
        const childBox = inside ? await boxOf(child) : undefined;
        if (childBox && childBox.width >= 200 && childBox.height >= 150) { inner = child; innerBox = childBox; }
      }
      return { widget, frame: inner, box: innerBox };
    }
    return { widget, frame, box };
  }
  return undefined;
}

/** The widget a frame's own markup names, when its URL does not: hCaptcha's challenge is `.task-image` tiles with
 * a `.prompt-text` and a `.button-submit`; reCAPTCHA's grid is `td.rc-imageselect-tile`. One cheap look per frame. */
async function puzzleByMarkup(frame: Frame): Promise<HumanCheckWidget | undefined> {
  return frame.evaluate(`(() => {
    if (document.querySelector('.task-image') && (document.querySelector('.prompt-text') || document.querySelector('.button-submit'))) return 'hcaptcha';
    if (document.querySelector('td.rc-imageselect-tile')) return 'recaptcha';
    return null;
  })()`).catch(() => undefined) as Promise<HumanCheckWidget | undefined>;
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

/** The checks a page draws itself, each by its own finder, in one look (runs in the page). */
const IN_PAGE = `(() => {
  const geetest = ${GEETEST_STATE};
  if (geetest && geetest.state !== 'done') return 'geetest';
  if (${HOLD_BUTTON}) return 'hold';
  const pow = ${POW_STATE};
  if (pow && !pow.done) return 'pow';
  if (${SLIDER}) return 'slider';
  const text = ${TEXT_CAPTCHA};
  if (text && !text.filled) return 'text';
  if (${KNOWN_BOX}) return 'box';
  return null;
})()`;

/** The one answer to "is a human check in this visitor's way?", for every caller: the browser tool, the connector
 * runner and the sign-up qualifier. `stage` says how far along it is: a box to press, a puzzle that is up, or a
 * check the page draws itself. Undefined when there is none or it already holds its answer. */
export async function detectHumanCheck(page: Page): Promise<{ widget: HumanCheckWidget; stage: 'checkbox' | 'puzzle' | 'page' } | undefined> {
  const puzzle = await findPuzzle(page);
  if (puzzle) return { widget: puzzle.widget, stage: 'puzzle' };
  if (await humanCheckAnswered(page)) return undefined;
  const checkbox = await findCheckbox(page);
  if (checkbox) return { widget: checkbox.widget, stage: 'checkbox' };
  const drawn = await page.evaluate(IN_PAGE).catch(() => null) as HumanCheckWidget | null;
  return drawn ? { widget: drawn, stage: 'page' } : undefined;
}

export async function pressHumanCheck(page: Page, deps: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  const up = await findPuzzle(page);
  if (up) return { outcome: 'puzzle', widget: up.widget };
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
    if (await findPuzzle(page)) return { outcome: 'puzzle', widget: found.widget };
    if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: found.widget };
    // A whole-page check ("Just a moment…") has no answer field: it lets the visitor through by moving on or removing itself.
    if (page.url() !== startUrl || !await findCheckbox(page)) return { outcome: 'cleared', widget: found.widget };
  }
  return { outcome: 'still-there', widget: found.widget };
}

// ── solving ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SolveDeps {
  sleep?: (ms: number) => Promise<void>;
  /** The model asks; each one left out goes to the account's Gateway (captcha-model.ts). */
  asks?: Partial<Asks>;
  /** ClikCode's state directory. With it the run is added to the tally (captcha-log.ts), a site that has just
   * refused three answers is left alone for a while, and challenge kinds that never clear are skipped. */
  stateDir?: string;
  /** Source of randomness for the human-like pacing; tests inject a fixed one. */
  random?: () => number;
  signal?: AbortSignal;
  waitMs?: number;
  /** One line per step (instruction, squares picked, what the widget said after Verify), for logs and diagnosis. */
  trace?: (line: string) => void;
}

/** Answer whatever human check is on the page the way a person does, family by family, until the page holds an
 * accepted answer or the budget runs out. Rounds continue while a widget keeps asking (reCAPTCHA often serves
 * several grids) and an expired challenge is pressed again. Resolves `cleared`, `still-there` (tried, not
 * accepted) or `none` (nothing found to answer). Never throws. */
export async function solveHumanCheck(page: Page, deps: SolveDeps = {}): Promise<HumanCheckResult> {
  if (!deps.stateDir) return solveShownCheck(page, deps, { refreshed: 0, kinds: [] });
  const log = await import('./captcha-log.js');
  const began = Date.now();
  let host = '';
  try { host = new URL(page.url()).host; } catch { host = ''; }
  if (await log.shouldHoldOff(deps.stateDir, host)) {
    deps.trace?.(`holding off: ${host} refused the last three answers`);
    return { outcome: 'still-there' };
  }
  const steps: string[] = [];
  const memo: HcaptchaMemo = { refreshed: 0, kinds: [], avoid: await log.weakKinds(deps.stateDir) };
  const meter = newMeter();
  const order = await log.voterOrder(deps.stateDir);
  const result = await solveShownCheck(page, { ...deps, trace: line => { const step = log.stepOf(line); if (step && steps.at(-1) !== step && steps.length < 12) steps.push(step); deps.trace?.(line); } }, memo, { meter, order });
  const family = log.familyOf(result.widget, steps);
  // A `none` with nothing asked and nothing done is "no check was on the page", not a run of a family: recording it
  // as one made the tally count pages the solver never saw a check on (23 of 29 "unknown" runs were these).
  if (result.outcome === 'none' && !steps.length) return result;
  await log.recordCaptcha(deps.stateDir, { at: new Date().toISOString(), host, family, outcome: result.outcome, seconds: Math.round((Date.now() - began) / 1000), steps, ...(memo.kinds.length ? { kinds: memo.kinds } : {}), ...(meter.asks ? { asks: meter.asks, models: meter.models } : {}) });
  // What the site accepted is the nearest thing to a marked answer sheet: the voters are scored on it.
  if (result.outcome === 'cleared') await log.recordVotes(deps.stateDir, meter.votes);
  await log.saveSamples(deps.stateDir, result.outcome, family, meter.samples);
  return result;
}

/** The whole way past a human check, for every caller: the one press a visitor makes, then -- unless `solve` is
 * false (the user turned captcha solving off) -- the answer to whatever the press brought up or the page draws
 * itself. A press that clears is counted in the tally too: it is by far the commonest ending. */
export async function passHumanCheck(page: Page, deps: SolveDeps & { solve?: boolean } = {}): Promise<HumanCheckResult> {
  const pressed = await pressHumanCheck(page, deps.sleep ? { sleep: deps.sleep } : {});
  if (pressed.outcome === 'cleared') {
    if (deps.stateDir) { let host = ''; try { host = new URL(page.url()).host; } catch { host = ''; } await (await import('./captcha-log.js')).recordCaptcha(deps.stateDir, { at: new Date().toISOString(), host, family: pressed.widget ?? 'unknown', outcome: 'cleared', seconds: 0, steps: ['press'] }); }
    return pressed;
  }
  if (deps.solve === false) return pressed;
  const solved = await solveHumanCheck(page, deps);
  // The press met a check but the solver then found none to answer (the challenge closed or changed in between): that is a
  // check that was tried and not passed, never "a puzzle nobody tried".
  if (solved.outcome === 'none' && pressed.outcome !== 'none') return { outcome: 'still-there', ...(pressed.widget ? { widget: pressed.widget } : {}) };
  return { ...solved, ...(solved.widget ?? pressed.widget ? { widget: solved.widget ?? pressed.widget } : {}) } as HumanCheckResult;
}

/** One go at the checks a page draws itself. A result ends the run; `acted` means something was done and the
 * page should be looked at again; undefined means nothing here could be answered. */
async function inPageStep(hands: Hands, memo: { tries: number; held: boolean; holds: number; textTyped: boolean }): Promise<HumanCheckResult | 'acted' | undefined> {
  const { page, random, sleep, trace, asks } = hands;
  const settled = async (done: () => Promise<boolean>): Promise<boolean> => {
    // An in-page check shows its verdict after its own animation: watch for it before judging.
    for (let waited = 0; waited < 7_000; waited += 500) { await sleep(500); if (await done()) return true; }
    return false;
  };
  if (memo.tries++ === 0 && await waitProofOfWork(page, random, sleep, trace)) return { outcome: 'cleared', widget: 'pow' };
  if (memo.held && !await page.evaluate(HOLD_BUTTON).catch(() => null)) return { outcome: 'cleared', widget: 'hold' };
  // Three holds at most: a button that is still there after that is refusing this browser, and more holds only make it surer.
  if (memo.holds < 3 && await solvePressHold(page, random, sleep, trace)) { memo.holds++; memo.held = true; await sleep(2_000); return 'acted'; }
  if (await geetestStep(hands)) return await settled(() => humanCheckAnswered(page)) ? { outcome: 'cleared', widget: 'geetest' } : 'acted';
  if (await solveSlider(hands)) return await settled(async () => await humanCheckAnswered(page) || await markGone(page, 'slider') || !await page.evaluate(SLIDER).catch(() => null)) ? { outcome: 'cleared', widget: 'slider' } : 'acted';
  if (!memo.textTyped && await solveTextCaptcha(page, asks.text, random, sleep, trace)) { memo.textTyped = true; return { outcome: 'cleared', widget: 'text' }; }
  if (await solveChallengeBox(hands)) return await settled(async () => await humanCheckAnswered(page) || await markGone(page, 'box')) ? { outcome: 'cleared', widget: 'box' } : 'acted';
  return undefined;
}

async function solveShownCheck(page: Page, deps: SolveDeps, hcaptcha: HcaptchaMemo, asking: Pick<AskOptions, 'meter' | 'order'> = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const hands: Hands = { page, random, sleep, asks: { ...gatewayAsks(deps.signal, asking), ...deps.asks }, ...(deps.trace ? { trace: deps.trace } : {}) };
  const budgetMs = deps.waitMs ?? 240_000;
  const began = Date.now();
  let widget: HumanCheckWidget | undefined;
  const ended = (outcome: HumanCheckResult['outcome']): HumanCheckResult => ({ outcome, ...(widget ? { widget } : {}) });
  let repressed = 0, arkoseStuck = 0, unread = 0;
  const inPage = { tries: 0, held: false, holds: 0, textTyped: false };
  let pictureRounds = 0, audio: 'untried' | 'on' | 'refused' = 'untried';
  while (Date.now() - began < budgetMs) {
    if (deps.signal?.aborted) break;
    const found = await findPuzzle(page);
    if (!found) {
      if (await humanCheckAnswered(page)) return ended('cleared');
      // The challenge may have expired ("Verification challenge expired"): the checkbox is back and a visitor
      // presses it again. Up to three presses; the answer field says whether any of them was accepted.
      if (await findCheckbox(page) && repressed < 3) {
        repressed++;
        const pressed = await pressHumanCheck(page, { waitMs: 8_000, sleep });
        widget ??= pressed.widget;
        await sleep(1_500);
        continue;
      }
      // No widget: the page may draw its own check.
      if (!widget && inPage.tries < 6) {
        const step = await inPageStep(hands, inPage);
        if (step === 'acted') continue;
        if (step) return step;
      }
      // Nothing more to try. A check still in the way was tried and not passed; none at all is none.
      return ended(inPage.held || await detectHumanCheck(page) ? 'still-there' : 'none');
    }
    widget ??= found.widget;
    if (await humanCheckAnswered(page)) return ended('cleared');
    // Every square must be on screen to be clicked: a challenge taller than a small window is given room first.
    if (await fitPuzzle(page, found.box)) { await sleep(800); continue; }
    let confirm: { x: number; x2: number; y: number; y2: number };
    if (found.widget === 'arkose') {
      // After two rounds the pictures could not be answered, the spoken challenge is tried instead.
      const played = arkoseStuck >= 2 && await arkoseAudio(hands, found.frame, found.box) ? 'played' : await playArkose(hands, found.frame, found.box);
      if (played === 'stuck') { if (++arkoseStuck >= 4) return ended('still-there'); await sleep(2_000); }
      else await sleep(2_500);
      // The game shows its next round or goes away by itself: there is no separate confirm to press here.
      if (await humanCheckAnswered(page) || !await findPuzzle(page)) return ended('cleared');
      continue;
    }
    // reCAPTCHA offers the same check as a spoken clip. After two picture rounds that did not clear, the clip is
    // listened to instead: it is transcribed by the Gateway's speech-to-text and typed in. Google sometimes refuses
    // audio ("automated queries"); then it is back to the pictures for the rest of the budget.
    if (found.widget === 'recaptcha' && audio !== 'refused' && (audio === 'on' || pictureRounds >= 2)) {
      const heard = await solveRecaptchaAudio(page, found.frame, found.box, hands.asks.transcribe, random, sleep, deps.trace);
      if (heard === 'refused') { audio = 'refused'; await sleep(1_000); continue; }
      audio = 'on';
      for (let waited = 0; waited < 8_000; waited += 500) { await sleep(500); if (await humanCheckAnswered(page)) return ended('cleared'); if (!await findPuzzle(page)) break; }
      continue;
    }
    pictureRounds++;
    const grid = await gridRound(hands, found.frame, found.box);
    if (grid) confirm = grid.confirm;
    else if (found.widget === 'hcaptcha') {
      const round = await hcaptchaRound(hands, found.frame, found.box, hcaptcha);
      if (round === 'gave-up') return ended('still-there');
      if (round === 'again') continue;
      confirm = round.confirm;
    } else {
      // A challenge with no layout this solver reads (a new kind, or one still loading): the voting models are
      // shown the whole challenge and asked where a visitor would click. Three such looks, then it is left.
      if (++unread > 3) return ended('still-there');
      await sleep(2_000);
      if (await readLayout(found.frame, found.box)) continue;
      const picture = await frameShot(found.frame);
      const points = picture ? await hands.asks.points([picture], 'Answer the challenge as its own instruction says, then click its confirm button') : undefined;
      if (!points?.length) continue;
      deps.trace?.(`unread challenge: clicking ${points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
      for (const p of points.slice(0, 10)) await visitorClick(page.mouse, spot(within(found.box, p)), random, sleep);
      await sleep(2_000);
      continue;
    }
    await visitorClick(page.mouse, confirm, random, sleep);
    deps.trace?.('answer given, confirm pressed');
    for (let waited = 0; waited < 20_000; waited += 600) {
      await sleep(600);
      if (await humanCheckAnswered(page)) return ended('cleared');
      const again = await findPuzzle(page);
      // No puzzle left and the page moved on: solved.
      if (!again && !await findCheckbox(page)) return ended('cleared');
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
  return ended(await humanCheckAnswered(page) ? 'cleared' : 'still-there');
}
