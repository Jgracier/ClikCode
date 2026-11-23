/** One press on a checkbox-style human check, and the solver that answers the puzzle behind it. */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { detectHumanCheck, passHumanCheck, pressHumanCheck, settledPast, solveHumanCheck } from './human-check.js';

type FakeFrame = { src: string; box: { x: number; y: number; width: number; height: number } | null };
function fakePage(frames: FakeFrame[], onClick: (state: { frames: FakeFrame[]; answered: boolean; url: string }) => void) {
  const state = { frames, answered: false, url: 'https://vendor.example/signup', clicks: [] as Array<[number, number]> };
  const page = {
    url: () => state.url,
    frames: () => state.frames.map(frame => ({ url: () => frame.src, evaluate: async () => null, frameElement: async () => ({ boundingBox: async () => frame.box }) })),
    evaluate: async () => state.answered,
    mouse: { move: async () => undefined, click: async (x: number, y: number) => { state.clicks.push([x, y]); onClick(state); } },
  };
  return { page: page as unknown as Page, state };
}
const noSleep = { sleep: async () => undefined, waitMs: 2_000 };
const anchor = (): FakeFrame => ({ src: 'https://www.google.com/recaptcha/api2/anchor?k=x', box: { x: 100, y: 300, width: 304, height: 78 } });
const hiddenPuzzle = (): FakeFrame => ({ src: 'https://www.google.com/recaptcha/api2/bframe?k=x', box: { x: 0, y: -9999, width: 400, height: 580 } });

