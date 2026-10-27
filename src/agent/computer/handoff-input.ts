/** What the phone may send to the live view, checked before any of it reaches the browser. Pure, so it is tested without one. */

export type Point = { id: number; x: number; y: number };

const finite = (value: unknown, max = 20_000): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= max;

/** Up to five touch points as [id, x, y], or undefined when anything about them is off. */
export function cleanPoints(raw: unknown): Point[] | undefined {
  if (!Array.isArray(raw) || raw.length > 5) return undefined;
  const out: Point[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 3 || !Number.isInteger(item[0]) || item[0] < 0 || item[0] > 1_000_000 || !finite(item[1]) || !finite(item[2])) return undefined;
    out.push({ id: item[0], x: item[1], y: item[2] });
  }
  return out;
}

export type KeyEvent = { key: string; code: string; vk: number; text?: string };

/** The keys a phone can press: editing and moving, nothing that opens a window or runs a shortcut. */
const KEYS: Readonly<Record<string, KeyEvent>> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
export const keyEvent = (name: unknown): KeyEvent | undefined => (typeof name === 'string' && Object.hasOwn(KEYS, name) ? KEYS[name] : undefined);

/** How many times a key may be repeated in one message (a replaced autofill removes the old value in one go). */
export const MAX_REPEAT = 400;
export const MAX_TEXT = 4_000;

export type Size = { w: number; h: number; dpr: number };

/** The phone's visible area in CSS pixels and its pixel ratio, kept to what a phone or tablet can be. */
export function cleanSize(raw: unknown): Size | undefined {
  const value = raw as { w?: unknown; h?: unknown; dpr?: unknown } | null;
  if (!value || typeof value !== 'object') return undefined;
  const { w, h, dpr } = value;
  if (typeof w !== 'number' || typeof h !== 'number' || typeof dpr !== 'number') return undefined;
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(dpr)) return undefined;
  return { w: Math.min(2400, Math.max(200, Math.round(w))), h: Math.min(3000, Math.max(120, Math.round(h))), dpr: Math.min(3, Math.max(1, dpr)) };
}
