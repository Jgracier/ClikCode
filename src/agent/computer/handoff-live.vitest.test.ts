import { describe, expect, it } from 'vitest';
import { SAME_VIEW, toPage } from './handoff-live.js';

describe('where a finger on the phone is in the page', () => {
  it('is the same place when the page is shown at full size', () => {
    expect(toPage(SAME_VIEW, 120, 340)).toEqual({ x: 120, y: 340 });
  });

  it('scales a zoomed-out page up: a page laid out 980 wide on a 390 screen', () => {
    const view = { scale: 390 / 980, x: 0, y: 0 };
    const at = toPage(view, 207, 376);
    expect(Math.round(at.x)).toBe(520);
    expect(Math.round(at.y)).toBe(945);
  });

  it('adds the panned offset, in page pixels, when the page is zoomed in', () => {
    expect(toPage({ scale: 2, x: 300, y: 1000 }, 100, 50)).toEqual({ x: 350, y: 1025 });
  });

  it('ignores a zoom that cannot be right rather than sending a point to nowhere', () => {
    for (const scale of [0, -1, 0.001, 500, NaN]) expect(toPage({ scale, x: 0, y: 0 }, 10, 20)).toEqual({ x: 10, y: 20 });
  });
});
