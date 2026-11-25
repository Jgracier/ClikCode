import type { Locator, Page } from 'playwright-core';
import { sleep as realSleep } from '../../runtime/sleep.js';

/** Input that reads like a person: the cursor travels a curved path to where it clicks (a point inside the element, never
 * its exact centre), the button is held for a moment, and short text is typed with uneven gaps between keys. Bot checks
 * score teleporting cursors, centre-perfect clicks, zero-length presses and evenly timed keys. */

type Point = { x: number; y: number };
export type Chance = { random: () => number; sleep: (ms: number) => Promise<void> };
const LIVE: Chance = { random: Math.random, sleep: realSleep };

/** Where each tab's cursor was left, so the next move starts there instead of at the corner. */
const cursorAt = new WeakMap<Page, Point>();

/** The points of a curved path from `from` to `to`: a quadratic curve bent to one side by a random amount, eased so it starts
 * and ends slowly, with a hand's small wobble. The last point is exactly `to`. */
export function cursorPath(from: Point, to: Point, chance: Pick<Chance, 'random'> = LIVE): Point[] {
  const { random } = chance;
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [to];
  const bend = (random() - 0.5) * Math.min(distance * 0.5, 160);
  const control = { x: from.x + dx / 2 - (dy / distance) * bend, y: from.y + dy / 2 + (dx / distance) * bend };
  const steps = Math.max(6, Math.min(28, Math.round(distance / 25 + random() * 6)));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const linear = i / steps;
    const t = linear < 0.5 ? 2 * linear * linear : 1 - (-2 * linear + 2) ** 2 / 2;
    const wobble = i === steps ? 0 : (random() - 0.5) * 1.5;
    points.push({
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x + wobble,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y + wobble,
    });
  }
  return points;
}

/** A point inside a box away from its edges and off its exact centre, relative to the box. */
export function pointInBox(box: { width: number; height: number }, chance: Pick<Chance, 'random'> = LIVE): Point {
  const { random } = chance;
  return { x: box.width * (0.3 + random() * 0.4), y: box.height * (0.3 + random() * 0.4) };
}

/** Moves this tab's cursor along a curved path to a viewport point. */
export async function glideTo(page: Page, to: Point, chance: Chance = LIVE): Promise<void> {
  const size = page.viewportSize();
  const from = cursorAt.get(page) ?? { x: (size?.width ?? 1200) * (0.3 + chance.random() * 0.4), y: (size?.height ?? 800) * (0.2 + chance.random() * 0.3) };
  for (const point of cursorPath(from, to, chance)) {
    await page.mouse.move(point.x, point.y);
    await chance.sleep(4 + chance.random() * 12);
  }
  cursorAt.set(page, to);
}

/** Brings the cursor over the element and returns the spot (relative to the element) a click should land on, or undefined when the
 * element has no box on screen (Playwright's own click then finds its way, or fails as it would have). */
export async function approach(page: Page, target: Locator, position?: Point, chance: Chance = LIVE): Promise<Point | undefined> {
  try {
    await target.scrollIntoViewIfNeeded({ timeout: 3_000 });
    const box = await target.boundingBox({ timeout: 3_000 });
    if (!box || box.width < 1 || box.height < 1) return undefined;
    const spot = position ?? pointInBox(box, chance);
    await glideTo(page, { x: box.x + spot.x, y: box.y + spot.y }, chance);
    await chance.sleep(40 + chance.random() * 160);
    return spot;
  } catch { return undefined; }
}

/** How long a press holds the button down, in milliseconds. */
export const holdMs = (chance: Pick<Chance, 'random'> = LIVE): number => Math.round(45 + chance.random() * 85);

/** How long a typed key stays down, in milliseconds. A bare keyboard.type(char) releases the key 2-3 ms after pressing it, which
 * keystroke-timing checks (Microsoft's sign-up records them) read as a script; people hold a key roughly 50-130 ms. */
export const keyHoldMs = (chance: Pick<Chance, 'random'> = LIVE): number => Math.round(50 + chance.random() * 80);

/** Presses one character the way a person does: key down, held for keyHoldMs, key up. Every place that types a character for
 * a page to read goes through this. */
export async function tapKey(page: Pick<Page, 'keyboard'>, char: string, chance: Pick<Chance, 'random'> = LIVE): Promise<void> {
  await page.keyboard.type(char, { delay: keyHoldMs(chance) });
}

/** Types into whatever has focus, one key at a time with uneven gaps, and a longer pause now and then (between words). */
export async function typeLikeAPerson(page: Page, text: string, chance: Chance = LIVE): Promise<void> {
  for (const char of text) {
    await tapKey(page, char, chance);
    const pause = char === ' ' || chance.random() < 0.06 ? 120 + chance.random() * 220 : 35 + chance.random() * 105;
    await chance.sleep(pause);
  }
}
