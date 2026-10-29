/** Page control for `browser_use` beyond click and fill: history, tabs, scripts, pointer variants, screenshots, scrolling,
 * waits on page state, rich fields and the console. Only Playwright and node:path calls, so it behaves the same on Linux,
 * macOS and Windows. Anything that returns page content goes through the same hiding the page view uses. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Frame, Locator, Page } from 'playwright-core';
import type { ToolRunResult } from '../tool-contract.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { closeOwnedPage, focusOwnedPage, ownedPages } from './browser.js';
import { readConsole } from './console-log.js';
import { hideKeyLikeText } from './secret-finder.js';
import { scrubSecrets, showsSecret } from './secret-scrubber.js';
import { keyFieldValues, maskSensitive, pageSecrets, SENSITIVE, sensitiveValues } from './sensitive-fields.js';

export const PAGE_ACTIONS = ['back', 'forward', 'reload', 'tabs', 'switch', 'evaluate', 'screenshot', 'console'] as const;
export type PageAction = typeof PAGE_ACTIONS[number];
export type ScrollDirection = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
export type MouseButton = 'left' | 'right' | 'middle';

/** What a step can carry beyond the original click/fill/choose/press/scroll/wait/upload fields. */
export type StepExtras = {
  button?: MouseButton; count?: number; modifiers?: string[] | string; x?: number; y?: number; to_x?: number; to_y?: number; to_target?: string;
  amount?: number; until?: 'text' | 'network_idle' | 'visible' | 'hidden' | 'enabled' | 'disabled' | 'url'; selector?: string; url?: string;
};
export type PageArgs = StepExtras & { index?: number; expression?: string; with_screenshot?: boolean; level?: string; limit?: number; clear?: boolean; new_tab?: boolean };

/** What this module needs from the tool around it (kept as parameters so there is no import cycle with computer-web). */
export type PageDeps = {
  stateDir: string; tab?: string; acceptsImages: boolean;
  locate(page: Page, target: string | undefined): Promise<Locator>;
  view(page: Page, compact?: boolean): Promise<ToolRunResult>;
  settle(page: Page): Promise<void>;
  displayUrl(url: string): string;
};

const num = (value: unknown, name: string, max = 100_000): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`${name} must be a number from 0 to ${max}.`);
  return value;
};

// ---------------------------------------------------------------------------------------------------- keys

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'ControlOrMeta']);
const LEGACY_KEY = /^[A-Za-z0-9+_-]{1,30}$/;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9]{1,24}$/;

/** A key press the keyboard accepts: one character of any kind (a letter, "/", ".", a space, "é"), a Playwright key name
 * (Enter, ArrowDown, F5, KeyA, Digit1), or those joined with "+" after modifiers (Control+a, Meta+k, Shift+Tab, Control+Shift+ArrowLeft).
 * Nothing else reaches the keyboard: no control characters, no free text. Returns the key as Playwright wants it. */
export function checkKey(key: string | undefined): string {
  if (typeof key !== 'string' || !key.length) throw new Error('Press needs a key, such as Enter, Escape, Control+a or a single character.');
  if ([...key].length === 1) {
    if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error('Press needs a printable character or a key name such as Enter.');
    return key;
  }
  // "Control++" is Control and the plus key.
  const parts = key.endsWith('++') ? [...key.slice(0, -2).split('+'), '+'] : key.split('+');
  if (parts.length > 5 || parts.some(part => !part.length)) throw new Error(`"${key}" is not a key or a combination such as Control+a.`);
  const last = parts.at(-1)!;
  for (const part of parts.slice(0, -1)) if (!MODIFIER_KEYS.has(part)) throw new Error(`"${part}" is not a modifier key (Control, Shift, Alt, Meta).`);
  if (!([...last].length === 1 && !/[\u0000-\u001f\u007f]/.test(last)) && !KEY_NAME.test(last) && !(parts.length === 1 && LEGACY_KEY.test(last))) throw new Error(`"${last}" is not a key name such as Enter, Tab or ArrowDown.`);
  return parts.join('+');
}

export function checkModifiers(value: string[] | string | undefined): string[] {
  if (value === undefined || value === '') return [];
  const list = (Array.isArray(value) ? value : value.split(/[+,\s]+/)).filter(Boolean);
  for (const item of list) if (!MODIFIER_KEYS.has(item)) throw new Error(`"${item}" is not a modifier. Use Shift, Control, Alt, Meta or ControlOrMeta.`);
  return list;
}

