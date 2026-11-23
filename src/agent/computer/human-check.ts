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
import { awsWafState } from './human-check-awswaf.js';
import { sleep as realSleep } from '../../runtime/sleep.js';
import { newMeter, type AskOptions } from './captcha-model.js';
import { arkoseAudio, playArkose } from './human-check-arkose.js';
import { GEETEST_STATE, geetestStep } from './human-check-geetest.js';
import { gridRound, readLayout, solveRecaptchaAudio } from './human-check-grid.js';
import { boxOf, clearMarks, fitPuzzle, frameShot, gatewayAsks, restoreViewport, spot, visitorClick, within, type Asks, type Box, type Hands, type ViewportMemo } from './human-check-hands.js';
import { hcaptchaRound, type HcaptchaMemo } from './human-check-hcaptcha.js';
import { HOLD_BUTTON, KNOWN_BOX, POW_STATE, SLIDER, TEXT_CAPTCHA, markGone, solveChallengeBox, solvePressHold, solveSlider, solveTextCaptcha, waitProofOfWork } from './human-check-inpage.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { egressOfPage } from './egress.js';

export type HumanCheckWidget = 'recaptcha' | 'turnstile' | 'hcaptcha' | 'text' | 'slider' | 'hold' | 'geetest' | 'arkose' | 'pow' | 'box' | 'awswaf';
export interface HumanCheckResult {
  /** cleared: the page is past the check (confirmed by `settledPast`, never by the widget's word alone). puzzle: it asked for more than a
   * press. still-there: tried, and the check is still in the way. none: no check on the page. */
  outcome: 'cleared' | 'puzzle' | 'still-there' | 'none';
  widget?: HumanCheckWidget;
  /** For a check that looked answered but is still in the way: what the page showed. */
  seen?: string;
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
    if (!box || box.width < 100 || box.height < 40 || box.height > 150) continue;
    // Only a box a visitor can see and reach counts: not one inside a closed form or under a banner. One scrolled out of
    // view, above the fold or below it, is scrolled back into view first, as a visitor would.
    const reachable = await frame.frameElement().then(el => el.evaluate((node: unknown) => {
      const g = globalThis as unknown as { innerHeight: number; innerWidth: number; document: { elementFromPoint(x: number, y: number): unknown } };
      const el = node as { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; contains(other: unknown): boolean; scrollIntoView(options: unknown): void };
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(30, r.width / 2), y = r.top + r.height / 2;
      if (y > g.innerHeight || x > g.innerWidth || r.top < 0 || r.left < 0) { el.scrollIntoView({ block: 'center' }); return 'scrolled'; }
      const hit = g.document.elementFromPoint(x, y);
      if (hit === node || el.contains(hit)) return 'yes';
      // A widget inside a shadow root (Turnstile) is reported as its host element.
      let root = (node as { getRootNode(): { host?: { contains(other: unknown): boolean; getRootNode(): unknown } } }).getRootNode();
      while (root.host) { if (root.host === hit || root.host.contains(hit)) return 'yes'; root = root.host.getRootNode() as typeof root; }
      return 'no';
    })).catch(() => 'yes');
    if (reachable === 'no') continue;
    if (reachable === 'scrolled') {
      // A box that is still off the page after scrolling is parked there on purpose (a hidden widget): not one to press.
      const moved = await boxOf(frame);
      if (moved && moved.y >= 0 && moved.x >= 0) return { widget: kind[0], box: moved };
      continue;
    }
    if (box.y < 0 || box.x < 0) continue;
    return { widget: kind[0], box };
  }
  // AWS WAF's splash is a page of its own with a Begin button instead of a frame.
  const waf = await awsWafState(page);
  if (waf?.stage === 'begin') return { widget: 'awswaf', box: waf.begin };
  return undefined;
}

/** A challenge frame that is shown. A hidden one is parked thousands of pixels off the page; a shown one can still
 * hang partly above a small window (hCaptcha centres its challenge on the checkbox), so any real overlap counts. */
const shownPuzzleBox = (box: Box | undefined): box is Box => !!box && box.width >= 250 && box.height >= 200 && box.y > -1500 && box.x > -1500 && box.y + box.height > 60 && box.x + box.width > 60;

