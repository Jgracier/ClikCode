/** The hands and eyes every captcha family shares: where a frame sits, a click and a drag that read like a
 * person's, room for a challenge that hangs off a small window, and the questions put to the models. */
import type { Frame, Page } from 'playwright-core';
import type { ImageInput } from '../model-client.js';
import type { NumberedDrag, TileQuestion } from './captcha-model.js';

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** The questions a solver may put to the models. The defaults go to the account's Gateway (captcha-model.ts);
 * tests supply their own. */
export interface Asks {
  tile(question: TileQuestion): Promise<boolean | undefined>;
  sameAsExample(example: ImageInput, tile: ImageInput): Promise<number | undefined>;
  points(images: ImageInput[], instruction: string): Promise<Point[] | undefined>;
  ordered(image: ImageInput): Promise<Point[] | undefined>;
  drags(image: ImageInput, instruction: string): Promise<NumberedDrag[] | undefined>;
  pick(images: ImageInput[], instruction: string): Promise<number | undefined>;
  text(image: ImageInput): Promise<string | undefined>;
  transcribe(audio: Buffer, mimeType: string): Promise<string | undefined>;
}

export function gatewayAsks(signal?: AbortSignal): Asks {
  const options = signal ? { signal } : {};
  const model = () => import('./captcha-model.js');
  return {
    tile: question => model().then(m => m.askTileMatch(question, options)),
    sameAsExample: (example, tile) => model().then(m => m.askSameAsExample(example, tile, options)),
    points: (images, instruction) => model().then(m => m.askClickPoints(images, instruction, options)),
    ordered: image => model().then(m => m.askOrderedPoints(image, options)),
    drags: (image, instruction) => model().then(m => m.askDrags(image, instruction, options)),
    pick: (images, instruction) => model().then(m => m.askPick(images, instruction, options)),
    text: image => model().then(m => m.askCaptchaText(image, options)),
    transcribe: (audio, mimeType) => model().then(m => m.askTranscript(audio, mimeType, options)),
  };
}

/** What a family's solver works with: the tab, the pacing, where to say what it did, and the model asks. */
export interface Hands { page: Page; random: () => number; sleep: (ms: number) => Promise<void>; trace?: (line: string) => void; asks: Asks }

export async function boxOf(frame: Frame): Promise<Box | undefined> {
  try { return (await (await frame.frameElement()).boundingBox()) ?? undefined; }
  catch { return undefined; }
}

export const toTarget = (b: Box) => ({ x: b.x, x2: b.x + b.width, y: b.y, y2: b.y + b.height });
/** A small target around one point, for a click on a spot the models named. */
export const spot = (p: Point, half = 4) => ({ x: p.x - half, x2: p.x + half, y: p.y - half, y2: p.y + half });
/** A point given as fractions of a box, in page coordinates. */
export const within = (box: Box, p: Point): Point => ({ x: box.x + p.x * box.width, y: box.y + p.y * box.height });

/** A move-and-click that reads like a person: the cursor wanders to the tile instead of teleporting, and every
 * pause is different. Two solves of the same page never produce the same mouse trail, which is what keeps
 * automation-blind widgets from noticing anything. */
export async function visitorClick(mouse: Page['mouse'], at: { x: number; x2: number; y: number; y2: number }, random: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const tx = at.x + (at.x2 - at.x) * (0.35 + random() * 0.3), ty = at.y + (at.y2 - at.y) * (0.35 + random() * 0.3);
  await mouse.move(tx - (30 + random() * 60), ty - (10 + random() * 30));
  await mouse.move(tx + (random() - 0.5) * 24, ty + (random() - 0.5) * 16, { steps: 4 + Math.floor(random() * 5) });
  await mouse.move(tx, ty, { steps: 3 + Math.floor(random() * 4) });
  await sleep(80 + random() * 220);
  await mouse.down();
  await sleep(45 + random() * 90);
  await mouse.up();
  await sleep(120 + random() * 380);
}

/** Make room for a challenge that hangs off a small window: the tab's viewport grows to hold the whole frame (only
 * this tab, and only when needed). Says whether it changed anything, so the caller re-reads the moved frame. */
export async function fitPuzzle(page: Page, box: Box): Promise<boolean> {
  try {
    const [width, height] = await page.evaluate('[innerWidth, innerHeight]') as [number, number];
    if (box.y >= 0 && box.x >= 0 && box.y + box.height <= height && box.x + box.width <= width) return false;
    const want = { width: Math.max(width, Math.ceil(box.width + 80)), height: Math.max(height, Math.ceil(box.height + 120)) };
    if (want.width === width && want.height === height) return false;
    await page.setViewportSize(want);
    return true;
  } catch { return false; }
}

/** A drag like a hand makes it: press on the piece, set off slowly, speed up, overshoot a little, settle back,
 * pause, let go. The path wobbles vertically and is never the same twice. */
export async function visitorDrag(mouse: Page['mouse'], from: { x: number; y: number }, to: { x: number; y: number }, random: () => number, sleep: (ms: number) => Promise<void>, settle = 2): Promise<void> {
  await mouse.move(from.x - 20 - random() * 30, from.y + (random() - 0.5) * 20);
  await mouse.move(from.x, from.y, { steps: 5 + Math.floor(random() * 4) });
  await sleep(120 + random() * 200);
  await mouse.down();
  await sleep(90 + random() * 150);
  const overshoot = 3 + random() * 6, dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const steps = 18 + Math.floor(random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const reach = ease * (1 + overshoot / len);
    await mouse.move(from.x + dx * reach, from.y + dy * reach + Math.sin(t * Math.PI) * (random() - 0.5) * 6);
    await sleep(8 + random() * 22);
  }
  await mouse.move(to.x + (random() - 0.5) * settle, to.y + (random() - 0.5) * settle, { steps: 4 });
  await sleep(150 + random() * 250);
  await mouse.up();
}

/** A picture of a frame as the models get it. */
export async function frameShot(frame: Frame, quality = 85): Promise<{ mimeType: string; data: string } | undefined> {
  try { return { mimeType: 'image/jpeg', data: (await (await frame.frameElement()).screenshot({ type: 'jpeg', quality, timeout: 10_000 }) as Buffer).toString('base64') }; }
  catch { return undefined; }
}
