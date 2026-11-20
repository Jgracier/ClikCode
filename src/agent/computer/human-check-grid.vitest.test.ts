/** reCAPTCHA's picture grid as the widget really behaves: a clicked "none left" square takes seconds to get its new picture, and a refused
 * answer is marked by the widget's own error markup. */
import { describe, expect, it } from 'vitest';
import type { Frame, Page } from 'playwright-core';
import { gridRound, type PuzzleLayout } from './human-check-grid.js';
import type { Asks, Hands } from './human-check-hands.js';
import type { TileQuestion } from './captcha-model.js';

const box = { x: 0, y: 0, width: 400, height: 580 };
type Tile = PuzzleLayout['tiles'][number];

/** A nine-square grid. `swapAfterReads`: how many layout reads a clicked "none left" square stays marked as waiting for its picture.
 * Each picture taken says which square was outlined and which picture it held, so the fake voters can answer by picture. */
function fakeGrid(options: { dynamic: boolean; said?: 'more' | 'wrong'; swapAfterReads?: number; selected?: number[]; selectionUnread?: boolean }) {
  const tiles: Tile[] = Array.from({ length: 9 }, (_, i) => ({ x: 10 + (i % 3) * 100, y: 100 + Math.floor(i / 3) * 100, width: 100, height: 100, key: `k${i}`, selected: options.selected?.includes(i) ?? false }));
  const swapping = new Map<number, number>();
  const state = { reads: 0, reloads: 0, verifyAt: undefined as undefined | { x: number; y: number }, mouse: { x: 0, y: 0 }, outlined: -1, clicked: [] as number[] };
  const layout = (): PuzzleLayout => {
    state.reads++;
    for (const [index, left] of swapping) {
      if (left <= 1) { swapping.delete(index); tiles[index] = { ...tiles[index]!, key: `${tiles[index]!.key}+`, replacing: false }; }
      else swapping.set(index, left - 1);
    }
    return { instruction: options.dynamic ? 'Select all images with cars Click verify once there are none left' : 'Select all images with cars', target: 'cars', dynamic: options.dynamic, tileSelector: 'td.rc-imageselect-tile', tiles: tiles.map(t => ({ ...t })), verify: { x: 300, y: 520, width: 80, height: 40 }, reload: { x: 20, y: 520, width: 30, height: 30 }, ...(options.said ? { said: options.said } : {}) };
  };
  const click = (): void => {
    const { x, y } = state.mouse;
    if (x >= 20 && x <= 50 && y >= 520 && y <= 550) { state.reloads++; return; }
    const index = tiles.findIndex(t => x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height);
    if (index < 0) return;
    state.clicked.push(index);
    if (options.dynamic) { tiles[index] = { ...tiles[index]!, replacing: true }; swapping.set(index, options.swapAfterReads ?? 1); }
    // A grid whose selected look this reader cannot see (hCaptcha's) still changes its picture's key on a click.
    else tiles[index] = options.selectionUnread ? { ...tiles[index]!, key: `${tiles[index]!.key}*` } : { ...tiles[index]!, selected: !tiles[index]!.selected };
  };
  const frame = {
    evaluate: async (script: unknown) => {
      const text = String(script);
      if (text.includes('amzn-grid-cell')) return layout();
      const outline = /\[(\d+)\]; if \(!tile\)/.exec(text);
      if (outline) { state.outlined = Number(outline[1]); return true; }
      return true;
    },
    frameElement: async () => ({ screenshot: async () => Buffer.from(tiles[state.outlined]!.key) }),
  } as unknown as Frame;
  const page = { mouse: { move: async (x: number, y: number) => { state.mouse = { x, y }; }, down: async () => undefined, up: async () => click() } } as unknown as Page;
  return { frame, page, state };
}

const fixedRandom = (): () => number => { let n = 0; return () => { n++; return (n * 0.37 % 1); }; };
/** Voters that see the target in the listed pictures (a picture is a square's key: `k4`, then `k4+` once it is replaced). */
function voters(cars: string[], seen: TileQuestion[] = []): Asks['tile'] {
  return async question => { seen.push(question); return cars.includes(Buffer.from(question.image.data, 'base64').toString()); };
}
const hands = (page: Page, tile: Asks['tile'], lines: string[] = []): Hands => ({ page, random: fixedRandom(), sleep: async () => undefined, asks: { tile } as unknown as Asks, trace: line => lines.push(line) });

describe('a "click until none are left" grid', () => {
  it('waits for every clicked square to get its new picture before asking about it, however slow the swap', async () => {
    // Swaps that take 12 reads (6 s at the real pace): the old fixed 3.5-4.5 s wait asked about squares that had not changed and dropped them.
    const grid = fakeGrid({ dynamic: true, swapAfterReads: 12 });
    const seen: TileQuestion[] = [];
    // Squares 0 and 4 hold cars; so does the picture that replaces square 4; the one after that does not.
    const round = await gridRound(hands(grid.page, voters(['k0', 'k4', 'k4+'], seen)), grid.frame, box);
    expect(round).toMatchObject({ confirm: { x: 300, y: 520 } });
    expect(grid.state.clicked).toEqual([0, 4, 4]);
    // Nine first pictures, the two replacements, then the replacement of the replacement: never a picture still on its way.
    expect(seen.map(q => Buffer.from(q.image.data, 'base64').toString())).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k0+', 'k4+', 'k4++']);
  });
});

describe('after the widget said a matching square was left out', () => {
  it('asks the unselected squares again taking one voter\'s yes, and keeps the squares already selected', async () => {
    const grid = fakeGrid({ dynamic: false, said: 'more', selected: [1, 2] });
    const seen: TileQuestion[] = [];
    const round = await gridRound(hands(grid.page, voters(['k7'], seen)), grid.frame, box);
    expect(round).toMatchObject({ confirm: { x: 300 } });
    expect(seen).toHaveLength(7);
    expect(seen.every(q => q.lenient === true)).toBe(true);
    expect(grid.state.clicked).toEqual([7]);
  });

  it('asks for a new challenge instead of pressing Verify on the same refused answer when no voter sees another match', async () => {
    const grid = fakeGrid({ dynamic: false, said: 'more', selected: [1, 2] });
    const lines: string[] = [];
    expect(await gridRound(hands(grid.page, voters([]), lines), grid.frame, box)).toBe('reloaded');
    expect(grid.state.reloads).toBe(1);
    expect(lines.at(-1)).toMatch(/new challenge/);
  });

  it('asks the ordinary way on a fresh grid and after "Please try again"', async () => {
    for (const said of [undefined, 'wrong'] as const) {
      const grid = fakeGrid({ dynamic: false, ...(said ? { said } : {}) });
      const seen: TileQuestion[] = [];
      expect(await gridRound(hands(grid.page, voters([], seen)), grid.frame, box)).toMatchObject({ confirm: { x: 300 } });
      expect(seen.some(q => q.lenient)).toBe(false);
      expect(grid.state.reloads).toBe(0);
    }
  });
});

describe('a grid that keeps its squares', () => {
  it('clicks each match once, even when it cannot read the selected look and the pictures change', async () => {
    const grid = fakeGrid({ dynamic: false, selectionUnread: true });
    expect(await gridRound(hands(grid.page, voters(['k6', 'k7', 'k6*', 'k7*'])), grid.frame, box)).toMatchObject({ confirm: { x: 300 } });
    expect(grid.state.clicked).toEqual([6, 7]);
  });
});