/** The challenge frame that is up: the visible puzzle frame, not a hidden one. */
async function findPuzzle(page: Page): Promise<{ widget: HumanCheckWidget; frame: Frame; box: Box } | undefined> {
  const waf = await awsWafState(page);
  if (waf?.stage === 'grid') return { widget: 'awswaf', frame: page.mainFrame(), box: waf.region };
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
  })()`).catch(quiet('agent/computer/human-check')) as Promise<HumanCheckWidget | undefined>;
}

/** Runs in a document: whether it holds an accepted answer (the hidden field each widget fills in once it is satisfied). */
function answeredHere(): boolean {
  const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<{ value?: string; getBoundingClientRect?(): { width: number } }> } }).document;
  // Arkose's `fc-token` holds the session token from the moment the widget loads, solved or not: it is no answer. What Arkose
  // fills once the game is won is `verification-token` (and GitHub's Octocaptcha copies it into `octocaptcha-token`).
  if (Array.from(doc.querySelectorAll('#g-recaptcha-response, [name="g-recaptcha-response"], [name="cf-turnstile-response"], [name="h-captcha-response"], [name="lot_number"], [name="geetest_validate"], [name="verification-token"], [name="octocaptcha-token"]')).some(field => (field.value ?? '').length > 8)) return true;
  // Turnstile and hCaptcha let the page name its own answer field (`response-field-name`): Steady's sign-up fills `turnstile_response`,
  // Contact Form 7 `_wpcf7_turnstile_response`. Those never read as answered, so a widget that had passed (Steady's is passed on load) was
  // pressed, watched and reported "still-there". The widget's own record of its answer is read first; then any field named for it.
  const widgets = globalThis as unknown as { turnstile?: { getResponse?(): unknown }; hcaptcha?: { getResponse?(): unknown } };
  for (const api of [widgets.turnstile, widgets.hcaptcha]) {
    try { const answer = api?.getResponse?.(); if (typeof answer === 'string' && answer.length > 8) return true; } catch { /* fail-open-ok: runs inside the page (nothing to log to); a widget API with nothing rendered throws, which counts as no answer */ }
  }
  if (Array.from(doc.querySelectorAll('input, textarea') as ArrayLike<{ name?: string; value?: string }>).some(field => /(?:turnstile|captcha)[-_]?response/i.test(field.name ?? '') && (field.value ?? '').length > 8)) return true;
  // Auth0's sign-in pages (Twilio and many more) copy the widget's token into their own hidden "captcha" field. A token is
  // hundreds of characters; a typed answer to Auth0's own text captcha (same name) is a few, so only a long value counts.
  if (Array.from(doc.querySelectorAll('input[type="hidden"][name="captcha"]')).some(field => (field.value ?? '').length > 100)) return true;
  // GeeTest shows its success state on its own button instead of filling a field the page can see at once.
  return Array.from(doc.querySelectorAll('[class*="geetest_lock_success"], [class*="geetest_success_radar"], [class*="geetest_btn_click"][class*="geetest_success"]')).some(el => (el.getBoundingClientRect?.().width ?? 0) > 0);
}

/** The frames whose fields belong to the page: same origin as the page (a sign-up form in its own frame), or a blank or srcdoc
 * frame it wrote itself. A widget's own frames (google.com, hcaptcha.com) are not the page's form. */
function pageFrames(page: Page): Frame[] {
  let origin = '';
  try { origin = new URL(page.url()).origin; } catch { return []; }
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined;
  return page.frames().filter(frame => {
    if (frame === main) return false;
    const url = frame.url();
    if (url === 'about:blank' || url === 'about:srcdoc') return true;
    try { return new URL(url).origin === origin; } catch { return false; }
  });
}

/** The page holds an accepted answer: in its own document or in one of its same-origin frames. */
export async function humanCheckAnswered(page: Page): Promise<boolean> {
  if (await page.evaluate(answeredHere).catch(() => false)) return true;
  for (const frame of pageFrames(page)) {
    if (await Promise.resolve().then(() => frame.evaluate(answeredHere)).catch(() => false)) return true;
  }
  return false;
}

/** The checks a page draws itself, each by its own finder, in one look (runs in the page). */
const IN_PAGE = `(() => {
  const geetest = ${GEETEST_STATE};
  if (geetest && geetest.state !== 'done') return 'geetest';
  if (${HOLD_BUTTON}) return 'hold';
  const pow = ${POW_STATE};
  if (pow && !pow.done) return 'pow';
  const slider = ${SLIDER};
  if (slider && !slider.slid) return 'slider';
  const text = ${TEXT_CAPTCHA};
  if (text && !text.filled) return 'text';
  if (${KNOWN_BOX}) return 'box';
  return null;
})()`;

/** A page that says in its title that it is checking the visitor: a challenge still loading, or an interstitial that lets the
 * visitor through by itself (AWS WAF's "Human Verification", Cloudflare's "Just a moment"). Waited on, never given up on. */
const VERIFYING_TITLE = /human verification|verifying you are human|confirm you are human|checking your browser|just a moment|one moment|security check(?!up)/i;
const verificationPending = async (page: Page): Promise<boolean> => {
  try { return VERIFYING_TITLE.test(await page.title()); } catch { return false; }
};

// ── is the page past the check? ──
// A widget's own word is not the answer. Cloudflare's whole-page check ("Just a moment…", "Verify you are human") fills its token field,
// rewrites its address and redraws its box while it decides, and then often issues the challenge again: each of those used to be read
// as "passed" while the visitor was still on the check page (a payment page, 2026-11-21: reported passed, never left the check, and a
// reload did not help). So an answer is only a candidate until the page has been watched for a short while with no check on it.

/** Runs in the page: whether this document is a whole-page check, by its own structure. Cloudflare's challenge page sets
 * `window._cf_chl_opt`, posts `#challenge-form` and loads its orchestrator from /cdn-cgi/challenge-platform/…/orchestrate/. */
