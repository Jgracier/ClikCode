/** One press on a checkbox-style human check; never an answer to a puzzle. */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { pressHumanCheck } from './human-check.js';

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
