import { describe, expect, it } from 'vitest';
import { computerDesktopAction, computerDriverAction, computerTools } from './computer.js';

describe('computer tool boundary', () => {
  it('offers a small window-scoped surface', () => {
    expect(computerTools.map((tool) => tool.name)).toEqual(['computer_desktop', 'computer_windows', 'computer_observe', 'computer_act']);
    expect(computerTools.map((tool) => tool.class)).toEqual(['exec', 'exec', 'exec', 'exec']);
  });

  it('sends an exact window target and a fresh element handle to Cua', () => {
    expect(computerDriverAction({ pid: 42, window_id: 7, action: 'click', element_token: 'opaque' }))
      .toEqual({ name: 'click', args: { pid: 42, window_id: 7, scope: 'window', element_token: 'opaque' } });
    expect(computerDriverAction({ pid: 42, window_id: 7, action: 'type', x: 5, y: 9, text: 'hello' }))
      .toEqual({ name: 'type_text', args: { pid: 42, window_id: 7, scope: 'window', x: 5, y: 9, text: 'hello' } });
  });

  it('rejects actions without a proven target', () => {
    expect(() => computerDriverAction({ pid: 42, window_id: 7, action: 'click' })).toThrow('element_token or x and y');
    expect(() => computerDriverAction({ pid: 0, window_id: 7, action: 'click', x: 1, y: 2 })).toThrow('exact window');
    expect(() => computerDriverAction({ pid: 42, window_id: 7, action: 'hotkey', keys: ['ctrl', 'a;rm'] })).toThrow('simple keys');
  });

  it('can observe and act on the primary desktop after computer use is enabled', () => {
    expect(computerDesktopAction({ action: 'observe' })).toEqual({ name: 'get_desktop_state', args: {} });
    expect(computerDesktopAction({ action: 'click', x: 42, y: 7 })).toEqual({
      name: 'click', args: { scope: 'desktop', target: { kind: 'desktop', display_id: 'primary' }, x: 42, y: 7 },
    });
    expect(() => computerDesktopAction({ action: 'click' })).toThrow('x and y');
    expect(computerDesktopAction({ action: 'hotkey', keys: ['ctrl', 'l'] }).name).toBe('hotkey');
  });

});