const WHOLE_PAGE = `(() => {
  if (document.readyState === 'loading') return 'page:loading';
  if (typeof window._cf_chl_opt !== 'undefined' || document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, #challenge-error-text, script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/"]')) return 'whole-page:cloudflare';
  return 'page:ready';
})()`;

/** One look at the document: `check` when it is a whole-page check (by structure, or a title that says the visitor is being verified),
 * `unreadable` while it is loading or between two documents, else `clear`. */
async function wholePageLook(page: Page): Promise<'check' | 'clear' | 'unreadable'> {
  let read: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A page in the middle of a navigation answers only once its next document is there: that wait is bounded.
    read = await Promise.race([page.evaluate(WHOLE_PAGE), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), 2_500); })]);
  } catch { return 'unreadable'; }
  finally { clearTimeout(timer); }
  if (read === 'page:loading') return 'unreadable';
  if (typeof read === 'string' && read.startsWith('whole-page:')) return 'check';
  return await verificationPending(page) ? 'check' : 'clear';
}

/** How long the page must stay free of any check before an answer counts, and how long it is watched for that. */
const LOOK_EVERY_MS = 500, SETTLE_LOOKS = 6, WATCH_LOOKS = 30, ASKING_LOOKS = 4;

/** Watches the page after an answer. `passed`: for the whole settle no whole-page check and no challenge was on it (an embedded widget
 * holding its answer counts as no challenge; one that redraws without it does not). `challenge`: a check is plainly asking again.
 * `blocked`: the watch ended with the page still on its check, or never readable. */
export async function settledPast(page: Page, sleep: (ms: number) => Promise<void> = realSleep): Promise<{ past: 'passed' | 'challenge' | 'blocked'; seen?: string }> {
  let clean = 0, asking = 0, seen = '';
  for (let look = 0; look < WATCH_LOOKS; look++) {
    if (look) await sleep(LOOK_EVERY_MS);
    const whole = await wholePageLook(page);
    const check = whole === 'unreadable' ? undefined : await detectHumanCheck(page);
    // A widget that holds its answer is not asking; one that was redrawn or issued again has lost it.
    const asks = check ? !await humanCheckAnswered(page) : false;
    if (whole === 'clear' && !asks) {
      if (++clean >= SETTLE_LOOKS) return { past: 'passed' };
      asking = 0;
      continue;
    }
    clean = 0;
    if (check && asks) {
      seen = `the ${check.widget} check is asking again`;
      if (++asking >= ASKING_LOOKS) return { past: 'challenge', seen };
      continue;
    }
    // A whole-page check that holds an answer and is still the page is deciding (or has stopped): waited on, not answered a second time.
    asking = 0;
    seen = whole === 'check' ? `the page is still the site's verification page${await page.title().then(title => title ? ` ("${title.slice(0, 80)}")` : '', () => '')}` : 'the page did not finish loading';
  }
  return { past: 'blocked', seen };
}

/** The one answer to "is a human check in this visitor's way?", for every caller: the browser tool, the page reader
 * runner and the sign-up qualifier. `stage` says how far along it is: a box to press, a puzzle that is up, or a
 * check the page draws itself. Undefined when there is none or it already holds its answer. */
