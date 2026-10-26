import { describe, expect, it } from 'vitest';
import { computerWebTool } from '../tools/computer-web.js';
import { describeConsole, pickConsole, type ConsoleEntry } from './console-log.js';
import { checkKey, checkModifiers, clickExtras, normalizeDateValue, PAGE_ACTIONS, showResult } from './page-control.js';

describe('checkKey', () => {
  it('accepts single characters of any kind, key names and combinations', () => {
    for (const key of ['a', 'A', '/', '.', ' ', '?', 'é', '+', 'Enter', 'Escape', 'ArrowDown', 'F5', 'KeyA', 'Control+a', 'Meta+k', 'Shift+Tab', 'Control+Shift+ArrowLeft', 'ControlOrMeta+a', 'Control++']) expect(() => checkKey(key), key).not.toThrow();
    expect(checkKey('Control++')).toBe('Control++');
    expect(checkKey(' ')).toBe(' ');
  });
  it('refuses text, control characters, unknown modifiers and long chains', () => {
    for (const key of ['', undefined, 'hello world', 'a\nb', '\u0007', 'Foo+a', 'Control+', '+a', 'Control+Shift+Alt+Meta+a+b', 'rm -rf', 'Enter;ls', 'a+b']) expect(() => checkKey(key as string), String(key)).toThrow();
  });
});

describe('click options', () => {
  it('reads modifiers from a list or a string, and refuses unknown ones', () => {
    expect(checkModifiers(['Shift', 'Control'])).toEqual(['Shift', 'Control']);
    expect(checkModifiers('Control+Shift')).toEqual(['Control', 'Shift']);
    expect(checkModifiers(undefined)).toEqual([]);
    expect(() => checkModifiers(['Hyper'])).toThrow('not a modifier');
  });
  it('is undefined for a plain click and describes anything else', () => {
    expect(clickExtras({})).toBeUndefined();
    expect(clickExtras({ button: 'right' })).toEqual({ button: 'right', clickCount: 1, modifiers: [] });
    expect(clickExtras({ count: 2, modifiers: ['Shift'] })).toEqual({ button: 'left', clickCount: 2, modifiers: ['Shift'] });
    expect(() => clickExtras({ count: 9 })).toThrow('count');
    expect(() => clickExtras({ button: 'back' as never })).toThrow('button');
  });
});

describe('normalizeDateValue', () => {
  it('writes dates, times and months the way the input wants them', () => {
    expect(normalizeDateValue('date', '10/26/2026')).toBe('2026-10-26');
    expect(normalizeDateValue('date', '2026-1-5')).toBe('2026-01-05');
    expect(normalizeDateValue('date', '2026/10/26')).toBe('2026-10-26');
    expect(normalizeDateValue('time', '3:45 PM')).toBe('15:45');
    expect(normalizeDateValue('time', '12:05 am')).toBe('00:05');
    expect(normalizeDateValue('time', '09:30')).toBe('09:30');
    expect(normalizeDateValue('month', '10/2026')).toBe('2026-10');
    expect(normalizeDateValue('datetime-local', '10/26/2026 3:45 PM')).toBe('2026-10-26T15:45');
    expect(normalizeDateValue('datetime-local', '2026-10-26 09:00')).toBe('2026-10-26T09:00');
  });
  it('passes through what it cannot read, so the field can say it does not take it', () => {
    expect(normalizeDateValue('date', 'next tuesday')).toBe('next tuesday');
    expect(normalizeDateValue('time', 'noon')).toBe('noon');
  });
});

describe('showResult', () => {
  it('prints JSON, names undefined and BigInt, and cuts a long result', () => {
    expect(showResult({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(showResult(undefined)).toBe('undefined');
    expect(showResult({ big: 5n })).toContain('"5n"');
    const long = showResult('x'.repeat(20_000));
    expect(long.length).toBeLessThan(8_200);
    expect(long).toContain('more characters cut');
  });
});

describe('console log', () => {
  const entries: ConsoleEntry[] = [
    { level: 'log', text: 'hello', at: 1 }, { level: 'warning', text: 'careful', at: 2 }, { level: 'error', text: 'boom', at: 3 }, { level: 'pageerror', text: 'Error: late', at: 4 }, { level: 'debug', text: 'noise', at: 5 },
  ];
  it('keeps a level and worse, filters by words and caps the count', () => {
    expect(pickConsole(entries, { level: 'error' }).map(entry => entry.text)).toEqual(['boom', 'Error: late']);
    expect(pickConsole(entries, { level: 'warn' }).map(entry => entry.text)).toEqual(['careful', 'boom', 'Error: late']);
    expect(pickConsole(entries, { find: 'HELLO' }).map(entry => entry.text)).toEqual(['hello']);
    expect(pickConsole(entries, { limit: 2 }).map(entry => entry.text)).toEqual(['Error: late', 'noise']);
  });
  it('says when there is nothing, or nothing that matches', () => {
    expect(describeConsole([], 0)).toContain('empty');
    expect(describeConsole([], 3)).toBe('No console messages match.');
    expect(describeConsole(entries.slice(0, 1), 5)).toContain('1 of 5');
  });
});

describe('browser_use page control definition', () => {
  const properties = (computerWebTool.parameters as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
  const label = (args: Record<string, unknown>): string => computerWebTool.label(args as never);
  it('lists every new action in the action list and the help', async () => {
    for (const action of [...PAGE_ACTIONS, 'hover', 'drag']) expect(properties['action']!.description, action).toContain(action);
    const help = await computerWebTool.run({ action: 'help' } as never, { stateDir: '/nonexistent-clikcode-test' } as never);
    expect(help.output).toContain('evaluate');
  });
  it('has a schema entry for every new argument', () => {
    for (const name of ['index', 'new_tab', 'expression', 'with_screenshot', 'button', 'count', 'modifiers', 'x', 'y', 'to_target', 'to_x', 'to_y', 'amount', 'until', 'selector', 'level', 'limit', 'clear']) expect(properties[name], name).toBeDefined();
    expect(properties['direction']!.enum).toEqual(['up', 'down', 'left', 'right', 'top', 'bottom']);
  });
  it('names each new action in the plan text', async () => {
    expect(label({ action: 'back' })).toBe('Go back');
    expect(label({ action: 'tabs' })).toBe('List tabs');
    expect(label({ action: 'switch', index: 2 })).toBe('Switch to tab 2');
    expect(label({ action: 'evaluate', expression: '1' })).toBe('Run a script on the page');
    expect(label({ action: 'drag', target: 'e3' })).toBe('Drag e3');
    expect(label({ action: 'screenshot' })).toBe('Take a screenshot');
    expect(label({ action: 'scroll', direction: 'top' })).toBe('Scroll top');
    // The plan shows what script will run.
    expect(await computerWebTool.describe!({ action: 'evaluate', expression: 'document.title' } as never)).toContain('"document.title"');
  });
  it('refuses a call by an unknown action name still', async () => {
    const result = await computerWebTool.run({ action: 'teleport' } as never, { stateDir: '/nonexistent-clikcode-test' } as never);
    expect(result.isError).toBe(true);
  });
});