/** Click options a step asks for; undefined when it is a plain left click. */
export function clickExtras(step: StepExtras): { button: MouseButton; clickCount: number; modifiers: string[] } | undefined {
  const button = step.button ?? 'left';
  if (!['left', 'right', 'middle'].includes(button)) throw new Error('button must be left, right or middle.');
  const clickCount = step.count ?? 1;
  if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) throw new Error('count must be 1 (click), 2 (double-click) or 3 (triple-click).');
  const modifiers = checkModifiers(step.modifiers);
  return button === 'left' && clickCount === 1 && !modifiers.length ? undefined : { button, clickCount, modifiers };
}

// ---------------------------------------------------------------------------------------------------- pointer

type Point = { x: number; y: number };

async function withModifiers<T>(page: Page, modifiers: readonly string[], act: () => Promise<T>): Promise<T> {
  const down: string[] = [];
  try {
    for (const modifier of modifiers) { await page.keyboard.down(modifier); down.push(modifier); }
    return await act();
  } finally { for (const modifier of down.reverse()) await page.keyboard.up(modifier).catch(quiet('agent/computer/page-control')); }
}

/** A click that is not a plain left click, or that lands on viewport coordinates (a canvas, a map). With a target, x and y are an offset inside it. */
export async function clickWith(page: Page, target: Locator | undefined, step: StepExtras): Promise<void> {
  const extras = clickExtras(step) ?? { button: 'left' as const, clickCount: 1, modifiers: [] };
  const at = step.x !== undefined || step.y !== undefined ? { x: num(step.x, 'x'), y: num(step.y, 'y') } : undefined;
  if (target) {
    await target.click({ button: extras.button, clickCount: extras.clickCount, ...(extras.modifiers.length ? { modifiers: extras.modifiers as never } : {}), ...(at ? { position: at } : {}), timeout: 6_000 });
    return;
  }
  if (!at) throw new Error('Click needs a target, or x and y (viewport pixels).');
  await withModifiers(page, extras.modifiers, () => page.mouse.click(at.x, at.y, { button: extras.button, clickCount: extras.clickCount }));
}

export async function hoverStep(page: Page, target: Locator | undefined, step: StepExtras): Promise<void> {
  if (target) { await target.hover({ timeout: 6_000, ...(step.x !== undefined && step.y !== undefined ? { position: { x: num(step.x, 'x'), y: num(step.y, 'y') } } : {}) }); return; }
  if (step.x === undefined || step.y === undefined) throw new Error('Hover needs a target, or x and y (viewport pixels).');
  await page.mouse.move(num(step.x, 'x'), num(step.y, 'y'), { steps: 4 });
}