export async function detectHumanCheck(page: Page): Promise<{ widget: HumanCheckWidget; stage: 'checkbox' | 'puzzle' | 'page' } | undefined> {
  const puzzle = await findPuzzle(page);
  if (puzzle) return { widget: puzzle.widget, stage: 'puzzle' };
  // A whole-page check that holds a token and is still the page has not let the visitor through.
  if (await humanCheckAnswered(page) && await wholePageLook(page) !== 'check') return undefined;
  const checkbox = await findCheckbox(page);
  if (checkbox) return { widget: checkbox.widget, stage: 'checkbox' };
  const drawn = await page.evaluate(IN_PAGE).catch(() => null) as HumanCheckWidget | null;
  // The finders mark what they found for a solver to use; a look leaves the page as it was.
  await clearMarks(page);
  return drawn ? { widget: drawn, stage: 'page' } : undefined;
}

/** The one press, and whether the page is past the check afterwards. */
export async function pressHumanCheck(page: Page, deps: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<HumanCheckResult> {
  const pressed = await pressOnce(page, deps);
  if (pressed.outcome !== 'cleared') return pressed;
  const { past, seen } = await settledPast(page, deps.sleep ?? realSleep);
  if (past === 'passed') return pressed;
  if (await findPuzzle(page)) return { outcome: 'puzzle', ...(pressed.widget ? { widget: pressed.widget } : {}) };
  return { outcome: 'still-there', ...(pressed.widget ? { widget: pressed.widget } : {}), ...(seen ? { seen } : {}) };
}

/** The press itself. Its `cleared` is a candidate only -- the widget took the press, or the box went away -- and every caller confirms
 * it with `settledPast` before saying so. */
async function pressOnce(page: Page, deps: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<HumanCheckResult> {
  const sleep = deps.sleep ?? realSleep;
  const up = await findPuzzle(page);
  if (up) return { outcome: 'puzzle', widget: up.widget };
  const found = await findCheckbox(page);
  if (!found) return { outcome: 'none' };
  if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: found.widget };
  const x = found.box.x + Math.min(30, found.box.width * 0.15), y = found.box.y + found.box.height / 2;
  await page.mouse.move(x - 40, y - 12);
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.click(x, y);
  for (let waited = 0; waited < (deps.waitMs ?? 12_000); waited += 500) {
    await sleep(500);
    if (await findPuzzle(page)) return { outcome: 'puzzle', widget: found.widget };
    if (await humanCheckAnswered(page)) return { outcome: 'cleared', widget: found.widget };
    // A whole-page check ("Just a moment…") lets the visitor through by moving on or removing itself. A missing box is not that by
    // itself -- it is also what a check looks like while it redraws, or a frame that failed to read: only a page with no check on it
    // at all is a candidate (and the caller still watches what the page settles on). A changed address with the box still there is
    // the check deciding: watched on.
    if (!await findCheckbox(page) && !await detectHumanCheck(page)) return { outcome: 'cleared', widget: found.widget };
  }
  return { outcome: 'still-there', widget: found.widget };
}

// ── solving ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The run's one clock and stop signal. Every wait inside a solve -- a grid's passes, the watch after confirm, the wait on a
 * verifying page, proof of work, a hold, the settle -- sleeps through `sleep`, which throws `OutOfTime` once the budget is spent
 * or the caller's signal fires; every model ask gets `signal`, which fires on either too. So no inner wait outlives the run. */
export interface Budget { sleep: (ms: number) => Promise<void>; signal: AbortSignal; over: () => boolean; left: () => number }
export class OutOfTime extends Error { constructor() { super('the human check ran out of time or was stopped'); this.name = 'OutOfTime'; } }
export const isOutOfTime = (error: unknown): error is OutOfTime => error instanceof OutOfTime;

export function budgetOf(ms: number, sleep: (ms: number) => Promise<void> = realSleep, signal?: AbortSignal, now: () => number = Date.now): Budget {
  const began = now();
  const timeout = AbortSignal.timeout(Math.max(1, ms));
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const left = (): number => Math.max(0, ms - (now() - began));
  const over = (): boolean => !!signal?.aborted || left() <= 0;
  return {
    signal: stop, over, left,
    sleep: async wanted => {
      if (over()) throw new OutOfTime();
      await new Promise<void>(resolve => {
        const done = (): void => { stop.removeEventListener('abort', done); resolve(); };
        stop.addEventListener('abort', done, { once: true });
        sleep(Math.min(wanted, left())).then(done, done);
      });
      if (over()) throw new OutOfTime();
    },
  };
}

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
  /** The whole run's time limit (press, solve and settle together); four minutes by default. */
  waitMs?: number;
  /** The clock the budget is kept by (a test seam). */
  now?: () => number;
  /** The run's budget, when a caller already started one (passHumanCheck's press shares it with the solve). */
  budget?: Budget;
  /** One line per step (instruction, squares picked, what the widget said after Verify), for logs and diagnosis. */
  trace?: (line: string) => void;
  /** `refused`: Google refused the reCAPTCHA spoken clip on this connection lately, so it is not asked for (captcha-log recaptchaRefusedRecently). */
  audio?: 'untried' | 'refused';
}