describe('the human-check checkbox', () => {
  it('presses the box once, inside its left edge, and reports it cleared when the page holds an answer', async () => {
    const { page, state } = fakePage([anchor(), hiddenPuzzle()], s => { s.answered = true; });
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    expect(state.clicks).toEqual([[130, 339]]);
  });

  it('stops when the check asks for a puzzle, and never clicks inside one', async () => {
    const { page, state } = fakePage([anchor(), hiddenPuzzle()], s => { s.frames[1]!.box = { x: 80, y: 120, width: 400, height: 580 }; });
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'puzzle', widget: 'recaptcha' });
    expect(state.clicks).toHaveLength(1);
    // Asked again with the puzzle up: nothing is pressed at all.
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'puzzle', widget: 'recaptcha' });
    expect(state.clicks).toHaveLength(1);
  });

  it('counts a whole-page check that moves on or removes itself as cleared, once the page has stayed free of it', async () => {
    const gone = fakePage([{ src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x', box: { x: 40, y: 200, width: 300, height: 65 } }], s => { s.frames = []; });
    expect(await pressHumanCheck(gone.page, noSleep)).toEqual({ outcome: 'cleared', widget: 'turnstile' });
    const moved = fakePage([{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox&id=1', box: { x: 40, y: 200, width: 303, height: 78 } }], s => { s.url = 'https://vendor.example/welcome'; s.frames = []; });
    expect(await pressHumanCheck(moved.page, noSleep)).toEqual({ outcome: 'cleared', widget: 'hcaptcha' });
  });

  it('does not call a changed address passed while the box is still there unanswered', async () => {
    const rewritten = fakePage([{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox&id=1', box: { x: 40, y: 200, width: 303, height: 78 } }], s => { s.url = 'https://vendor.example/signup?__cf_chl_rt_tk=abc'; });
    // The box is still there: the press is watched on (a changed address alone is no verdict) and never called passed.
    expect(await pressHumanCheck(rewritten.page, noSleep)).toEqual({ outcome: 'still-there', widget: 'hcaptcha' });
  });

  it('says so when the press changed nothing, and when there is no checkbox', async () => {
    const stuck = fakePage([anchor()], () => undefined);
    expect(await pressHumanCheck(stuck.page, noSleep)).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
    const none = fakePage([{ src: 'https://vendor.example/embed', box: { x: 0, y: 0, width: 300, height: 70 } }, { src: 'https://www.google.com/recaptcha/api2/anchor?k=x', box: { x: 0, y: 0, width: 256, height: 60 } }].slice(0, 1), () => undefined);
    expect(await pressHumanCheck(none.page, noSleep)).toEqual({ outcome: 'none' });
    expect(none.state.clicks).toEqual([]);
  });

  it('does not press a check that is already answered', async () => {
    const { page, state } = fakePage([anchor()], () => undefined);
    state.answered = true;
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    expect(state.clicks).toEqual([]);
  });
});

// ── the solver ───────────────────────────────────────────────────────────────────────────────────────────────

/** A fake page whose mouse records every down/up pair (a click) with its full trail of moves, so the
 * human-like pacing can be checked: no two trails alike, no teleporting onto a tile. */
type SolverFrame = FakeFrame & { shot?: () => Buffer };
function solverPage(frames: SolverFrame[], onConfirm: (state: { frames: SolverFrame[]; answered: boolean }) => void = () => undefined) {
  const state = { frames, answered: false, url: 'https://vendor.example/signup', clicks: [] as Array<[number, number]>, moves: [] as Array<[number, number]>, downs: 0 };
  const page = {
    url: () => state.url,
    frames: () => state.frames.map(frame => ({ url: () => frame.src, frameElement: async () => ({ boundingBox: async () => frame.box, screenshot: async () => (frame.shot ? frame.shot() : Buffer.from('jpeg-bytes')) }) })),
    evaluate: async () => state.answered,
    mouse: {
      move: async (x: number, y: number) => { state.moves.push([x, y]); },
      click: async (x: number, y: number) => { state.moves.push([x, y]); state.clicks.push([x, y]); },
      down: async () => { state.downs++; const last = state.moves.at(-1) ?? [0, 0]; state.clicks.push([last[0], last[1]]); },
      up: async () => { if (--state.downs === 0 && state.clicks.length) { /* last release confirms */ } onConfirm(state); },
    },
  };
  return { page: page as unknown as Page, state };
}
const puzzle = (): SolverFrame => ({ src: 'https://www.google.com/recaptcha/api2/bframe?k=x', box: { x: 80, y: 120, width: 400, height: 580 } });
const fixedRandom = (): () => number => { let n = 0; return () => { n++; return (n * 0.37 % 1); }; };
const noWait = { sleep: async () => undefined, waitMs: 600, random: fixedRandom() };

/** A reCAPTCHA grid as the challenge frame's own markup gives it: nine squares of 100px and a Verify button, in
 * the frame's coordinates. */
const gridLayout = () => ({
  instruction: 'Select all images with buses', target: 'buses', dynamic: false, tileSelector: 'td.rc-imageselect-tile',
  tiles: Array.from({ length: 9 }, (_, i) => ({ x: 10 + (i % 3) * 100, y: 100 + Math.floor(i / 3) * 100, width: 100, height: 100, key: `k${i}`, selected: false })),
  verify: { x: 300, y: 520, width: 80, height: 40 },
});
/** The fake page, with frames that answer the layout reader. */
function gridPage(onDown: (state: { clicks: Array<[number, number]>; answered: boolean }) => void) {
  const made = solverPage([puzzle()]);
  const frame = { url: () => puzzle().src, parentFrame: () => null, evaluate: async (script: unknown) => typeof script === 'string' && script.includes('rc-imageselect') ? gridLayout() : String(script).includes('rc-doscaptcha') ? false : true, frameElement: async () => ({ boundingBox: async () => puzzle().box, screenshot: async () => Buffer.from('jpeg-bytes') }) };
  const page = made.page as unknown as { frames: () => unknown[]; mouse: { down: () => Promise<void>; up: () => Promise<void> } };
  page.frames = () => [frame];
  const down = page.mouse.down;
  page.mouse.down = async () => { await down(); onDown(made.state); };
  page.mouse.up = async () => { made.state.downs--; };
  return made;
}

describe('the puzzle solver', () => {
  it('asks about each square on its own, clicks the ones that match where the challenge says they are, then Verify', async () => {
    const { page, state } = gridPage(s => { if (s.clicks.length >= 3) s.answered = true; });
    let asked = 0;
    const tile = async (question: { target: string; size: number }) => { expect(question).toMatchObject({ target: 'buses', size: 3 }); const index = asked++; return index === 0 || index === 4; };
    expect(await solveHumanCheck(page, { ...noWait, asks: { tile } })).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    expect(asked).toBe(9);
    const inside = (click: [number, number], box: { x: number; y: number; width: number; height: number }) => click[0] >= 80 + box.x && click[0] <= 80 + box.x + box.width && click[1] >= 120 + box.y && click[1] <= 120 + box.y + box.height;
    const layout = gridLayout();
    expect(state.clicks).toHaveLength(3);
    expect(inside(state.clicks[0]!, layout.tiles[0]!)).toBe(true);
    expect(inside(state.clicks[1]!, layout.tiles[4]!)).toBe(true);
    expect(inside(state.clicks[2]!, layout.verify)).toBe(true);
  });

  it('answers the next grid when the widget asks again', async () => {
    // The first Verify does not clear the check; the second round's does.
    const { page, state } = gridPage(s => { if (s.clicks.length >= 4) s.answered = true; });
    let asked = 0;
    expect(await solveHumanCheck(page, { ...noWait, waitMs: 60_000, asks: { tile: async () => asked++ % 9 === 0 } })).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    expect(asked).toBe(18);
    expect(state.clicks).toHaveLength(4);
  });

  it('shows a challenge it has no reader for to the voters and clicks where they agree', async () => {
    const { page, state } = solverPage([puzzle()], s => { s.answered = true; });
    const seen: string[] = [];
    const points = async (images: Array<{ data: string }>) => { seen.push(images[0]!.data); return [{ x: 0.5, y: 0.5 }]; };
    expect(await solveHumanCheck(page, { ...noWait, asks: { points } })).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    // The picture the voters saw was the challenge frame's own screenshot; the click landed at its centre.
    expect(seen[0]).toBe(Buffer.from('jpeg-bytes').toString('base64'));
    expect(Math.abs(state.clicks[0]![0] - 280)).toBeLessThan(5);
    expect(Math.abs(state.clicks[0]![1] - 410)).toBeLessThan(5);
  });

  it("ends at Google's \"Try again later\" page instead of showing it to the voters as a challenge to click", async () => {
    const made = solverPage([puzzle()]);
    const frame = { url: () => puzzle().src, parentFrame: () => null, evaluate: async (script: unknown) => String(script).includes('rc-doscaptcha-header') ? true : null, frameElement: async () => ({ boundingBox: async () => puzzle().box, screenshot: async () => Buffer.from('jpeg-bytes') }) };
    (made.page as unknown as { frames: () => unknown[] }).frames = () => [frame];
    let pointed = 0;
    const lines: string[] = [];
    expect(await solveHumanCheck(made.page, { ...noWait, asks: { points: async () => { pointed++; return [{ x: 0.5, y: 0.5 }]; } }, trace: line => lines.push(line) })).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
    expect(pointed).toBe(0);
    expect(made.state.clicks).toEqual([]);
    expect(lines).toEqual(['Google refused: try again later (automated queries)']);
  });

  it('gives up on a challenge nobody can read after three looks, without clicking anything', async () => {
    const { page, state } = solverPage([puzzle()]);
    let looks = 0;
    expect(await solveHumanCheck(page, { ...noWait, waitMs: 60_000, asks: { points: async () => { looks++; return undefined; } } })).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
    expect(looks).toBe(3);
    expect(state.clicks).toEqual([]);
  });

  it('says none when there is nothing to answer and the page holds no accepted answer', async () => {
    expect(await solveHumanCheck(solverPage([]).page, noWait)).toEqual({ outcome: 'none' });
  });

  it('never sends the same mouse trail twice: two solves differ in their move paths', async () => {
    const trails: number[][] = [];
    for (let run = 0; run < 2; run++) {
      const { page, state } = solverPage([puzzle()], s => { s.answered = true; });
      await solveHumanCheck(page, { ...noWait, random: Math.random, asks: { points: async () => [{ x: 0.3, y: 0.3 }] } });
      // The cursor wanders to the spot through several moves instead of teleporting onto it.
      expect(state.moves.length).toBeGreaterThanOrEqual(3);
      trails.push(state.moves.map(([x, y]) => Math.round(x * 10 + y)));
    }
    expect(trails[0]).not.toEqual(trails[1]);
  });
});

describe('what is in the way', () => {
  const pageWith = (frames: FakeFrame[], drawn: string | null, answered = false) => ({
    url: () => 'https://vendor.example/signup',
    frames: () => frames.map(frame => ({ url: () => frame.src, parentFrame: () => null, evaluate: async () => null, frameElement: async () => ({ boundingBox: async () => frame.box }) })),
    evaluate: async (script: unknown) => typeof script === 'string' ? drawn : answered,
  }) as unknown as Page;

  it('names a box to press, a puzzle that is up, and a check the page draws itself', async () => {
    expect(await detectHumanCheck(pageWith([anchor(), hiddenPuzzle()], null))).toEqual({ widget: 'recaptcha', stage: 'checkbox' });
    expect(await detectHumanCheck(pageWith([anchor(), puzzle()], null))).toEqual({ widget: 'recaptcha', stage: 'puzzle' });
    expect(await detectHumanCheck(pageWith([{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge', box: puzzle().box }], null))).toEqual({ widget: 'hcaptcha', stage: 'puzzle' });
    expect(await detectHumanCheck(pageWith([], 'geetest'))).toEqual({ widget: 'geetest', stage: 'page' });
    expect(await detectHumanCheck(pageWith([], 'hold'))).toEqual({ widget: 'hold', stage: 'page' });
  });

  it('names a challenge by its markup when the frame is served from another domain', async () => {
    // Onfleet got hCaptcha's challenge in a frame under the customer's domain: the URL says nothing, the markup does.
    const frame = { url: () => 'https://onfleet.com/challenge', parentFrame: () => null, evaluate: async (script: unknown) => String(script).includes('task-image') ? 'hcaptcha' : null, frameElement: async () => ({ boundingBox: async () => puzzle().box }) };
    const page = { url: () => 'https://onfleet.com/signup', frames: () => [frame], evaluate: async () => false } as unknown as Page;
    expect(await detectHumanCheck(page)).toEqual({ widget: 'hcaptcha', stage: 'puzzle' });
  });

  it('sees nothing on a plain page, behind an invisible badge, or once the check holds its answer', async () => {
    expect(await detectHumanCheck(pageWith([], null))).toBeUndefined();
    expect(await detectHumanCheck(pageWith([{ src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible', box: { x: 900, y: 600, width: 256, height: 60 } }], null))).toBeUndefined();
    expect(await detectHumanCheck(pageWith([anchor()], null, true))).toBeUndefined();
  });
});

describe('GeeTest board games, worked out by rule', () => {
  const board = (rows: string[]) => rows.flatMap((line, row) => [...line].map((ch, column) => ({ row, column, kind: ch === '.' ? null : ch })));

  it('finds the piece and the empty cell that line up five', async () => {
    const { lineUpMove } = await import('./human-check-geetest.js');
    // Column 4 holds four whites with a hole in row 2; the stray white at row 3 column 2 fills it.
    const move = lineUpMove(board(['...w.', '....y', '.w.w.', '...w.', '...w.']));
    expect(move && [move.from.row, move.from.column, move.to.row, move.to.column]).toEqual([2, 1, 1, 3]);
    expect(lineUpMove(board(['.....', '.....', '..w..', '.....', '.....']))).toBeUndefined();
  });

  it('finds the two neighbours to swap for three in a row', async () => {
    const { swapMove } = await import('./human-check-geetest.js');
    const move = swapMove(board(['aba', 'cbd', 'bac']));
    // Swapping row 3's first two gives column 2 three b's.
    expect(move && [move.from.row, move.from.column, move.to.row, move.to.column]).toEqual([2, 0, 2, 1]);
    expect(swapMove(board(['abc', 'def', 'ghi']))).toBeUndefined();
  });
});

describe('AWS WAF CAPTCHA', () => {
  /** A page that is AWS WAF's own challenge: it answers the widget's one in-page look with the state given. */
  const wafPage = (state: unknown) => ({
    url: () => 'https://vendor.example/signup',
    frames: () => [],
    mainFrame: () => ({ url: () => 'https://vendor.example/signup' }),
    evaluate: async (script: unknown) => typeof script === 'string' && script.includes('amzn-captcha-root') ? state : null,
  }) as unknown as Page;

  it('is a press-box on its Begin splash and a puzzle once the grid is up', async () => {
    expect(await detectHumanCheck(wafPage({ stage: 'begin', begin: { x: 583, y: 318, width: 116, height: 32 } }))).toEqual({ widget: 'awswaf', stage: 'checkbox' });
    expect(await detectHumanCheck(wafPage({ stage: 'grid', region: { x: 480, y: 20, width: 320, height: 470 } }))).toEqual({ widget: 'awswaf', stage: 'puzzle' });
    expect(await detectHumanCheck(wafPage(null))).toBeUndefined();
  });

  it('presses Begin where the button is, and reports the grid that follows as a puzzle', async () => {
    const clicks: Array<[number, number]> = [];
    let pressed = false;
    const page = {
      url: () => 'https://vendor.example/signup',
      frames: () => [],
      mainFrame: () => ({ url: () => 'https://vendor.example/signup' }),
      evaluate: async (script: unknown) => typeof script === 'string' && script.includes('amzn-captcha-root')
        ? (pressed ? { stage: 'grid', region: { x: 480, y: 20, width: 320, height: 470 } } : { stage: 'begin', begin: { x: 583, y: 318, width: 116, height: 32 } })
        : false,
      mouse: { move: async () => undefined, click: async (x: number, y: number) => { clicks.push([x, y]); pressed = true; } },
    } as unknown as Page;
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'puzzle', widget: 'awswaf' });
    // Inside the button, near its left edge like a box press, never outside it.
    expect(clicks).toHaveLength(1);
    expect(clicks[0]![0]).toBeGreaterThanOrEqual(583);
    expect(clicks[0]![0]).toBeLessThanOrEqual(699);
    expect(clicks[0]![1]).toBeGreaterThanOrEqual(318);
    expect(clicks[0]![1]).toBeLessThanOrEqual(350);
  });

  it('waits out a page that says it is verifying the visitor, then solves the check it shows', async () => {
    // "Human Verification" for the first looks (AWS WAF's silent interstitial), then the Begin splash, then nothing once pressed.
    let looks = 0, pressed = false;
    const page = {
      url: () => 'https://vendor.example/signup',
      title: async () => (pressed || looks > 3 ? 'Sign up' : 'Human Verification'),
      frames: () => [],
      mainFrame: () => ({ url: () => 'https://vendor.example/signup' }),
      evaluate: async (script: unknown) => {
        if (typeof script !== 'string' || !script.includes('amzn-captcha-root')) return false;
        looks++;
        return looks > 3 && !pressed ? { stage: 'begin', begin: { x: 583, y: 318, width: 116, height: 32 } } : null;
      },
      mouse: { move: async () => undefined, down: async () => undefined, up: async () => undefined, click: async () => { pressed = true; } },
    } as unknown as Page;
    const { solveHumanCheck } = await import('./human-check.js');
    const out = await solveHumanCheck(page, { sleep: async () => undefined, waitMs: 60_000 });
    expect(out).toEqual({ outcome: 'cleared', widget: 'awswaf' });
    expect(pressed).toBe(true);
  });

  it('is still "there", not "none", when the page never stops saying it is verifying', async () => {
    const page = { url: () => 'https://vendor.example/', title: async () => 'Just a moment...', frames: () => [], mainFrame: () => ({}), evaluate: async () => null } as unknown as Page;
    const { solveHumanCheck } = await import('./human-check.js');
    expect((await solveHumanCheck(page, { sleep: async () => undefined, waitMs: 60_000 })).outcome).toBe('still-there');
  });

  it('reads the grid in page coordinates, with no frame offset added, and photographs its own region', async () => {
    const { readLayout } = await import('./human-check-grid.js');
    const read = { instruction: 'Choose all the beds', target: 'the beds', tiles: [{ x: 480, y: 80, width: 104, height: 104, key: '0', selected: false }], verify: { x: 480, y: 420, width: 92, height: 32 }, dynamic: false, tileSelector: 'button.amzn-grid-cell', region: { x: 480, y: 20, width: 320, height: 470 } };
    const frame = { evaluate: async () => read } as never;
    const layout = await readLayout(frame, { x: 480, y: 20, width: 320, height: 470 });
    expect(layout?.tiles[0]).toMatchObject({ x: 480, y: 80 });
    expect(layout?.verify).toMatchObject({ x: 480, y: 420 });
    expect(layout?.region).toEqual(read.region);
    expect(layout?.target).toBe('the beds');
  });
});

describe('an hCaptcha round', () => {
  /** A challenge frame that says what it asks, takes clicks and drags, and shows the same picture every time (a still puzzle). */
  function round(instruction: string, asks: { points?: Array<{ x: number; y: number }>; drags?: Array<{ n: number; from: { x: number; y: number }; to: { x: number; y: number } }> }, dragBuilt = false) {
    const log: string[] = [];
    const frame = {
      evaluate: async (script: unknown) => {
        const text = String(script);
        if (text.includes('draggable')) return dragBuilt;
        if (text.includes('prompt-text')) return instruction;
        if (text.includes('.refresh')) return { x: 300, y: 10, width: 20, height: 20 };
        if (text.includes('.button-submit')) return { x: 280, y: 520, width: 90, height: 40 };
        return null;
      },
      frameElement: async () => ({ screenshot: async () => Buffer.from('still-picture') }),
    };
    const page = { mouse: { move: async () => undefined, down: async () => { log.push('down'); }, up: async () => { log.push('up'); } } } as unknown as Page;
    const ask = { points: async () => { log.push('asked-points'); return asks.points; }, drags: async () => { log.push('asked-drags'); return asks.drags; } };
    const hands = { page, random: () => 0.5, sleep: async () => undefined, asks: ask as never };
    return { frame: frame as never, hands, log };
  }
  const box = { x: 100, y: 100, width: 400, height: 580 };

  it('drags when the models agree on a drag, and never clicks', async () => {
    const { hcaptchaRound } = await import('./human-check-hcaptcha.js');
    const r = round('Please drag the segments on the right to complete the line', { drags: [{ n: 1, from: { x: 0.8, y: 0.3 }, to: { x: 0.5, y: 0.4 } }] }, true);
    const out = await hcaptchaRound(r.hands, r.frame, box, { refreshed: 0, kinds: [] });
    expect(out).toHaveProperty('confirm');
    expect(r.log).toEqual(expect.arrayContaining(['asked-drags', 'down', 'up']));
    expect(r.log).not.toContain('asked-points');
  });

  it('swaps a drag challenge it cannot agree on, instead of clicking where the models would have pointed', async () => {
    const { hcaptchaRound } = await import('./human-check-hcaptcha.js');
    const r = round('Please drag the segments on the right to complete the line', { points: [{ x: 0.83, y: 0.32 }], drags: [] }, true);
    const memo = { refreshed: 0, kinds: [] as string[] };
    expect(await hcaptchaRound(r.hands, r.frame, box, memo)).toBe('again');
    expect(memo.refreshed).toBe(1);
    // It asked for a drag only, and the one thing pressed was the refresh button.
    expect(r.log).not.toContain('asked-points');
    expect(r.log.filter(line => line === 'down')).toHaveLength(1);
  });

  it('clicks a challenge that is not a drag, and tries a drag only when nothing was agreed to click', async () => {
    const { hcaptchaRound } = await import('./human-check-hcaptcha.js');
    const clicks = round('Click on the two rings that are not linked', { points: [{ x: 0.3, y: 0.4 }, { x: 0.6, y: 0.6 }] });
    expect(await hcaptchaRound(clicks.hands, clicks.frame, box, { refreshed: 0, kinds: [] })).toHaveProperty('confirm');
    expect(clicks.log).not.toContain('asked-drags');
    const unsure = round('Pick the odd one out', { points: [], drags: [{ n: 1, from: { x: 0.1, y: 0.1 }, to: { x: 0.2, y: 0.2 } }] });
    await hcaptchaRound(unsure.hands, unsure.frame, box, { refreshed: 0, kinds: [] });
    expect(unsure.log).toEqual(expect.arrayContaining(['asked-points', 'asked-drags']));
  });
});

describe('hCaptcha challenge kinds', () => {
  it('drops the particulars so two challenges of one kind are counted together', async () => {
    const { promptKind } = await import('./human-check-hcaptcha.js');
    expect(promptKind('Drag the 3 segments to complete the line!')).toBe(promptKind('Drag the 2 segments to complete the line'));
    expect(promptKind('Please click on the object that is different from the others in the picture')).toBe('please click on the object that');
  });
});

// ── past the check, or only answered ─────────────────────────────────────────────────────────────────────────

/** A page whose every look is scripted: `at(look)` says what the document is at that moment. One look is one read of the whole-page
 * script, which every watch makes first. */
type Moment = { whole?: 'cloudflare' | 'loading' | 'unreadable'; box?: boolean; answered?: boolean; title?: string };
function scriptedPage(at: (look: number, pressed: number) => Moment) {
  const state = { looks: 0, pressed: 0, url: 'https://pay.example/checkout' };
  const now = (): Moment => at(state.looks, state.pressed);
  const turnstile = { url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x', parentFrame: () => null, evaluate: async () => null, frameElement: async () => ({ boundingBox: async () => ({ x: 40, y: 200, width: 300, height: 65 }) }) };
  const page = {
    url: () => state.url,
    title: async () => now().title ?? (now().whole === 'cloudflare' ? 'Just a moment...' : 'Checkout'),
    frames: () => (now().box ? [turnstile] : []),
    evaluate: async (script: unknown) => {
      if (typeof script !== 'string') return now().answered ?? false;
      if (!script.includes('_cf_chl_opt')) return null;
      state.looks++;
      const whole = now().whole;
      if (whole === 'unreadable') throw new Error('Execution context was destroyed');
      return whole === 'cloudflare' ? 'whole-page:cloudflare' : whole === 'loading' ? 'page:loading' : 'page:ready';
    },
    mouse: { move: async () => undefined, click: async () => { state.pressed++; } },
  };
  return { page: page as unknown as Page, state };
}
const instant = async (): Promise<void> => undefined;

describe('whether the page is past the check', () => {
  it('is not past a whole-page check that took the press, filled its token and rewrote its address, but is still the page', async () => {
    // Cloudflare's interstitial after the press: the box is ticked and the token field is filled, and the challenge page stays.
    const { page, state } = scriptedPage((_look, pressed) => ({ whole: 'cloudflare', box: true, answered: pressed > 0 }));
    const result = await pressHumanCheck(page, { sleep: instant, waitMs: 2_000 });
    expect(result).toEqual({ outcome: 'still-there', widget: 'turnstile', seen: 'the page is still the site\'s verification page ("Just a moment...")' });
    expect(state.pressed).toBe(1);
    // The whole way (press, then the solver) says the same, and never "cleared".
    const again = await passHumanCheck(page, { sleep: instant, waitMs: 2_000 });
    expect(again.outcome).toBe('still-there');
    expect(again.seen).toContain('still the site\'s verification page');
  });

  it('is not past a check whose box goes away for a moment and is then issued again', async () => {
    // While it decides the box is gone (two looks); then the same challenge is back, unanswered.
    let goneSince: number | undefined;
    const { page } = scriptedPage((look, pressed) => {
      if (!pressed) return { whole: 'cloudflare', box: true };
      goneSince ??= look;
      return { whole: 'cloudflare', box: look - goneSince >= 2 };
    });
    const result = await pressHumanCheck(page, { sleep: instant, waitMs: 2_000 });
    expect(result).toEqual({ outcome: 'still-there', widget: 'turnstile', seen: 'the turnstile check is asking again' });
  });

  it('is not past an embedded widget that reported success and then lost its answer', async () => {
    const { page } = scriptedPage(look => ({ box: true, answered: look <= 3 }));
    expect(await settledPast(page, instant)).toEqual({ past: 'challenge', seen: 'the turnstile check is asking again' });
  });

  it('is past an embedded widget that keeps its answer through the settle', async () => {
    const { page, state } = scriptedPage(() => ({ box: true, answered: true }));
    expect(await settledPast(page, instant)).toEqual({ past: 'passed' });
    // Not on the first look: the page was watched for the whole settle.
    expect(state.looks).toBeGreaterThanOrEqual(6);
  });

  it('is past a whole-page check once the real page has replaced it and stayed', async () => {
    // The press is taken, the challenge page navigates (unreadable, then loading), and the site's own page is there.
    let since: number | undefined;
    const { page } = scriptedPage((look, pressed) => {
      if (!pressed) return { whole: 'cloudflare', box: true };
      since ??= look;
      const step = look - since;
      return step < 2 ? { whole: 'cloudflare', box: true, answered: true } : step < 3 ? { whole: 'unreadable' } : step < 4 ? { whole: 'loading' } : {};
    });
    expect(await pressHumanCheck(page, { sleep: instant, waitMs: 2_000 })).toEqual({ outcome: 'cleared', widget: 'turnstile' });
  });

  it('starts the settle again when the challenge page comes back after a reload', async () => {
    // Free of any check for four looks (a reload under way), then the challenge page again: never six clean looks in a row.
    const { page } = scriptedPage(look => (look % 6 < 4 ? {} : { whole: 'cloudflare' }));
    expect(await settledPast(page, instant)).toEqual({ past: 'blocked', seen: 'the page is still the site\'s verification page ("Just a moment...")' });
  });

  it('still names a whole-page check that holds a token as a check in the way', async () => {
    const blocked = scriptedPage(() => ({ whole: 'cloudflare', box: true, answered: true }));
    expect(await detectHumanCheck(blocked.page)).toEqual({ widget: 'turnstile', stage: 'checkbox' });
    const embedded = scriptedPage(() => ({ box: true, answered: true }));
    expect(await detectHumanCheck(embedded.page)).toBeUndefined();
  });

  it('does not report an answer the solver got accepted while the verification page stays', async () => {
    const { page } = scriptedPage(() => ({ whole: 'cloudflare', answered: true }));
    const traced: string[] = [];
    const result = await solveHumanCheck(page, { sleep: instant, waitMs: 2_000, trace: line => traced.push(line) });
    expect(result.outcome).toBe('still-there');
    expect(result.seen).toContain('still the site\'s verification page');
    expect(traced.some(line => line.startsWith('answer accepted, but the page is still'))).toBe(true);
  });
});

// ── audited fixes ───────────────────────────────────────────────────────────────────────────────────────────

describe('a text captcha is only a field the page says is one', () => {
  const rule = async () => { const { TEXT_CAPTCHA_RULE } = await import('./human-check-inpage.js'); return (0, eval)(TEXT_CAPTCHA_RULE) as (field: Record<string, unknown>, picture: { named: boolean; distance: number } | null) => boolean; };
  const field = (over: Record<string, unknown> = {}) => ({ nameId: 'code ', label: '', block: '', autocomplete: '', formHasCard: false, ...over });
  const logo = { named: false, distance: 120 };

  it('leaves one-time codes and card security codes alone, whatever picture is beside them', async () => {
    const isCaptcha = await rule();
    expect(isCaptcha(field({ label: 'Verification code' }), logo)).toBe(false);
    expect(isCaptcha(field({ label: 'Security code' }), logo)).toBe(false);
    expect(isCaptcha(field({ label: 'Verification code', autocomplete: 'one-time-code' }), { named: true, distance: 50 })).toBe(false);
    expect(isCaptcha(field({ nameId: 'otp ', label: 'Code' }), { named: true, distance: 50 })).toBe(false);
    expect(isCaptcha(field({ label: 'Security code', autocomplete: 'cc-csc' }), { named: true, distance: 50 })).toBe(false);
    expect(isCaptcha(field({ label: 'Security code', formHasCard: true }), { named: true, distance: 50 })).toBe(false);
    expect(isCaptcha(field({ label: 'Enter code', block: 'Enter the verification code we sent to your phone' }), { named: true, distance: 50 })).toBe(false);
  });

  it('takes a captcha-named field, an instruction naming the picture, or a code field beside a captcha picture', async () => {
    const isCaptcha = await rule();
    expect(isCaptcha(field({ nameId: 'captcha_answer ' }), logo)).toBe(true);
    expect(isCaptcha(field({ nameId: 'VERIFY VERIFY', block: 'To help stop spam, please type the text here that you see in the image below.' }), logo)).toBe(true);
    expect(isCaptcha(field({ label: 'Security code' }), { named: true, distance: 90 })).toBe(true);
    expect(isCaptcha(field({ nameId: 'captcha ' }), null)).toBe(false);
  });
});

describe('after typing a text captcha', () => {
  const textPage = (holds: (typed: string) => string) => {
    let typed = '';
    const field = { click: async () => undefined, fill: async () => { typed = ''; }, inputValue: async () => holds(typed) };
    const page = { evaluate: async () => ({ filled: false }), locator: () => ({ first: () => ({ ...field, screenshot: async () => Buffer.from('png') }) }), keyboard: { type: async (char: string) => { typed += char; } } };
    return page as unknown as Page;
  };
  it('reports typed only when the field reads back what was typed', async () => {
    const { solveTextCaptcha } = await import('./human-check-inpage.js');
    expect(await solveTextCaptcha(textPage(typed => typed), async () => 'x7Kp2', () => 0.5, async () => undefined)).toBe('typed');
    expect(await solveTextCaptcha(textPage(() => ''), async () => 'x7Kp2', () => 0.5, async () => undefined)).toBe('mismatch');
  });

  it('reads the picture once it has been drawn, not the stand-in it shows first (NeutrinoAPI: "Generating..." for 3 s, then drawn over 7 s)', async () => {
    const { solveTextCaptcha } = await import('./human-check-inpage.js');
    let clock = 0, typed = '';
    // A stand-in for the first 3 s, then the code painted in over 7 s, then still.
    const picture = () => Buffer.from(clock < 3_000 ? 'generating' : clock < 10_000 ? `drawing-${clock}` : 'code');
    const field = { click: async () => undefined, fill: async () => { typed = ''; }, inputValue: async () => typed, screenshot: async () => picture() };
    const page = { evaluate: async () => ({ filled: false }), locator: () => ({ first: () => field }), keyboard: { type: async (char: string) => { typed += char; } } } as unknown as Page;
    const read: string[] = [];
    expect(await solveTextCaptcha(page, async image => { read.push(Buffer.from(image.data, 'base64').toString()); return 'x7Kp2'; }, () => 0.5, async ms => { clock += ms; })).toBe('typed');
    expect(read[0]).toBe('code');
    // A picture that never changes is read once it has held still, without waiting out the whole watch.
    clock = 0; read.length = 0;
    const still = { ...field, screenshot: async () => Buffer.from('static') };
    const stillPage = { ...page, locator: () => ({ first: () => still }) } as unknown as Page;
    await solveTextCaptcha(stillPage, async image => { read.push(Buffer.from(image.data, 'base64').toString()); return 'x7Kp2'; }, () => 0.5, async ms => { clock += ms; });
    expect(read).toEqual(['static']);
    expect(clock).toBeLessThan(6_000);
  });
});

describe('the run has one budget', () => {
  /** A clock that only moves when the solver sleeps. */
  const clock = () => { let at = 0; const slept: number[] = []; return { now: () => at, sleep: async (ms: number) => { slept.push(ms); at += ms; }, total: () => slept.reduce((a, b) => a + b, 0) }; };

  it('stops the press and its watch at the budget, not after them', async () => {
    const stuck = fakePage([anchor()], () => undefined);
    const time = clock();
    expect((await passHumanCheck(stuck.page, { sleep: time.sleep, now: time.now, waitMs: 3_000, solve: false })).outcome).toBe('still-there');
    expect(time.total()).toBeLessThanOrEqual(3_000);
  });

  it('stops inside a round (the watch after confirm) when the budget is spent', async () => {
    const { page } = gridPage(() => undefined);
    const time = clock();
    const result = await solveHumanCheck(page, { ...noWait, sleep: time.sleep, now: time.now, waitMs: 5_000, asks: { tile: async () => false } });
    expect(result.outcome).toBe('still-there');
    expect(time.total()).toBeLessThanOrEqual(5_000);
  });

  it('stops every wait and hands the ask a signal that fires when the caller stops', async () => {
    const { page } = gridPage(() => undefined);
    const stop = new AbortController();
    let seen: AbortSignal | undefined;
    const sleep = async () => { stop.abort(); };
    const result = await solveHumanCheck(page, { ...noWait, sleep, waitMs: 60_000, signal: stop.signal, asks: { tile: async () => false } });
    expect(result.outcome).toBe('still-there');
    const { budgetOf } = await import('./human-check.js');
    const caller = new AbortController();
    const budget = budgetOf(60_000, async () => undefined, caller.signal);
    seen = budget.signal;
    caller.abort();
    expect(seen.aborted).toBe(true);
    await expect(budget.sleep(10)).rejects.toThrow(/ran out of time or was stopped/);
  });
});

describe('a checkbox scrolled out of view', () => {
  it('is scrolled back into view when it sits above the fold, and then pressed', async () => {
    const frame: FakeFrame = { src: 'https://www.google.com/recaptcha/api2/anchor?k=x', box: { x: 100, y: -200, width: 304, height: 78 } };
    const clicks: Array<[number, number]> = [];
    let answered = false;
    const page = {
      url: () => 'https://vendor.example/signup',
      frames: () => [{ url: () => frame.src, evaluate: async () => null, frameElement: async () => ({ boundingBox: async () => frame.box, evaluate: async () => { frame.box = { ...frame.box!, y: 300 }; return 'scrolled'; } }) }],
      evaluate: async () => answered,
      mouse: { move: async () => undefined, click: async (x: number, y: number) => { clicks.push([x, y]); answered = true; } },
    } as unknown as Page;
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    expect(clicks).toEqual([[130, 339]]);
  });
});

describe('the answer field', () => {
  const withDocument = async <T>(fields: Record<string, string>, run: () => Promise<T>): Promise<T> => {
    const g = globalThis as unknown as { document?: unknown };
    const before = g.document;
    g.document = { querySelectorAll: (selector: string) => selector === 'input, textarea' ? Object.entries(fields).map(([name, value]) => ({ name, value })) : Object.entries(fields).filter(([name]) => selector.includes(`[name="${name}"]`)).map(([, value]) => ({ value })) };
    try { return await run(); } finally { g.document = before; }
  };
  const pageWith = (frames: Array<{ url: string; fields: Record<string, string> }>) => ({
    url: () => 'https://vendor.example/signup',
    evaluate: async () => false,
    mainFrame: () => undefined,
    frames: () => frames.map(frame => ({ url: () => frame.url, evaluate: (fn: () => boolean) => withDocument(frame.fields, async () => fn()) })),
  }) as unknown as Page;

  it('is read in the page\'s own frames too, never in a widget\'s', async () => {
    const { humanCheckAnswered } = await import('./human-check.js');
    const token = 'x'.repeat(40);
    expect(await humanCheckAnswered(pageWith([{ url: 'https://vendor.example/form', fields: { 'g-recaptcha-response': token } }]))).toBe(true);
    expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: { 'h-captcha-response': token } }]))).toBe(true);
    expect(await humanCheckAnswered(pageWith([{ url: 'https://www.google.com/recaptcha/api2/anchor', fields: { 'g-recaptcha-response': token } }]))).toBe(false);
  });

  it("reads Turnstile's answer from a field the page named itself, or from the widget, and only once it is filled", async () => {
    const { humanCheckAnswered } = await import('./human-check.js');
    const token = '0.' + 'x'.repeat(750);
    // Steady's sign-up (passed on load) and Contact Form 7 (esign.co.uk, filled after the press), seen live 2026-11-23.
    expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: { turnstile_response: token } }]))).toBe(true);
    expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: { _wpcf7_turnstile_response: token } }]))).toBe(true);
    expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: { _wpcf7_turnstile_response: '' } }]))).toBe(false);
    const g = globalThis as unknown as { turnstile?: unknown };
    try {
      g.turnstile = { getResponse: () => token };
      expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: {} }]))).toBe(true);
      g.turnstile = { getResponse: () => undefined };
      expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: {} }]))).toBe(false);
      g.turnstile = { getResponse: () => { throw new Error('no widget'); } };
      expect(await humanCheckAnswered(pageWith([{ url: 'about:srcdoc', fields: {} }]))).toBe(false);
    } finally { delete g.turnstile; }
  });

  it("counts Arkose's completion token, not the session token it holds from the start", async () => {
    const { humanCheckAnswered } = await import('./human-check.js');
    const token = '123.456|r=us-east-1|meta=3|pk=x';
    expect(await humanCheckAnswered(pageWith([{ url: 'https://vendor.example/form', fields: { 'fc-token': token } }]))).toBe(false);
    expect(await humanCheckAnswered(pageWith([{ url: 'https://vendor.example/form', fields: { 'fc-token': token, 'verification-token': token } }]))).toBe(true);
  });
});

