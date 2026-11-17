/** One press on a checkbox-style human check, and the solver that answers the puzzle behind it. */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { detectHumanCheck, pressHumanCheck, solveHumanCheck } from './human-check.js';

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

  it('counts a whole-page check that moves on or removes itself as cleared', async () => {
    const gone = fakePage([{ src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x', box: { x: 40, y: 200, width: 300, height: 65 } }], s => { s.frames = []; });
    expect(await pressHumanCheck(gone.page, noSleep)).toEqual({ outcome: 'cleared', widget: 'turnstile' });
    const moved = fakePage([{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox&id=1', box: { x: 40, y: 200, width: 303, height: 78 } }], s => { s.url = 'https://vendor.example/welcome'; });
    expect(await pressHumanCheck(moved.page, noSleep)).toEqual({ outcome: 'cleared', widget: 'hcaptcha' });
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
  const frame = { url: () => puzzle().src, parentFrame: () => null, evaluate: async (script: unknown) => typeof script === 'string' && script.includes('rc-imageselect') ? gridLayout() : true, frameElement: async () => ({ boundingBox: async () => puzzle().box, screenshot: async () => Buffer.from('jpeg-bytes') }) };
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

describe('hCaptcha challenge kinds', () => {
  it('drops the particulars so two challenges of one kind are counted together', async () => {
    const { promptKind } = await import('./human-check-hcaptcha.js');
    expect(promptKind('Drag the 3 segments to complete the line!')).toBe(promptKind('Drag the 2 segments to complete the line'));
    expect(promptKind('Please click on the object that is different from the others in the picture')).toBe('please click on the object that');
  });
});