async function centre(target: Locator): Promise<Point> {
  await target.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(quiet('agent/computer/page-control'));
  const box = await target.boundingBox({ timeout: 6_000 });
  if (!box) throw new Error('That element has no place on the page to drag from or to.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag from an element or a point to an element or a point. Two elements use the browser's own drag-and-drop; otherwise the mouse is moved in steps. */
export async function dragStep(page: Page, from: Locator | undefined, to: Locator | undefined, step: StepExtras): Promise<void> {
  const hasFromXY = step.x !== undefined && step.y !== undefined;
  const hasToXY = step.to_x !== undefined && step.to_y !== undefined;
  if (!from && !hasFromXY) throw new Error('Drag needs a source: a target, or x and y.');
  if (!to && !hasToXY) throw new Error('Drag needs a destination: to_target, or to_x and to_y.');
  if (from && to) { await from.dragTo(to, { timeout: 8_000 }); return; }
  const start = from ? await centre(from) : { x: num(step.x, 'x'), y: num(step.y, 'y') };
  const end = to ? await centre(to) : { x: num(step.to_x, 'to_x'), y: num(step.to_y, 'to_y') };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try { await page.mouse.move(end.x, end.y, { steps: 12 }); }
  finally { await page.mouse.up(); }
}

// ---------------------------------------------------------------------------------------------------- scroll

/** Runs in the page: scroll the nearest scrollable ancestor of `node` (or the page) and say where it ended up. */
function scrollInPage(node: unknown, how: { direction: ScrollDirection; amount: number }): { top: number; max: number; left: number; maxLeft: number; scope: 'element' | 'page' } {
  type Box = { scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number; parentElement: Box | null; scrollTo(options: object): void };
  const g = globalThis as unknown as { getComputedStyle(el: unknown): { overflowY: string; overflowX: string }; document: { scrollingElement: Box } };
  const vertical = how.direction === 'up' || how.direction === 'down' || how.direction === 'top' || how.direction === 'bottom';
  let el = node as Box | null;
  while (el && el !== g.document.scrollingElement) {
    const style = g.getComputedStyle(el);
    const room = vertical ? el.scrollHeight > el.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY) : el.scrollWidth > el.clientWidth + 1 && /auto|scroll|overlay/.test(style.overflowX);
    if (room) break;
    el = el.parentElement;
  }
  const scope = el && el !== g.document.scrollingElement ? 'element' as const : 'page' as const;
  const box = scope === 'element' ? el! : g.document.scrollingElement;
  const top = how.direction === 'top' ? 0 : how.direction === 'bottom' ? box.scrollHeight : box.scrollTop + (how.direction === 'down' ? how.amount : how.direction === 'up' ? -how.amount : 0);
  const left = how.direction === 'left' ? box.scrollLeft - how.amount : how.direction === 'right' ? box.scrollLeft + how.amount : box.scrollLeft;
  box.scrollTo({ top, left, behavior: 'instant' });
  return { top: Math.round(box.scrollTop), max: Math.max(0, Math.round(box.scrollHeight - box.clientHeight)), left: Math.round(box.scrollLeft), maxLeft: Math.max(0, Math.round(box.scrollWidth - box.clientWidth)), scope };
}

function where(position: ReturnType<typeof scrollInPage>, direction: ScrollDirection): string {
  const horizontal = direction === 'left' || direction === 'right';
  const at = horizontal ? position.left : position.top;
  const max = horizontal ? position.maxLeft : position.max;
  const edge = max === 0 ? ' (nothing to scroll here)' : at <= 0 ? ' (at the start)' : at >= max ? ' (at the end)' : '';
  return `${horizontal ? 'across' : 'down'} ${at} of ${max}px${edge}`;
}

/** Scroll the page, or inside one element; with a target and no direction, bring that element into view. */
export async function scrollStep(page: Page, target: Locator | undefined, step: StepExtras & { direction?: ScrollDirection; target?: string }): Promise<string> {
  const direction = step.direction;
  if (direction !== undefined && !['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) throw new Error('direction must be up, down, left, right, top or bottom.');
  if (target && !direction) {
    await target.scrollIntoViewIfNeeded({ timeout: 8_000 });
    return `Scrolled ${step.target} into view.`;
  }
  const how = { direction: direction ?? 'down', amount: step.amount === undefined ? 600 : Math.max(1, Math.min(num(step.amount, 'amount'), 100_000)) };
  if (target) {
    const position = await target.evaluate(scrollInPage, how, { timeout: 5_000 });
    return `Scrolled ${how.direction} inside ${step.target}${how.direction === 'top' || how.direction === 'bottom' ? '' : ` by ${how.amount}px`}: now ${where(position, how.direction)}.`;
  }
  if (how.direction === 'top' || how.direction === 'bottom') {
    const position = await page.locator(':root').evaluate(scrollInPage, how, { timeout: 5_000 });
    return `Scrolled to the ${how.direction} of the page: now ${where(position, how.direction)}.`;
  }
  // The wheel scrolls whatever is under the pointer, so a page with its own scrolling pane moves that pane.
  const dx = how.direction === 'left' ? -how.amount : how.direction === 'right' ? how.amount : 0;
  const dy = how.direction === 'up' ? -how.amount : how.direction === 'down' ? how.amount : 0;
  await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(150);
  const position = await page.locator(':root').evaluate(scrollInPage, { direction: how.direction, amount: 0 }, { timeout: 5_000 });
  return `Scrolled ${how.direction} by ${how.amount}px: now ${where(position, how.direction)}.`;
}

// ---------------------------------------------------------------------------------------------------- wait

/** `target`/`selector` state, a URL change, or network idle. Polled, so a page that rebuilds itself is still found. Not an error on timeout: the page as it is, is the answer. */
export async function waitForState(page: Page, step: StepExtras & { target?: string; seconds?: number }, deps: Pick<PageDeps, 'locate' | 'displayUrl'>): Promise<{ note: string; halt?: true }> {
  const seconds = Math.min(Math.max(Math.floor(step.seconds ?? 30), 1), 120);
  const deadline = Date.now() + seconds * 1000;
  const until = step.until ?? (step.url !== undefined ? 'url' : undefined);
  if (until === 'network_idle') {
    try { await page.waitForLoadState('networkidle', { timeout: seconds * 1000 }); return { note: 'The network is idle.' }; }
    catch { return { note: `The network was still busy after ${seconds}s.`, halt: true }; }
  }
  if (until === 'url') {
    const started = page.url();
    const wanted = step.url?.trim();
    const matches = (url: string): boolean => {
      if (!wanted) return url !== started;
      if (wanted.length > 2 && wanted.startsWith('/') && wanted.endsWith('/')) { try { return new RegExp(wanted.slice(1, -1)).test(url); } catch { /* not a pattern: read as text */ } }
      return url.includes(wanted);
    };
    while (Date.now() < deadline) {
      if (matches(page.url())) return { note: `The address is now ${deps.displayUrl(page.url())}.` };
      await page.waitForTimeout(200);
    }
    return { note: `The address ${wanted ? `did not match "${wanted}"` : 'did not change'} after ${seconds}s; it is ${deps.displayUrl(page.url())}.`, halt: true };
  }
  if (until !== 'visible' && until !== 'hidden' && until !== 'enabled' && until !== 'disabled') throw new Error('wait until must be text, network_idle, visible, hidden, enabled, disabled or url.');
  if (!step.target?.trim() && !step.selector?.trim()) throw new Error(`Wait until ${until} needs a target (a [ref=…] or its text) or a selector.`);
  const what = step.selector?.trim() || step.target!.trim();
  const state = async (): Promise<boolean> => {
    let element: Locator | undefined;
    try { element = step.selector?.trim() ? page.locator(step.selector.trim()).first() : await deps.locate(page, step.target); }
    catch (error) { if (step.selector?.trim()) throw error; element = undefined; }
    if (element && step.selector?.trim() && !(await element.count().catch(() => 0))) element = undefined;
    if (!element) return until === 'hidden';
    switch (until) {
      case 'visible': return element.isVisible().catch(() => false);
      case 'hidden': return !(await element.isVisible().catch(() => false));
      case 'enabled': return (await element.isVisible().catch(() => false)) && await element.isEnabled().catch(() => false);
      default: return element.isDisabled().catch(() => false);
    }
  };
  while (Date.now() < deadline) {
    if (await state()) return { note: `${what} is ${until}.` };
    await page.waitForTimeout(250);
  }
  return { note: `${what} was still not ${until} after ${seconds}s.`, halt: true };
}

// ---------------------------------------------------------------------------------------------------- fields

const DATE_FIELDS = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
const SET_FIELDS = new Set([...DATE_FIELDS, 'range', 'color']);
const pad = (value: string | number): string => String(value).padStart(2, '0');

/** The text a date-like input wants (2026-10-26, 15:45, 2026-10-26T15:45, 2026-10), from what a person writes (10/26/2026, 3:45 PM). Anything else is passed through. */
export function normalizeDateValue(type: string, text: string): string {
  const value = text.trim();
  const day = (input: string): string | undefined => {
    const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(input);
    if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`;
    const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(input);
    if (us) return `${us[3]}-${pad(us[1]!)}-${pad(us[2]!)}`;
    return undefined;
  };
  const clock = (input: string): string | undefined => {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(input);
    if (!match) return undefined;
    let hour = Number(match[1]);
    if (match[4]) { const pm = /^p/i.test(match[4]); hour = hour % 12 + (pm ? 12 : 0); }
    return `${pad(hour)}:${match[2]}${match[3] ? `:${match[3]}` : ''}`;
  };
  if (type === 'date') return day(value) ?? value;
  if (type === 'time') return clock(value) ?? value;
  if (type === 'month') { const m = /^(\d{4})[-/](\d{1,2})$/.exec(value) ?? /^(\d{1,2})[-/](\d{4})$/.exec(value); return m ? (m[1]!.length === 4 ? `${m[1]}-${pad(m[2]!)}` : `${m[2]}-${pad(m[1]!)}`) : value; }
  if (type === 'datetime-local') {
    const split = /^(.+?)(?:[T\s]+)(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)$/i.exec(value);
    const d = split && day(split[1]!.trim());
    const t = split && clock(split[2]!.trim());
    return d && t ? `${d}T${t}` : value;
  }
  return value;
}

/** Runs in the page: set a field's value the way the browser does, then announce it so frameworks see the change. */
function setValueInPage(node: unknown, value: string): string {
  const el = node as { value: string; dispatchEvent(event: unknown): boolean };
  const g = globalThis as unknown as { Event: new (type: string, init: object) => unknown };
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new g.Event('input', { bubbles: true }));
  el.dispatchEvent(new g.Event('change', { bubbles: true }));
  return el.value;
}

export const MAX_FILL = 100_000;

/** Put `text` into a field in the way that field takes it: a dropdown by its label, a date by its machine format, a rich-text editor by
 * insertion (a line break is Shift+Enter, so a chat box does not send), a short plain box key by key (forms that check each press), and a
 * long text at once. Returns the words for the step result. */
export async function fillTarget(page: Page, target: Locator, text: string, name: string | undefined): Promise<string> {
  if (typeof text !== 'string' || text.length > MAX_FILL) throw new Error(`Fill needs text of at most ${MAX_FILL.toLocaleString('en-US')} characters.`);
  const kind = await target.evaluate(element => {
    const el = element as unknown as { tagName: string; type?: string; isContentEditable?: boolean };
    return { tag: el.tagName, type: (el.type ?? '').toLowerCase(), editable: el.isContentEditable === true && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' };
  }).catch(() => ({ tag: '', type: '', editable: false }));
  if (kind.tag === 'SELECT') { await target.selectOption({ label: text }, { timeout: 10_000 }).catch(() => target.selectOption(text, { timeout: 10_000 })); return `Chose "${text}" in ${name}.`; }
  if (kind.tag === 'INPUT' && SET_FIELDS.has(kind.type)) {
    const value = DATE_FIELDS.has(kind.type) ? normalizeDateValue(kind.type, text) : text;
    await target.fill(value, { timeout: 10_000 }).catch(() => target.evaluate(setValueInPage, value, { timeout: 5_000 }));
    const got = await target.inputValue({ timeout: 2_000 }).catch(() => value);
    if (value && !got) throw new Error(`The ${kind.type} field did not accept "${text}". It takes ${kind.type === 'date' ? 'YYYY-MM-DD' : kind.type === 'time' ? 'HH:MM' : kind.type === 'datetime-local' ? 'YYYY-MM-DDTHH:MM' : kind.type === 'month' ? 'YYYY-MM' : 'a value in its own format'}.`);
    // A page that re-renders from its own state sometimes ignores the first change: announce it once more.
    await target.evaluate(node => { const g = globalThis as unknown as { Event: new (type: string, init: object) => unknown }; (node as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(new g.Event('change', { bubbles: true })); }).catch(quiet('agent/computer/page-control'));
    return `Set ${name} to ${got || value}.`;
  }
  if (kind.editable) {
    await target.click({ timeout: 6_000 }).catch(() => target.focus({ timeout: 3_000 }));
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    const lines = text.split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
      if (index > 0) await page.keyboard.press('Shift+Enter');
      if (line) await page.keyboard.insertText(line);
    }
    const shown = (await target.innerText({ timeout: 2_000 }).catch(() => text)).trim();
    // An editor that ignores inserted text gets the keys instead (short text only: typing is slow).
    if (text.trim() && !shown && text.length <= 2_000) { await target.pressSequentially(text, { timeout: 20_000 }); }
    else if (text.trim() && !shown) throw new Error(`The editor ${name ?? ''} did not take the text.`.replace('  ', ' '));
    return `Wrote ${text.length} characters into the editor ${name}.`;
  }
  // Typing, not setting a value: forms that check each key press (a phone box, an enabled Continue) only see real input.
  if (text.length <= 200 && kind.tag !== 'TEXTAREA') {
    await target.fill('', { timeout: 10_000 });
    await target.pressSequentially(text, { timeout: 10_000 });
    await target.blur().catch(quiet('agent/computer/page-control'));
  } else await target.fill(text, { timeout: Math.min(60_000, 10_000 + text.length / 5) });
  return `Filled ${name}.`;
}

// ---------------------------------------------------------------------------------------------------- evaluate

/** Words that reach for a credential field's value, or for a way round the hiding below. The hiding is the guard; this is a second lock. */
const CREDENTIAL_SCRIPT = /type\s*[=:]?\s*\\?["']?password|one-time-code|current-password|new-password|autocomplete\W{0,4}cc-|cc-(?:number|csc|exp|name)|FormData|getOwnPropertyDescriptor|__lookupGetter__|Reflect\.get|\.elements\b|requestSubmit|\.password\b/i;
const MAX_RESULT = 8_000;

function encodedForms(value: string): string[] {
  return [...new Set([value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), encodeURIComponent(value)])].filter(form => form.length >= 3);
}

/** Hide every value in `text` that a credential field or key-like text box on the page holds, in the forms a script could return it in. */
export async function hideFieldValues(page: Page, text: string, extra: readonly string[] = []): Promise<string> {
  let out = await maskSensitive(page, text);
  for (const value of [...extra].sort((a, b) => b.length - a.length)) for (const form of encodedForms(value)) out = out.split(form).join('[hidden]');
  return hideKeyLikeText(scrubSecrets(out)).text;
}

/** Runs in each frame: until the script ends, a credential field reports an empty value, so `el.value` cannot read it. */
function shadowFields(selector: string): number {
  const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<object> } }).document;
  const nodes = Array.from(doc.querySelectorAll(selector));
  for (const node of nodes) {
    const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
    Object.defineProperty(node, 'value', { configurable: true, get: () => '', set: (value: string) => { original?.set?.call(node, value); } });
  }
  return nodes.length;
}
function unshadowFields(selector: string): void {
  const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<object> } }).document;
  for (const node of Array.from(doc.querySelectorAll(selector))) delete (node as { value?: string }).value;
}

const allFrames = (page: Page): Frame[] => page.frames().filter(frame => !frame.isDetached());

/** JSON text of a script result: undefined and BigInt shown plainly, long output cut. */
export function showResult(result: unknown): string {
  if (result === undefined) return 'undefined';
  const text = JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? `${value}n` : typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2) ?? 'undefined';
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters cut)` : text;
}

/** Run a JavaScript expression or function in the page (or on the element a ref names, which the function receives) and return its JSON result.
 * A credential field reads as empty to the script, a script that goes looking for one is refused, and the answer is scrubbed like the page view. */
export async function evaluateOnPage(page: Page, args: { expression?: string; target?: string }, deps: Pick<PageDeps, 'locate'>): Promise<string> {
  const code = args.expression?.trim();
  if (!code) throw new Error('evaluate needs an expression, e.g. "document.title" or "el => el.scrollHeight" (with a target, the function gets that element).');
  if (code.length > 20_000) throw new Error('The script is too long (20,000 characters at most).');
  if (CREDENTIAL_SCRIPT.test(code)) throw new Error('evaluate does not read password, one-time-code or card fields, or form data. Fill those fields with fill (no text) and let the page do the rest.');
  const target = args.target?.trim() ? await deps.locate(page, args.target) : undefined;
  if (target && await target.evaluate((node, selector) => (node as unknown as { matches(selector: string): boolean }).matches(selector), SENSITIVE).catch(() => false)) throw new Error('That is a password, one-time-code or card field: its value is never read.');
  const held = [...await sensitiveValues(page), ...await keyFieldValues(page), ...(await pageSecrets(page)).map(item => item.value)];
  const frames = allFrames(page);
  const shadowed: Frame[] = [];
  for (const frame of frames) if (await frame.evaluate(shadowFields, SENSITIVE).then(count => count > 0, () => false)) shadowed.push(frame);
  const limit = new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('The script did not finish in 15 seconds.')), 15_000).unref?.(); });
  limit.catch(quiet('agent/computer/page-control'));
  try {
    // The expression is evaluated where the element lives; a function it yields is called (with the element, when there is one).
    const element = target ? await target.elementHandle({ timeout: 5_000 }) : undefined;
    const frame = (element ? await element.ownerFrame() : undefined) ?? page.mainFrame();
    const yielded = await frame.evaluateHandle(code);
    try {
      const run = element
        ? yielded.evaluate((value, node) => typeof value === 'function' ? (value as (arg: unknown) => unknown)(node) : value, element)
        : yielded.evaluate(value => typeof value === 'function' ? (value as () => unknown)() : value);
      return await hideFieldValues(page, showResult(await Promise.race([run, limit])), held);
    } finally { await yielded.dispose().catch(quiet('agent/computer/page-control')); await element?.dispose().catch(quiet('agent/computer/page-control')); }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 3).join('\n');
    throw new Error(await hideFieldValues(page, message, held));
  } finally { for (const frame of shadowed) await frame.evaluate(unshadowFields, SENSITIVE).catch(quiet('agent/computer/page-control')); }
}