describe('failing closed', () => {
  it('does not take an unreadable page for finished proof of work', async () => {
    const { waitProofOfWork } = await import('./human-check-inpage.js');
    const reads = (seq: Array<unknown>) => { let i = 0; return { evaluate: async () => { const next = seq[Math.min(i++, seq.length - 1)]; if (next instanceof Error) throw next; return next; } } as unknown as Page; };
    const working = { done: false, press: null, kind: 'ALTCHA' };
    expect(await waitProofOfWork(reads([working, new Error('navigating')]), () => 0.5, async () => undefined)).toBe('unfinished');
    expect(await waitProofOfWork(reads([working, new Error('navigating'), { ...working, done: true }]), () => 0.5, async () => undefined)).toBe('done');
    expect(await waitProofOfWork(reads([working, null]), () => 0.5, async () => undefined)).toBe('gone');
  });

  it('does not drag a slider whose handle is already at the end, nor call it passed', async () => {
    const { solveSlider } = await import('./human-check-inpage.js');
    const page = { evaluate: async () => ({ slid: true }) } as unknown as Page;
    expect(await solveSlider({ page, random: () => 0.5, sleep: async () => undefined, asks: {} as never })).toBe(false);
  });

  it('puts the viewport back after growing it for a tall challenge', async () => {
    const { fitPuzzle, restoreViewport } = await import('./human-check-hands.js');
    const sizes: Array<{ width: number; height: number }> = [];
    const page = { evaluate: async () => [800, 500], viewportSize: () => ({ width: 800, height: 500 }), setViewportSize: async (size: { width: number; height: number }) => { sizes.push(size); } } as unknown as Page;
    const memo = {};
    expect(await fitPuzzle(page, { x: 10, y: 10, width: 400, height: 600 }, memo)).toBe(true);
    await restoreViewport(page, memo);
    expect(sizes).toEqual([{ width: 800, height: 720 }, { width: 800, height: 500 }]);
    await restoreViewport(page, memo);
    expect(sizes).toHaveLength(2);
  });

  it('leaves no marks on the page after looking for a check', async () => {
    const { CLEAR_MARKS } = await import('./human-check-hands.js');
    const scripts: unknown[] = [];
    const page = { url: () => 'https://vendor.example/', frames: () => [], evaluate: async (script: unknown) => { scripts.push(script); return null; }, title: async () => '' } as unknown as Page;
    await detectHumanCheck(page);
    expect(scripts.at(-1)).toBe(CLEAR_MARKS);
  });

  it('never releases a held button late: a stopped click still lets go', async () => {
    const { visitorClick } = await import('./human-check-hands.js');
    let down = 0;
    const mouse = { move: async () => undefined, down: async () => { down++; }, up: async () => { down--; } } as unknown as Page['mouse'];
    let calls = 0;
    const sleep = async () => { if (++calls === 2) throw new Error('stopped'); };
    await expect(visitorClick(mouse, { x: 0, x2: 10, y: 0, y2: 10 }, () => 0.5, sleep)).rejects.toThrow('stopped');
    expect(down).toBe(0);
  });
});