const budgetFor = (deps: SolveDeps): Budget => deps.budget ?? budgetOf(deps.waitMs ?? 240_000, deps.sleep ?? realSleep, deps.signal, deps.now);

/** Answer whatever human check is on the page the way a person does, family by family, until the page holds an
 * accepted answer or the budget runs out. Rounds continue while a widget keeps asking (reCAPTCHA often serves
 * several grids) and an expired challenge is pressed again. Resolves `cleared`, `still-there` (tried, not
 * accepted) or `none` (nothing found to answer). Never throws. */
/** Picture rounds reCAPTCHA gets before its spoken clip is tried. */
export const RECAPTCHA_PICTURE_ROUNDS = 4;

/** Whether Google's "Try again later" page (its automated-queries refusal) fills the reCAPTCHA challenge: the widget is finished for this
 * session, and nothing clicked or typed into it can help. Read by its markup, not its words, which come in the visitor's language. */
export const RECAPTCHA_REFUSED = `(() => Array.from(document.querySelectorAll('.rc-doscaptcha-header, .rc-doscaptcha-body')).some(el => el.getBoundingClientRect().height > 0))()`;

export async function solveHumanCheck(page: Page, deps: SolveDeps = {}): Promise<HumanCheckResult> {
  const budget = budgetFor(deps);
  if (!deps.stateDir) return solveShownCheck(page, { ...deps, budget }, { refreshed: 0, kinds: [] });
  const log = await import('./captcha-log.js');
  const began = Date.now();
  let host = '';
  try { host = new URL(page.url()).host; } catch { host = ''; }
  // The tally is read from disk once while it is unchanged (captcha-log keeps the parsed lines): hold-off, weak kinds and the
  // reCAPTCHA refusal below share that one read.
  if (await log.shouldHoldOff(deps.stateDir, host)) {
    deps.trace?.(`holding off: ${host} refused the last three answers`);
    return { outcome: 'still-there' };
  }
  const steps: string[] = [];
  const memo: HcaptchaMemo = { refreshed: 0, kinds: [], avoid: await log.weakKinds(deps.stateDir) };
  const meter = newMeter();
  const order = await log.voterOrder(deps.stateDir);
  // Google answers a request for the spoken clip with "Try again later" once it judges the connection to be sending automated queries, and that
  // ends the widget. After one such refusal the clip is not asked for again for a while: the pictures alone keep the widget alive.
  const egress = egressOfPage(page);
  const audio = await log.recaptchaRefusedRecently(deps.stateDir, Date.now(), egress) ? 'refused' as const : 'untried' as const;
  const result = await solveShownCheck(page, { ...deps, budget, audio, trace: line => { const step = log.stepOf(line); if (step && steps.at(-1) !== step && steps.length < 12) steps.push(step); deps.trace?.(line); } }, memo, { meter, order });
  const family = log.familyOf(result.widget, steps);
  // A `none` with nothing asked and nothing done is "no check was on the page", not a run of a family: recording it
  // as one made the tally count pages the solver never saw a check on (23 of 29 "unknown" runs were these).
  if (result.outcome === 'none' && !steps.length) return result;
  await log.recordCaptcha(deps.stateDir, { at: new Date().toISOString(), host, family, outcome: result.outcome, seconds: Math.round((Date.now() - began) / 1000), steps, ...(memo.kinds.length ? { kinds: memo.kinds } : {}), ...(meter.asks ? { asks: meter.asks, models: meter.models } : {}), ...(egress ? { egress } : {}) });
  // What the site accepted is the nearest thing to a marked answer sheet: the voters are scored on it.
  if (result.outcome === 'cleared') await log.recordVotes(deps.stateDir, meter.votes);
  await log.saveSamples(deps.stateDir, result.outcome, family, meter.samples);
  return result;
}

/** The whole way past a human check, for every caller: the one press a visitor makes, then -- unless `solve` is
 * false (the user turned captcha solving off) -- the answer to whatever the press brought up or the page draws
 * itself. A press that clears is counted in the tally too: it is by far the commonest ending. The press, its watch
 * and the solve share one budget and the caller's signal. */
