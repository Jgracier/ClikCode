/** hCaptcha. Its classic picture grid is read like reCAPTCHA's (human-check-grid.ts); everything else is drawn on
 * a canvas -- pictures to click a spot on, pieces to drag, things that move -- and is answered here. */
import type { Frame } from 'playwright-core';
import { frameShot, spot, toTarget, visitorClick, visitorDrag, within, type Box, type Hands } from './human-check-hands.js';

type Target = { x: number; x2: number; y: number; y2: number };

/** A challenge's kind, from its instruction with the particulars taken out: "Drag the 3 pieces" and "Drag the 2
 * pieces" are one kind. Used to remember which kinds this solver's answers are accepted for. */
export function promptKind(instruction: string): string {
  return instruction.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
}

export interface HcaptchaMemo {
  /** Challenges swapped for another so far; twelve is the limit. */
  refreshed: number;
  /** Kinds answered this run, for the tally. */
  kinds: string[];
  /** Kinds whose answers have not been accepted before (captcha-log.ts weakKinds): swapped without an attempt. */
  avoid?: ReadonlySet<string>;
}

const rectOf = (selector: string): string => `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`;

/** One round of a canvas challenge. `confirm` is the button to press after answering; `again` means the challenge
 * was not ready or was swapped for another; `gave-up` means there is nothing more this solver can do with it. */
export async function hcaptchaRound(hands: Hands, frame: Frame, box: Box, memo: HcaptchaMemo): Promise<{ confirm: Target } | 'again' | 'gave-up'> {
  const { page, random, sleep, trace, asks } = hands;
  const inPage = (b: Box) => toTarget({ ...b, x: b.x + box.x, y: b.y + box.y });
  let picture = await frameShot(frame);
  if (!picture) return 'gave-up';
  // hCaptcha fades its pictures in: wait until two looks half a second apart match. A moving puzzle never will.
  let moving = true;
  for (let settle = 0; settle < 6; settle++) {
    await sleep(500);
    const now = await frameShot(frame);
    if (!now) break;
    const same = now.data === picture.data;
    picture = now;
    if (same) { moving = false; break; }
  }
  const instruction = String(await frame.evaluate(`((document.querySelector('.prompt-text') || {}).innerText || '').replace(/\\s+/g, ' ').trim()`).catch(() => ''));
  // No instruction yet: the challenge is still loading (or changing over).
  if (!instruction) { await sleep(1_200); return 'again'; }
  const kind = promptKind(instruction);
  const another = async (why: string): Promise<'again' | 'gave-up'> => {
    if (memo.refreshed >= 12) return 'gave-up';
    memo.refreshed++;
    trace?.(`"${instruction}": ${why}, asking for another challenge`);
    const refresh = await frame.evaluate(rectOf('.refresh.button, .refresh')).catch(() => null) as Box | null;
    if (!refresh) return 'gave-up';
    await visitorClick(page.mouse, inPage(refresh), random, sleep);
    await sleep(2_500);
    return 'again';
  };
  if (memo.avoid?.has(kind)) return another('answers to this kind have not been accepted here before');
  // A picture that never settles is a puzzle about motion: it is answered from a few frames, not one still.
  const frames = [picture];
  if (moving) for (let i = 0; i < 4; i++) { await sleep(500); const next = await frameShot(frame, 80); if (!next) break; frames.push(next); }
  // Whether to click or drag is the models' call, not a word list: the instruction comes in the visitor's own
  // language. An English "drag" is asked as a drag first to save a round of asks.
  const dragFirst = /\b(?:drag|slide|move the)\b/i.test(instruction);
  let points = dragFirst ? undefined : await asks.points(frames, instruction);
  const drags = points?.length ? undefined : await asks.drags(picture, instruction).catch(() => undefined);
  if (!drags?.length && dragFirst) points = await asks.points(frames, instruction);
  const submit = async (): Promise<Target> => {
    const button = await frame.evaluate(rectOf('.button-submit')).catch(() => null) as Box | null;
    return button ? inPage(button) : { x: box.x + box.width * 0.8, x2: box.x + box.width * 0.95, y: box.y + box.height - 50, y2: box.y + box.height - 20 };
  };
  if (drags?.length) {
    trace?.(`"${instruction}": dragging ${drags.map(d => `piece ${d.n} to (${d.to.x.toFixed(2)},${d.to.y.toFixed(2)})`).join(', ')}`);
    for (const d of drags) { await visitorDrag(page.mouse, within(box, d.from), within(box, d.to), random, sleep, 1); await sleep(400 + random() * 400); }
  } else if (points?.length) {
    trace?.(`"${instruction}": clicking ${points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
    for (const p of points.slice(0, 9)) await visitorClick(page.mouse, spot(within(box, p)), random, sleep);
  } else return another('no agreed answer');
  if (memo.kinds.at(-1) !== kind && memo.kinds.length < 8) memo.kinds.push(kind);
  return { confirm: await submit() };
}