describe('an hCaptcha drag is read from its structure', () => {
  it('asks a drag-built challenge as a drag only, whatever language its words are in', async () => {
    const { hcaptchaRound, DRAG_STRUCTURE } = await import('./human-check-hcaptcha.js');
    const asked: string[] = [];
    const frame = { evaluate: async (script: unknown) => script === DRAG_STRUCTURE ? true : String(script).includes('prompt-text') ? 'Ziehen Sie das Teil an seinen Platz' : { x: 300, y: 500, width: 80, height: 30 }, frameElement: async () => ({ screenshot: async () => Buffer.from('same') }) };
    const page = { mouse: { move: async () => undefined, down: async () => undefined, up: async () => undefined } } as unknown as Page;
    const asks = { points: async () => { asked.push('points'); return [{ x: 0.5, y: 0.5 }]; }, drags: async () => { asked.push('drags'); return [{ n: 1, from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }]; } };
    const round = await hcaptchaRound({ page, random: () => 0.5, sleep: async () => undefined, asks: asks as never }, frame as never, { x: 0, y: 0, width: 400, height: 600 }, { refreshed: 0, kinds: [] });
    expect(typeof round === 'object').toBe(true);
    expect(asked).toEqual(['drags']);
  });
});

describe('an Arkose carousel', () => {
  it("counts its options from the widget's own counter, not any \"N of M\" on the page", async () => {
    const { CAROUSEL_TOTAL } = await import('./human-check-arkose.js');
    const total = (0, eval)(CAROUSEL_TOTAL) as (texts: string[]) => number;
    expect(total(['Pick the image that is the correct way up', 'Image 2 of 14.'])).toBe(14);
    expect(total(['3 / 5'])).toBe(5);
    expect(total(['Step 1 of 3 of the sign-up', 'Use the arrows'])).toBe(0);
    expect(total(['7 of 3'])).toBe(0);
  });
});