export async function passHumanCheck(page: Page, deps: SolveDeps & { solve?: boolean } = {}): Promise<HumanCheckResult> {
  const budget = budgetFor(deps);
  let pressed: HumanCheckResult;
  try { pressed = await pressHumanCheck(page, { sleep: budget.sleep }); }
  catch (error) {
    if (!isOutOfTime(error)) throw error;
    // Out of time before the press was judged: not passed (nothing confirmed it).
    return { outcome: 'still-there', seen: 'the time for the check ran out' };
  }
  if (pressed.outcome === 'cleared') {
    if (deps.stateDir) { let host = ''; try { host = new URL(page.url()).host; } catch { host = ''; } await (await import('./captcha-log.js')).recordCaptcha(deps.stateDir, { at: new Date().toISOString(), host, family: pressed.widget ?? 'unknown', outcome: 'cleared', seconds: 0, steps: ['press'], ...(egressOfPage(page) ? { egress: egressOfPage(page) } : {}) }); }
    return pressed;
  }
  if (deps.solve === false) return pressed;
  const solved = await solveHumanCheck(page, { ...deps, budget });
  // The press met a check but the solver then found none to answer (the challenge closed or changed in between): that is a
  // check that was tried and not passed, never "a puzzle nobody tried".
  if (solved.outcome === 'none' && pressed.outcome !== 'none') return { outcome: 'still-there', ...(pressed.widget ? { widget: pressed.widget } : {}), ...(pressed.seen ? { seen: pressed.seen } : {}) };
  return { ...solved, ...(solved.widget ?? pressed.widget ? { widget: solved.widget ?? pressed.widget } : {}) } as HumanCheckResult;
}

interface InPageMemo { tries: number; held: boolean; holds: number; textTyped: boolean; /** Something was done in the page whose verdict never showed. */ acted: boolean }

/** One go at the checks a page draws itself. A result ends the run; `acted` means something was done and the
 * page should be looked at again; undefined means nothing here could be answered. A `cleared` is only ever a
 * verdict the page showed: an answer field filled, or the check gone with nothing else in the way. */
async function inPageStep(hands: Hands, memo: InPageMemo): Promise<HumanCheckResult | 'acted' | undefined> {
  const { page, random, sleep, trace, asks } = hands;
  const settled = async (done: () => Promise<boolean>): Promise<boolean> => {
    // An in-page check shows its verdict after its own animation: watch for it before judging.
    for (let waited = 0; waited < 7_000; waited += 500) { await sleep(500); if (await done()) return true; }
    return false;
  };
  const acted = (): 'acted' => { memo.acted = true; return 'acted'; };
  const nothingLeft = async (): Promise<boolean> => !await detectHumanCheck(page);
  try {
    if (memo.tries++ === 0) {
      const work = await waitProofOfWork(page, random, sleep, trace);
      if (work === 'done') return { outcome: 'cleared', widget: 'pow' };
      // The widget went away while it worked: past it only if nothing else stands in the way now.
      if (work === 'gone') { if (await nothingLeft()) return { outcome: 'cleared', widget: 'pow' }; return acted(); }
      if (work === 'unfinished') memo.acted = true;
    }
    if (memo.held && !await page.evaluate(HOLD_BUTTON).catch(() => null)) return { outcome: 'cleared', widget: 'hold' };
    // Three holds at most: a button that is still there after that is refusing this browser, and more holds only make it surer.
    if (memo.holds < 3 && await solvePressHold(page, random, sleep, trace)) { memo.holds++; memo.held = true; await sleep(2_000); return acted(); }
    if (await geetestStep(hands)) return await settled(() => humanCheckAnswered(page)) ? { outcome: 'cleared', widget: 'geetest' } : acted();
    // A slider is past when the page says so (its field) or its box went away; a handle left at the end of its track is not a verdict.
    if (await solveSlider(hands)) return await settled(async () => await humanCheckAnswered(page) || await markGone(page, 'slider')) ? { outcome: 'cleared', widget: 'slider' } : acted();
    if (!memo.textTyped) {
      const typed = await solveTextCaptcha(page, asks.text, random, sleep, trace);
      // The characters are in the field and read back as typed: the page's check is answered as far as a visitor can tell before
      // sending the form (the site's verdict comes with the submit, which the caller makes). Anything else is not answered.
      if (typed === 'typed') { memo.textTyped = true; return { outcome: 'cleared', widget: 'text' }; }
      if (typed === 'mismatch') { memo.textTyped = true; trace?.('text captcha: the field did not hold what was typed'); return { outcome: 'still-there', widget: 'text' }; }
    }
    if (await solveChallengeBox(hands)) return await settled(async () => await humanCheckAnswered(page) || await markGone(page, 'box')) ? { outcome: 'cleared', widget: 'box' } : acted();
    return undefined;
  } finally { await clearMarks(page); }
}

