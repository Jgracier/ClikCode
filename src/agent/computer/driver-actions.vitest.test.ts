import { describe, expect, it } from 'vitest';
import { computerDriverAction } from './driver-actions.js';
import { computerTools } from '../tools/computer.js';

const desktop = { kind: 'desktop', display_id: 'primary' };
const win = { pid: 42, window_id: 7 };

describe('computer_use pointer actions', () => {
  it('double and right click go to the window tools, and to click with a count or button on the desktop', () => {
    expect(computerDriverAction({ ...win, action: 'double_click', x: 5, y: 9 })).toEqual({ name: 'double_click', args: { pid: 42, window_id: 7, x: 5, y: 9 } });
    expect(computerDriverAction({ ...win, action: 'right_click', element_token: 's1:4' })).toEqual({ name: 'right_click', args: { pid: 42, window_id: 7, element_token: 's1:4' } });
    expect(computerDriverAction({ action: 'double_click', x: 5, y: 9 })).toEqual({ name: 'click', args: { target: desktop, x: 5, y: 9, count: 2 } });
    expect(computerDriverAction({ action: 'right_click', x: 5, y: 9 })).toEqual({ name: 'click', args: { target: desktop, x: 5, y: 9, button: 'right' } });
    expect(() => computerDriverAction({ ...win, action: 'double_click' })).toThrow('element_token or x and y');
    expect(() => computerDriverAction({ action: 'right_click' })).toThrow('x and y');
  });

  it('drags between two points in a window or on the desktop', () => {
    expect(computerDriverAction({ ...win, action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 }))
      .toEqual({ name: 'drag', args: { pid: 42, window_id: 7, scope: 'window', from_x: 1, from_y: 2, to_x: 30, to_y: 40 } });
    expect(computerDriverAction({ action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 }).args).toMatchObject({ target: desktop, from_x: 1, to_y: 40 });
    expect(() => computerDriverAction({ ...win, action: 'drag', x: 1, y: 2 })).toThrow('to_x and to_y');
    expect(() => computerDriverAction({ ...win, action: 'drag', x: -1, y: 2, to_x: 3, to_y: 4 })).toThrow('Drag needs');
  });

  it('zooms into a window region given by two corners', () => {
    expect(computerDriverAction({ ...win, action: 'zoom', x: 10, y: 20, to_x: 110, to_y: 90 }))
      .toEqual({ name: 'zoom', args: { pid: 42, window_id: 7, x1: 10, y1: 20, x2: 110, y2: 90 } });
    expect(() => computerDriverAction({ action: 'zoom', x: 1, y: 1, to_x: 5, to_y: 5 })).toThrow('exact window');
    expect(() => computerDriverAction({ ...win, action: 'zoom', x: 50, y: 20, to_x: 10, to_y: 90 })).toThrow('corners');
  });
});

describe('computer_use foreground delivery', () => {
  it('is sent only when asked for, per call', () => {
    expect(computerDriverAction({ ...win, action: 'key', key: 'Enter' }).args).not.toHaveProperty('delivery_mode');
    expect(computerDriverAction({ ...win, action: 'key', key: 'Enter', delivery: 'background' }).args).not.toHaveProperty('delivery_mode');
    const requests = [
      { action: 'key', key: 'Enter' }, { action: 'hotkey', keys: ['ctrl', 'a'] }, { action: 'scroll', direction: 'down' },
      { action: 'click', x: 1, y: 1 }, { action: 'double_click', x: 1, y: 1 }, { action: 'right_click', x: 1, y: 1 },
      { action: 'type', text: 'hi', x: 1, y: 1 }, { action: 'drag', x: 1, y: 1, to_x: 2, to_y: 2 },
    ] as const;
    for (const request of requests) {
      expect(computerDriverAction({ ...request, ...win, delivery: 'foreground' }).args, request.action).toMatchObject({ delivery_mode: 'foreground' });
      expect(computerDriverAction({ ...request, delivery: 'foreground' }).args, `${request.action} on the desktop`).toMatchObject({ delivery_mode: 'foreground' });
    }
  });

  it('is refused where no input is sent, and for any other value', () => {
    expect(() => computerDriverAction({ ...win, action: 'observe', delivery: 'foreground' })).toThrow('only to click');
    expect(() => computerDriverAction({ ...win, action: 'invoke_menu', path: ['File'], delivery: 'foreground' })).toThrow('only to click');
    expect(() => computerDriverAction({ ...win, action: 'key', key: 'a', delivery: 'sudo' as 'foreground' })).toThrow('background');
  });
});