describe("Turnstile's own word", () => {
  const ax = (nodes: Array<[string, string]>) => ({ nodes: nodes.map(([role, name]) => ({ ignored: false, role: { value: role }, name: { value: name } })) });
  const turnstilePage = (tree: ReturnType<typeof ax>) => ({
    url: () => 'https://vendor.example/signup',
    mainFrame: () => undefined,
    frames: () => [{ url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/x' }],
    evaluate: async () => false,
    context: () => ({ newCDPSession: async () => ({ send: async () => tree, detach: async () => undefined }) }),
  }) as unknown as Page;

  it('reads a passed widget as answered even when no field of the page holds its token', async () => {
    const { humanCheckAnswered, turnstileSays } = await import('./human-check.js');
    const passed = turnstilePage(ax([['RootWebArea', 'Checking your Browser…'], ['link', 'Privacy'], ['StaticText', 'Privacy'], ['StaticText', 'Success!']]));
    expect(await turnstileSays(passed)).toEqual({ success: true, asking: false, said: 'Success!' });
    expect(await humanCheckAnswered(passed)).toBe(true);
  });

  it('a box still to tick, or a failure, is not an answer, and its words are kept for the tally', async () => {
    const { humanCheckAnswered, turnstileSays } = await import('./human-check.js');
    const asking = turnstilePage(ax([['checkbox', 'Verify you are human'], ['StaticText', 'Verify you are human']]));
    expect(await humanCheckAnswered(asking)).toBe(false);
    const failed = turnstilePage(ax([['StaticText', 'Verification failed'], ['StaticText', 'Troubleshoot']]));
    expect(await turnstileSays(failed)).toEqual({ success: false, asking: false, said: 'Verification failed / Troubleshoot' });
    expect(await humanCheckAnswered(failed)).toBe(false);
  });
});