/** Answers what is shown until the page is past it. An answer the widget accepted is confirmed on the page (`settledPast`); when the
 * check asks again instead, the new challenge is answered too, three times at most. */
async function solveShownCheck(page: Page, deps: SolveDeps & { budget: Budget }, hcaptcha: HcaptchaMemo, asking: Pick<AskOptions, 'meter' | 'order'> = {}): Promise<HumanCheckResult> {
  const { budget } = deps;
  for (let attempt = 1; ; attempt++) {
    const result = await answerShownCheck(page, deps, hcaptcha, asking);
    if (result.outcome !== 'cleared') return result;
    let settled: Awaited<ReturnType<typeof settledPast>>;
    try { settled = await settledPast(page, budget.sleep); }
    catch (error) { if (!isOutOfTime(error)) throw error; return { ...result, outcome: 'still-there', seen: 'the time for the check ran out before the page settled' }; }
    const { past, seen } = settled;
    if (past === 'passed') return result;
    deps.trace?.(`answer accepted, but ${seen || 'the check is still in the way'}`);
    if (past === 'blocked' || attempt >= 3 || budget.over()) return { ...result, outcome: 'still-there', ...(seen ? { seen } : {}) };
  }
}

/** One run at the check that is shown. Its `cleared` is a candidate only: the widget holds an answer or went away. */
async function answerShownCheck(page: Page, deps: SolveDeps & { budget: Budget }, hcaptcha: HcaptchaMemo, asking: Pick<AskOptions, 'meter' | 'order'> = {}): Promise<HumanCheckResult> {
  const { budget } = deps;
  const sleep = budget.sleep;
  const random = deps.random ?? Math.random;
  const hands: Hands = { page, random, sleep, asks: { ...gatewayAsks(budget.signal, asking), ...deps.asks }, ...(deps.trace ? { trace: deps.trace } : {}) };
  let widget: HumanCheckWidget | undefined;
  const ended = (outcome: HumanCheckResult['outcome']): HumanCheckResult => ({ outcome, ...(widget ? { widget } : {}) });
  const inPage: InPageMemo = { tries: 0, held: false, holds: 0, textTyped: false, acted: false };
  const viewport: ViewportMemo = {};
  try {
    return await answerLoop(page, deps, hands, hcaptcha, inPage, viewport, () => widget, found => { widget ??= found; }, ended);
  } catch (error) {
    if (!isOutOfTime(error)) throw error;
    deps.trace?.('out of time');
    return ended(await humanCheckAnswered(page) ? 'cleared' : 'still-there');
  } finally {
    await restoreViewport(page, viewport);
  }
}

