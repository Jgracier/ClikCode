import { describe, expect, it } from 'vitest';
import { backgroundOnly, backgroundOnlyNotice, computerDriverAction, computerTools } from './computer.js';
import { driverEnv, driverVersionNotice } from '../computer/driver.js';

describe('computer_desktop boundary', () => {
  it('is one tool', () => {
    expect(computerTools.map((tool) => tool.name)).toEqual(['computer_desktop']);
    expect(computerTools.map((tool) => tool.class)).toEqual(['exec']);
  });

  it('lists windows and observes the desktop or one window', () => {
    expect(computerDriverAction({ action: 'windows' })).toEqual({ name: 'list_windows', args: { on_screen_only: true } });
    expect(computerDriverAction({ action: 'observe' })).toEqual({ name: 'get_desktop_state', args: {} });
    expect(computerDriverAction({ action: 'observe', pid: 42, window_id: 7, query: 'OK' }))
      .toEqual({ name: 'get_window_state', args: { pid: 42, window_id: 7, max_elements: 1500, query: 'OK' } });
  });

  it('sends an exact window target and a fresh element handle to Cua', () => {
    expect(computerDriverAction({ pid: 42, window_id: 7, action: 'click', element_token: 'opaque' }))
      .toEqual({ name: 'click', args: { pid: 42, window_id: 7, scope: 'window', element_token: 'opaque' } });
    expect(computerDriverAction({ pid: 42, window_id: 7, action: 'type', x: 5, y: 9, text: 'hello' }))
      .toEqual({ name: 'type_text', args: { pid: 42, window_id: 7, scope: 'window', x: 5, y: 9, text: 'hello' } });
  });

  it('acts on the primary desktop when no window is named', () => {
    expect(computerDriverAction({ action: 'click', x: 42, y: 7 })).toEqual({
      name: 'click', args: { target: { kind: 'desktop', display_id: 'primary' }, x: 42, y: 7 },
    });
    expect(computerDriverAction({ action: 'hotkey', keys: ['ctrl', 'l'] }).name).toBe('hotkey');
    // An element token only means something inside a window.
    expect(() => computerDriverAction({ action: 'click', element_token: 'opaque' })).toThrow('x and y');
  });

  it('rejects actions without a proven target', () => {
    expect(() => computerDriverAction({ pid: 42, window_id: 7, action: 'click' })).toThrow('element_token or x and y');
    expect(() => computerDriverAction({ pid: 0, window_id: 7, action: 'click', x: 1, y: 2 })).toThrow('exact window');
    expect(() => computerDriverAction({ pid: 42, action: 'click', x: 1, y: 2 })).toThrow('exact window');
    expect(() => computerDriverAction({ pid: 42, window_id: 7, action: 'hotkey', keys: ['ctrl', 'a;rm'] })).toThrow('simple keys');
  });
});

describe('computer_desktop on Linux Wayland', () => {
  it('turns on Cua\'s Wayland backend only in a Linux Wayland session', () => {
    expect(driverEnv({ XDG_SESSION_TYPE: 'wayland' }, 'linux')).toEqual({ CUA_DRIVER_RS_ENABLE_WAYLAND: '1' });
    expect(driverEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual({ CUA_DRIVER_RS_ENABLE_WAYLAND: '1' });
    expect(driverEnv({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, 'linux')).toEqual({});
    expect(driverEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'darwin')).toEqual({});
  });

  it('names an installed cua-driver too old to see Wayland windows, and nothing else', () => {
    expect(driverVersionNotice('cua-driver 0.21.0\n', true)).toContain('cua-driver update --apply');
    expect(driverVersionNotice('cua-driver 0.38.0\n', true)).toBeUndefined();
    expect(driverVersionNotice('cua-driver 1.0.0\n', true)).toBeUndefined();
    expect(driverVersionNotice('cua-driver 0.21.0\n', false)).toBeUndefined();
  });

  it('answers Cua\'s foreground-only refusal with what this tool can do instead', () => {
    const refused = { output: 'Background delivery is not available: ... Retry this action with delivery_mode:"foreground"', isError: true };
    expect(backgroundOnly(refused).output).toBe(backgroundOnlyNotice);
    expect(backgroundOnly({ output: 'Clicked element [30].' }).output).toBe('Clicked element [30].');
  });
});
