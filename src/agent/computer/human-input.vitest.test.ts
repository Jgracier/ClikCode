import { describe, expect, it } from 'vitest';
import { cursorPath, holdMs, pointInBox, typeLikeAPerson } from './human-input.js';

const seeded = (seed = 7) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

describe('human input', () => {
  it('travels a curved path that ends exactly on the target', () => {
    const path = cursorPath({ x: 0, y: 0 }, { x: 600, y: 0 }, { random: seeded() });
    expect(path.length).toBeGreaterThanOrEqual(6);
    expect(path.at(-1)).toEqual({ x: 600, y: 0 });
    // Bent off the straight line somewhere in the middle, and moving forward overall.
    expect(Math.max(...path.map(point => Math.abs(point.y)))).toBeGreaterThan(3);
    expect(path[Math.floor(path.length / 2)]!.x).toBeGreaterThan(100);
  });

  it('does not wander for a move of a pixel', () => {
    expect(cursorPath({ x: 10, y: 10 }, { x: 11, y: 10 })).toEqual([{ x: 11, y: 10 }]);
  });

  it('clicks inside the box, off its edges and never twice on the same spot', () => {
    const random = seeded(3);
    const spots = Array.from({ length: 20 }, () => pointInBox({ width: 100, height: 40 }, { random }));
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThanOrEqual(30); expect(spot.x).toBeLessThanOrEqual(70);
      expect(spot.y).toBeGreaterThanOrEqual(12); expect(spot.y).toBeLessThanOrEqual(28);
    }
    expect(new Set(spots.map(spot => `${spot.x},${spot.y}`)).size).toBe(20);
  });

  it('holds the button for a human length of time', () => {
    const random = seeded(11);
    for (let i = 0; i < 50; i++) { const ms = holdMs({ random }); expect(ms).toBeGreaterThanOrEqual(45); expect(ms).toBeLessThanOrEqual(130); }
  });

  it('holds every typed key down like a person, not the 2-3 ms of a bare keyboard.type', async () => {
    const holds: number[] = [];
    const page = { keyboard: { type: async (_char: string, options?: { delay?: number }) => { holds.push(options?.delay ?? 0); } } };
    await typeLikeAPerson(page as never, 'justin gracier', { random: seeded(9), sleep: async () => {} });
    expect(holds).toHaveLength(14);
    for (const ms of holds) { expect(ms).toBeGreaterThanOrEqual(50); expect(ms).toBeLessThanOrEqual(130); }
    expect(new Set(holds).size).toBeGreaterThan(5);
  });

  it('types key by key with uneven gaps', async () => {
    const typed: string[] = [], gaps: number[] = [];
    const page = { keyboard: { type: async (char: string) => { typed.push(char); } } };
    await typeLikeAPerson(page as never, 'hello world', { random: seeded(5), sleep: async ms => { gaps.push(ms); } });
    expect(typed.join('')).toBe('hello world');
    expect(gaps).toHaveLength(11);
    expect(new Set(gaps.map(Math.round)).size).toBeGreaterThan(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35);
  });
});