async function answerLoop(page: Page, deps: SolveDeps & { budget: Budget }, hands: Hands, hcaptcha: HcaptchaMemo, inPage: InPageMemo, viewport: ViewportMemo,
  current: () => HumanCheckWidget | undefined, saw: (widget: HumanCheckWidget | undefined) => void, ended: (outcome: HumanCheckResult['outcome']) => HumanCheckResult): Promise<HumanCheckResult> {
  const { budget } = deps;
  const { sleep, random } = hands;
  let repressed = 0, arkoseStuck = 0, unread = 0, verifyWaited = false;
  let pictureRounds = 0, audio: 'untried' | 'on' | 'refused' = deps.audio ?? 'untried';
  while (!budget.over()) {
    const found = await findPuzzle(page);
    if (!found) {
      if (await humanCheckAnswered(page)) return ended('cleared');
      // The challenge may have expired ("Verification challenge expired"): the checkbox is back and a visitor
      // presses it again. Up to three presses; the answer field says whether any of them was accepted.
      if (await findCheckbox(page) && repressed < 3) {
        repressed++;
        const pressed = await pressOnce(page, { waitMs: 8_000, sleep });
        saw(pressed.widget);
        // A press the check took (it let the visitor through, or the page moved on) is the answer: nothing is left to solve.
        if (pressed.outcome === 'cleared') return ended('cleared');
        await sleep(1_500);
        continue;
      }
      // No widget: the page may draw its own check.
      if (!current() && inPage.tries < 6) {
        const step = await inPageStep(hands, inPage);
        if (step === 'acted') continue;
        if (step) return step;
      }
      // A page still saying it is verifying the visitor has not shown its check yet (or is about to let the visitor through):
      // it is given up to twenty seconds to do either, once, before anything is concluded.
      if (!verifyWaited && await verificationPending(page)) {
        verifyWaited = true;
        deps.trace?.('the page says it is verifying the visitor: waiting for its check or for it to let go');
        for (let waited = 0; waited < 20_000; waited += 1_000) {
          await sleep(1_000);
          if (await findPuzzle(page) || await findCheckbox(page) || await humanCheckAnswered(page) || !await verificationPending(page)) break;
        }
        continue;
      }
      // Nothing more to try. A check still in the way was tried and not passed; none at all is none.
      const stuck = !inPage.held && !await detectHumanCheck(page) && await wholePageLook(page) === 'check';
      // A page that never stopped verifying: what it says is written down, since this state could not be reproduced on demand.
      if (stuck) deps.trace?.(`still on a verifying page "${await page.title().catch(() => '')}": ${String(await page.evaluate(`(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)`).catch(() => '')).slice(0, 160)}`);
      // Something was done in the page (a hold, a slide, proof of work) whose verdict never showed: tried, not passed.
      return ended(inPage.held || inPage.acted || stuck || await detectHumanCheck(page) ? 'still-there' : 'none');
    }
    saw(found.widget);
    if (await humanCheckAnswered(page)) return ended('cleared');
    // Google's "Try again later": the widget is finished here. Its page used to be read as an unknown challenge and shown to the voters to
    // click on (14 of 60 failed runs on 2026-11-19/20 ended "pictures > audio > click"), which only spent asks.
    if (found.widget === 'recaptcha' && await Promise.resolve().then(() => found.frame.evaluate(RECAPTCHA_REFUSED)).catch(() => false) === true) {
      deps.trace?.('Google refused: try again later (automated queries)');
      return ended('still-there');
    }
    // Every square must be on screen to be clicked: a challenge taller than a small window is given room first (and the
    // window is put back when the run ends).
    if (await fitPuzzle(page, found.box, viewport)) { await sleep(800); continue; }
    let confirm: { x: number; x2: number; y: number; y2: number };
    if (found.widget === 'arkose') {
      // After two rounds the pictures could not be answered, the spoken challenge is tried instead.
      const played = arkoseStuck >= 2 && await arkoseAudio(hands, found.frame, found.box) ? 'played' : await playArkose(hands, found.frame, found.box);
      if (played === 'stuck') { if (++arkoseStuck >= 4) return ended('still-there'); await sleep(2_000); }
      else await sleep(2_500);
      // The game shows its next round or goes away by itself: there is no separate confirm to press here. Gone is not won: only
      // Arkose's completion token, or a page with no check left on it, is a candidate for the settle.
      if (await humanCheckAnswered(page)) return ended('cleared');
      if (!await findPuzzle(page)) return ended(await detectHumanCheck(page) ? 'still-there' : 'cleared');
      continue;
    }
    // reCAPTCHA offers the same check as a spoken clip, as a LAST resort: after RECAPTCHA_PICTURE_ROUNDS picture rounds that did not
    // clear. Asking for audio is what Google most often answers with "Try again later" (automated queries), which ends the widget for
    // the session; measured 2026-11-19/20 audio rescued 7 of 47 runs while the pictures alone cleared 35, so the pictures get more rounds.
    if (found.widget === 'recaptcha' && audio !== 'refused' && (audio === 'on' || pictureRounds >= RECAPTCHA_PICTURE_ROUNDS)) {
      const heard = await solveRecaptchaAudio(page, found.frame, found.box, hands.asks.transcribe, random, sleep, deps.trace);
      if (heard === 'refused') { audio = 'refused'; await sleep(1_000); continue; }
      audio = 'on';
      for (let waited = 0; waited < 8_000; waited += 500) { await sleep(500); if (await humanCheckAnswered(page)) return ended('cleared'); if (!await findPuzzle(page)) break; }
      continue;
    }
    pictureRounds++;
    const grid = await gridRound(hands, found.frame, found.box);
    if (grid === 'reloaded') continue;
    if (grid) confirm = grid.confirm;
    else if (found.widget === 'hcaptcha') {
      const round = await hcaptchaRound(hands, found.frame, found.box, hcaptcha);
      if (round === 'gave-up') return ended('still-there');
      if (round === 'again') continue;
      confirm = round.confirm;
    } else {
      // A challenge with no layout this solver reads (a new kind, or one still loading): the voting models are
      // shown the whole challenge and asked where a visitor would click -- clicks only, never a drag. Three such looks, then it is left.
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
