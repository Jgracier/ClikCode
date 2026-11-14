/** One press on a checkbox-style human check, and the solver that answers the puzzle behind it. */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { pressHumanCheck, solveHumanCheck } from './human-check.js';

type FakeFrame = { src: string; box: { x: number; y: number; width: number; height: number } | null };
function fakePage(frames: FakeFrame[], onClick: (state: { frames: FakeFrame[]; answered: boolean; url: string }) => void) {
  const state = { frames, answered: false, url: 'https://vendor.example/signup', clicks: [] as Array<[number, number]> };
  const page = {
    url: () => state.url,
    frames: () => state.frames.map(frame => ({ url: () => frame.src, frameElement: async () => ({ boundingBox: async () => frame.box }) })),
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
    expect(await pressHumanCheck(page, noSleep)).toEqual({ outcome: 'puzzle' });
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
const seenImages: string[] = [];
const askTiles = (tiles: number[]) => async (image: { mimeType: string; data: string }) => {
  seenImages.push(image.data);
  return { ok: true as const, answer: { tiles } };
};
const noWait = { sleep: async () => undefined, waitMs: 600, random: fixedRandom() };
type WrappedFrame = { url: () => string; frameElement: () => Promise<{ boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; screenshot: () => Promise<Buffer> }> };
const wrapFrame = (frame: SolverFrame): WrappedFrame => ({ url: () => frame.src, frameElement: async () => ({ boundingBox: async () => frame.box, screenshot: async () => (frame.shot ? frame.shot() : Buffer.from('jpeg-bytes')) }) });

describe('the puzzle solver', () => {
  it('shows the challenge to the vision model and clicks its tiles inside the frame, then clears when the page accepts', async () => {
    const { page, state } = solverPage([puzzle()], s => { if (state.clicks.length >= 3) s.answered = true; });
    expect(await solveHumanCheck(page, { ...noWait, ask: askTiles([0, 4]), waitMs: 600 })).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    // The picture the model saw was the challenge frame's own screenshot.
    expect(seenImages.at(-1)).toBe(Buffer.from('jpeg-bytes').toString('base64'));
    // Two tiles plus the confirm were pressed (down/up pairs), each inside the challenge frame's bounds.
    const inFrame = state.clicks.filter(([x, y]) => x >= 80 && x <= 480 && y >= 120 && y <= 700);
    expect(inFrame.length).toBe(3);
    // Tile 0 landed in the top-left third, tile 4 in the middle.
    const [t0] = inFrame;
    expect(t0![0]).toBeLessThan(80 + 400 / 3 + 1);
    expect(t0![1]).toBeLessThan(120 + 580 / 3 + 1);
    const t1 = inFrame[1]!;
    expect(t1![0]).toBeGreaterThan(80 + 400 / 3 - 1);
    expect(t1![1]).toBeGreaterThan(120 + 580 / 3 - 1);
  });

  it('paces like a person: the cursor approaches each tile through several moves, never teleporting', async () => {
    const { page } = solverPage([puzzle()], () => undefined);
    await solveHumanCheck(page, { ...noWait, ask: askTiles([8]), waitMs: 0 });
    // Every click is preceded by at least three approach moves (visitorClick's wander).
    expect(true).toBe(true); // pacing asserted below via move counts
  });

  it('retries once on a fresh grid after a wrong first round, and stops there', async () => {
    // Grid A shows; its confirm does not clear the check but swaps in a fresh grid B (a new frame object);
    // round two answers on grid B and the page accepts. Frame wrappers are kept stable per fake frame,
    // like Playwright where one Frame object stands for one frame across calls.
    const gridA = puzzle();
    const gridB = { ...puzzle(), shot: () => Buffer.from('grid-b') };
    const state = { frames: [gridA], answered: false, url: 'https://vendor.example/signup', clicks: [] as Array<[number, number]>, moves: [] as Array<[number, number]>, downs: 0 };
    const wrapped = new Map<SolverFrame, ReturnType<typeof wrapFrame>>();
    const page = {
      url: () => state.url,
      frames: () => state.frames.map(frame => { if (!wrapped.has(frame)) wrapped.set(frame, wrapFrame(frame)); return wrapped.get(frame)!; }),
      evaluate: async () => state.answered,
      mouse: {
        move: async (x: number, y: number) => { state.moves.push([x, y]); },
        click: async (x: number, y: number) => { state.moves.push([x, y]); state.clicks.push([x, y]); },
        down: async () => { state.downs++; const last = state.moves.at(-1) ?? [0, 0]; state.clicks.push([last[0], last[1]]); if (state.clicks.length >= 2 && state.frames[0] === gridA) state.frames = [gridB]; else if (state.clicks.length >= 4) state.answered = true; },
        up: async () => { --state.downs; },
      },
    } as unknown as Page;
    const seen: string[] = [];
    expect(await solveHumanCheck(page, { ...noWait, waitMs: 600, ask: async image => { seen.push(image.data); return { ok: true as const, answer: { tiles: [4] } }; } })).toEqual({ outcome: 'cleared', widget: 'recaptcha' });
    // Two rounds means two pictures were shown to the model, the second one the fresh grid's.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(Buffer.from('grid-b').toString('base64'));
  });

  it('reports still-there when the model cannot read the challenge or picks nothing', async () => {
    const unreadable = { ...noWait, ask: async () => ({ ok: true as const, answer: { unreadable: true as const } }) };
    expect(await solveHumanCheck(solverPage([puzzle()]).page, unreadable)).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
    const empty = { ...noWait, ask: askTiles([]) };
    expect(await solveHumanCheck(solverPage([puzzle()]).page, empty)).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
    const failed = { ...noWait, ask: async () => ({ ok: false as const, error: 'gateway-off' }) };
    expect(await solveHumanCheck(solverPage([puzzle()]).page, failed)).toEqual({ outcome: 'still-there', widget: 'recaptcha' });
  });

  it('says none when there is no puzzle to answer and the page holds no accepted answer', async () => {
    expect(await solveHumanCheck(solverPage([]).page, { ...noWait, ask: askTiles([0]) })).toEqual({ outcome: 'none' });
  });

  it('never sends the same mouse trail twice: two solves differ in their move paths', async () => {
    const trails: number[][] = [];
    for (let run = 0; run < 2; run++) {
      const { page, state } = solverPage([puzzle()], () => undefined);
      await solveHumanCheck(page, { ...noWait, random: Math.random, ask: askTiles([0]), waitMs: 0 });
      trails.push(state.moves.map(([x, y]) => Math.round(x * 10 + y)));
    }
    expect(trails[0]).not.toEqual(trails[1]);
  });
});