describe('computer_use app, menu, window and clipboard actions', () => {
  it('lists apps, the screen size and reads the clipboard text only on request', () => {
    expect(computerDriverAction({ action: 'apps' })).toEqual({ name: 'list_apps', args: {} });
    expect(computerDriverAction({ action: 'screen_size' })).toEqual({ name: 'get_screen_size', args: {} });
    expect(computerDriverAction({ action: 'clipboard_read' })).toEqual({ name: 'clipboard_read', args: { include_text: true } });
  });

  it('writes plain text to the clipboard and nothing else', () => {
    expect(computerDriverAction({ action: 'clipboard_write', text: 'hello' })).toEqual({ name: 'clipboard_write', args: { text: 'hello' } });
    expect(() => computerDriverAction({ action: 'clipboard_write' })).toThrow('Clipboard write needs text');
    expect(() => computerDriverAction({ action: 'clipboard_write', text: 'x'.repeat(20_001) })).toThrow('Clipboard write needs text');
  });

  it('names an app the way each OS wants it', () => {
    expect(computerDriverAction({ action: 'launch_app', app: 'gnome-calculator' }, 'linux')).toEqual({ name: 'launch_app', args: { name: 'gnome-calculator' } });
    expect(computerDriverAction({ action: 'launch_app', app: 'Google Chrome' }, 'darwin').args).toEqual({ name: 'Google Chrome' });
    expect(computerDriverAction({ action: 'launch_app', app: 'com.apple.Safari' }, 'darwin').args).toEqual({ bundle_id: 'com.apple.Safari' });
    expect(computerDriverAction({ action: 'launch_app', app: 'com.apple.Safari' }, 'linux').args).toEqual({ name: 'com.apple.Safari' });
    expect(computerDriverAction({ action: 'launch_app', app: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, 'win32').args).toEqual({ aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
    expect(computerDriverAction({ action: 'launch_app', app: 'notepad' }, 'win32').args).toEqual({ name: 'notepad' });
    expect(computerDriverAction({ action: 'launch_app', urls: ['https://example.com/a?b=1'] }).args).toEqual({ urls: ['https://example.com/a?b=1'] });
  });

  it('refuses a path, a command line with flags, a non-web address, or nothing', () => {
    for (const app of ['/usr/bin/rm', 'C:\\Windows\\cmd.exe', 'bash -c id', 'x; reboot', '-rf', '$(id)']) {
      expect(() => computerDriverAction({ action: 'launch_app', app }), app).toThrow('app name or id');
    }
    expect(() => computerDriverAction({ action: 'launch_app', urls: ['file:///etc/passwd'] })).toThrow('http or https');
    expect(() => computerDriverAction({ action: 'launch_app', urls: ['javascript:alert(1)'] })).toThrow('http or https');
    expect(() => computerDriverAction({ action: 'launch_app', urls: [] })).toThrow('http or https');
    expect(() => computerDriverAction({ action: 'launch_app' })).toThrow('Launch needs');
  });

  it('brings a window forward and invokes a menu path in an exact window only', () => {
    expect(computerDriverAction({ ...win, action: 'bring_to_front' })).toEqual({ name: 'bring_to_front', args: { pid: 42, window_id: 7 } });
    expect(() => computerDriverAction({ action: 'bring_to_front' })).toThrow('exact window');
    expect(computerDriverAction({ ...win, action: 'invoke_menu', path: ['File', 'Save As...'] })).toEqual({ name: 'invoke_menu', args: { pid: 42, window_id: 7, path: ['File', 'Save As...'] } });
    expect(() => computerDriverAction({ action: 'invoke_menu', path: ['File'] })).toThrow('exact window');
    expect(() => computerDriverAction({ ...win, action: 'invoke_menu', path: [] })).toThrow('menu labels');
    expect(() => computerDriverAction({ ...win, action: 'invoke_menu', path: [' '] })).toThrow('menu labels');
    expect(() => computerDriverAction({ ...win, action: 'invoke_menu', path: Array(17).fill('a') as string[] })).toThrow('menu labels');
  });

  it('moves and sizes one exact window', () => {
    expect(computerDriverAction({ ...win, action: 'set_window_frame', x: -10, y: 20, width: 800, height: 600 }))
      .toEqual({ name: 'set_window_frame', args: { pid: 42, window_id: 7, x: -10, y: 20, width: 800, height: 600 } });
    expect(() => computerDriverAction({ ...win, action: 'set_window_frame', x: 0, y: 0, width: 0, height: 5 })).toThrow('Set window frame needs');
    expect(() => computerDriverAction({ action: 'set_window_frame', x: 0, y: 0, width: 5, height: 5 })).toThrow('exact window');
  });

  it('never offers to kill an app or hold a mouse button', () => {
    const properties = (computerTools[0]!.parameters as { properties: { action: { enum: string[] } } }).properties;
    expect(properties.action.enum.join(',')).not.toMatch(/kill|mouse_button/);
  });
});