// ---------------------------------------------------------------------------------------------------- screenshot

/** True while the page shows a typed credential, a saved secret or a key: a picture would show it too. */
export async function credentialShowing(page: Page): Promise<boolean> {
  if ((await sensitiveValues(page)).length || (await keyFieldValues(page)).length) return true;
  const snapshot = scrubSecrets(await maskSensitive(page, await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 } as never).catch(() => '') as string));
  if (hideKeyLikeText(snapshot).hidden) return true;
  const visible = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
    return `${doc.body.innerText}\n${Array.from(doc.querySelectorAll('input, textarea')).map(element => element.value ?? '').join('\n')}`;
  }).catch(() => '');
  return showsSecret(visible);
}

/** A picture of the page, or of one element; withheld while a credential shows. `output` is the sentence that goes with it. */
export async function takeScreenshot(page: Page, options: { target?: Locator; full?: boolean; label?: string }): Promise<{ output: string; images?: ToolRunResult['images'] }> {
  if (await credentialShowing(page)) return { output: '[Screenshot withheld: the page holds a typed credential or a saved secret.]' };
  const shoot = (quality: number): Promise<Buffer> => options.target
    ? options.target.screenshot({ type: 'jpeg', quality, animations: 'disabled', timeout: 10_000 })
    : page.screenshot({ type: 'jpeg', quality, animations: 'disabled', timeout: 15_000, ...(options.full ? { fullPage: true } : {}) });
  let bytes = await shoot(65);
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await shoot(35);
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `[Screenshot too large to show${options.full ? '; try without full, or with a target' : ''}.]` };
  return { output: options.label ?? 'Screenshot of the page.', images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

/** `with_screenshot` on any action: the result plus a picture of the page as it is now (when the host takes images). */
export async function withScreenshot(result: ToolRunResult, page: Page): Promise<ToolRunResult> {
  if (result.images?.length) return result;
  try {
    const shot = await takeScreenshot(page, {});
    return shot.images ? { ...result, images: shot.images } : { ...result, output: `${result.output}\n\n${shot.output}` };
  } catch { return result; }
}

// ---------------------------------------------------------------------------------------------------- the actions

type TabArgs = { index?: number; text?: string; target?: string };

async function tabLine(page: Page, index: number, current: boolean, deps: Pick<PageDeps, 'displayUrl'>): Promise<string> {
  const title = scrubSecrets((await page.title().catch(() => '')).replace(/\s+/g, ' ').slice(0, 80));
  return `${current ? '*' : ' '} ${index}: ${title ? `"${title}" ` : ''}${deps.displayUrl(page.url())}`;
}

export async function listTabs(deps: Pick<PageDeps, 'stateDir' | 'tab' | 'displayUrl'>): Promise<string> {
  const { pages, current } = ownedPages(deps.stateDir, deps.tab);
  const open = pages.filter(page => !page.isClosed());
  if (!open.length) return 'This chat has no open tab.';
  return `Tabs this chat opened (* is the one in front; pass index to switch or close):\n${(await Promise.all(open.map((page, index) => tabLine(page, index, page === current, deps)))).join('\n')}`;
}

/** The own tab `index` (0-based, as listed) or the one whose title or address contains `text`. Never another chat's tab. */
export async function pickTab(args: TabArgs, deps: Pick<PageDeps, 'stateDir' | 'tab'>): Promise<Page> {
  const open = ownedPages(deps.stateDir, deps.tab).pages.filter(page => !page.isClosed());
  if (args.index !== undefined) {
    if (!Number.isInteger(args.index) || args.index < 0 || args.index >= open.length) throw new Error(`No tab ${args.index}: this chat has ${open.length} (0 to ${Math.max(0, open.length - 1)}). Use tabs to list them.`);
    return open[args.index]!;
  }
  const words = (args.text ?? args.target)?.trim().toLowerCase();
  if (!words) throw new Error('Say which tab: index (from tabs) or words from its title or address in text.');
  const found: Page[] = [];
  for (const page of open) if (`${await page.title().catch(() => '')} ${page.url()}`.toLowerCase().includes(words)) found.push(page);
  if (found.length !== 1) throw new Error(`${found.length ? `${found.length} tabs match` : 'No tab matches'} "${words}". Use tabs to list them and pass index.`);
  return found[0]!;
}

export async function closeTab(args: TabArgs, deps: Pick<PageDeps, 'stateDir' | 'tab'>): Promise<string> {
  const page = await pickTab(args, deps);
  const url = page.url();
  await closeOwnedPage(deps.stateDir, page, deps.tab);
  return `Closed the tab${url ? ` (${url.slice(0, 80)})` : ''}.\n${await listTabs({ ...deps, displayUrl: value => value.slice(0, 120) })}`;
}

/** The actions that need no steps runner. `page` is the tab in front. */
export async function pageAction(page: Page, args: PageArgs & { action: string; target?: string; text?: string; find?: string; full?: boolean }, deps: PageDeps): Promise<ToolRunResult> {
  switch (args.action) {
    case 'back':
    case 'forward':
    case 'reload': {
      const before = page.url();
      const options = { waitUntil: 'domcontentloaded' as const, timeout: 20_000 };
      const response = args.action === 'back' ? await page.goBack(options) : args.action === 'forward' ? await page.goForward(options) : await page.reload(options);
      // goBack/goForward answer null for a move inside the same document too (a single-page app), so the address is the proof.
      if (!response && args.action !== 'reload' && page.url() === before) {
        await deps.settle(page);
        return { output: `There is no ${args.action === 'back' ? 'earlier' : 'later'} page in this tab's history.\n\n${(await deps.view(page, true)).output}`, isError: true };
      }
      await deps.settle(page);
      const view = await deps.view(page);
      return { ...view, output: `${args.action === 'back' ? 'Went back' : args.action === 'forward' ? 'Went forward' : 'Reloaded'}.\n\n${view.output}` };
    }
    case 'tabs': return { output: await listTabs(deps) };
    case 'switch': {
      const chosen = await pickTab(args, deps);
      await focusOwnedPage(deps.stateDir, chosen, deps.tab);
      const view = await deps.view(chosen);
      return { ...view, output: `Switched tabs.\n\n${view.output}` };
    }
    case 'evaluate': return { output: await evaluateOnPage(page, args, deps) };
    case 'console': return { output: await readConsole(page, { ...(args.level ? { level: args.level } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.find ? { find: args.find } : {}), ...(args.clear ? { clear: true } : {}) }) };
    case 'screenshot': {
      if (!deps.acceptsImages) return { output: 'This host cannot show images. Use observe to read the page.' };
      const target = args.target?.trim() ? await deps.locate(page, args.target) : undefined;
      const shot = await takeScreenshot(page, { ...(target ? { target } : {}), ...(args.full ? { full: true } : {}), label: target ? `Screenshot of ${args.target}.` : args.full ? 'Screenshot of the whole page.' : 'Screenshot of the visible page.' });
      return shot.images ? { output: `${shot.output}\nPage: ${deps.displayUrl(page.url())}`, images: shot.images } : { output: shot.output, ...(/too large/.test(shot.output) ? { isError: true } : {}) };
    }
    default: throw new Error(`Unknown action "${args.action}".`);
  }
}

// ---------------------------------------------------------------------------------------------------- tool definition pieces

export const PAGE_PARAMETERS = {
  index: { type: 'integer', description: 'switch, close: the tab number from tabs (0 is the first). With close and no index, close: closes all of this chat\'s tabs.' },
  new_tab: { type: 'boolean', description: 'open: open the address in an additional tab of your own and switch to it, instead of replacing the page in front.' },
  expression: { type: 'string', description: 'evaluate: a JavaScript expression ("document.title") or function ("el => el.getBoundingClientRect().width"; with target, it gets that element). Its JSON result comes back, shortened. Password, one-time-code and card values read as empty and are hidden.' },
  with_screenshot: { type: 'boolean', description: 'Any action: also return a screenshot of the page after it (hosts that take images; withheld while a credential shows).' },
  button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click: the mouse button (default left).' },
  count: { type: 'integer', description: 'click: 2 double-clicks, 3 triple-clicks (selects a line or paragraph).' },
  modifiers: { type: ['array', 'string'], items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta'] }, description: 'click: keys held during the click, e.g. ["Shift"] to select a range, ["ControlOrMeta"] to open a link in a new tab.' },
  x: { type: 'number', description: 'click, hover, drag: a position in the visible page in pixels (for a canvas or map); with target, the offset inside that element.' },
  y: { type: 'number', description: 'click, hover, drag: see x.' },
  to_target: { type: 'string', description: 'drag: the [ref=…] or text to drop onto (target is what is dragged).' },
  to_x: { type: 'number', description: 'drag: where to drop, in visible-page pixels (with to_y), when there is no to_target.' },
  to_y: { type: 'number', description: 'drag: see to_x.' },
  amount: { type: 'number', description: 'scroll: pixels (default 600).' },
  until: { type: 'string', enum: ['text', 'network_idle', 'visible', 'hidden', 'enabled', 'disabled', 'url'], description: 'wait: what to wait for. text (default with text), network_idle (no requests for half a second), visible / hidden / enabled / disabled (the state of target or selector), url (the address contains url, or changes when url is left out).' },
  selector: { type: 'string', description: 'wait: a CSS selector to wait on, when there is no ref for it yet.' },
  level: { type: 'string', enum: ['error', 'warning', 'info', 'log', 'debug'], description: 'console: show this level and worse (error shows errors and page errors only).' },
  limit: { type: 'integer', description: 'console: how many of the newest messages (default 30, up to 200).' },
  clear: { type: 'boolean', description: 'console: forget the messages after showing them.' },
} as const;

export const PAGE_DESCRIPTION = 'Page control: back · forward · reload (history of the tab) · tabs (list the tabs this chat opened) · switch (index, or words of the title or address in text) · close with index closes one of your tabs · open with new_tab: true opens another · evaluate (expression: run JavaScript in the page and get its JSON result; target runs it on one element) · screenshot (the visible page; full: true the whole page; target one element) · console (recent console messages and page errors of the tab; level, limit, clear) · hover · drag (target to to_target, or x/y to to_x/to_y) · click takes button (left/right/middle), count (2 = double click), modifiers (Shift, Control, Alt, Meta) and x/y for a canvas · press takes any key or combination (Enter, /, Control+a, Meta+k, Shift+Tab) · scroll takes direction up/down/left/right/top/bottom, amount, and a target (alone: scrolled into view; with direction: scrolls inside it) · wait takes until network_idle, visible, hidden, enabled, disabled (target or selector) or url (url, or any change) as well as text · fill works on rich-text editors, date/time boxes (write 2026-10-26 or 10/26/2026), dropdowns and very long text · with_screenshot adds a picture to any result.';
