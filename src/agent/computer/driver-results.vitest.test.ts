import { describe, expect, it } from 'vitest';
import {
  backgroundOnly, backgroundOnlyNotice, foregroundUnavailableNotice, friendlyDriverError, macosAccessibilityNotice, macosScreenRecordingNotice,
  clipboardReply, permissionsNotice, scrubClipboard, summarizeApps, windowsElevatedNotice,
} from './driver-results.js';

const app = (name: string, extra: Record<string, unknown> = {}) => ({ name, pid: 0, running: false, bundle_id: null, kind: null, windows: [], ...extra });
const window = (id: number, title: string, width = 800, height = 600) => ({ window_id: id, title, width, height });

describe('apps listing', () => {
  const kernelThreads = Array.from({ length: 300 }, (_, i) => app(`kworker/${i}`, { pid: i + 2, running: true }));
  const result = { structuredContent: { apps: [
    ...kernelThreads,
    app('Calculator', { pid: 100, running: true, bundle_id: 'org.gnome.Calculator', windows: [window(9, 'Calculator')] }),
    app('evolution-alarm', { pid: 101, running: true, windows: [window(101, 'evolution-alarm-notify', 0, 0)] }),
    app('Inkscape', { kind: 'desktop', bundle_id: 'org.inkscape.Inkscape' }),
  ] } };

  it('lists only running apps that own a visible window, not kernel threads or zero-size helpers', () => {
    const text = summarizeApps(result)!;
    expect(text).toContain('1 running app(s) with a window');
    expect(text).toContain('Calculator (pid 100) [org.gnome.Calculator]: window 9 "Calculator"');
    expect(text).not.toContain('kworker');
    expect(text).not.toContain('evolution-alarm');
    expect(text).toContain('1 installed apps are not listed; pass query');
  });

  it('lists a process once when two launcher entries match it', () => {
    const twice = { structuredContent: { apps: [
      app('Code', { pid: 7, running: true, bundle_id: 'com.microsoft.VSCode', windows: [window(5, 'Editor')] }),
      app('Code', { pid: 7, running: true, bundle_id: 'code_code', windows: [window(5, 'Editor')] }),
    ] } };
    expect(summarizeApps(twice)!).toContain('1 running app(s) with a window');
  });

  it('searches installed apps only when asked', () => {
    const text = summarizeApps(result, 'ink')!;
    expect(text).toContain('Inkscape [org.inkscape.Inkscape] (installed, not running)');
    expect(text).not.toContain('Calculator (pid');
  });

  it('gives up on a shape it does not know', () => {
    expect(summarizeApps({ structuredContent: { other: 1 } })).toBeUndefined();
    expect(summarizeApps({})).toBeUndefined();
  });
});

describe('clipboard text', () => {
  it('hides key-shaped and token-shaped text, and says it was read', () => {
    const out = scrubClipboard('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnopqrstuv and a normal sentence');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(out).toContain('a normal sentence');
    expect(out).toContain('read on request');
  });

  it('takes the text from Cua\'s structured result, where it keeps it', () => {
    const reply = clipboardReply({ structuredContent: { text: 'my note ghp_abcdefghijklmnopqrstuvwxyz0123456789', types: ['text/plain'] } }, 'Clipboard read succeeded.');
    expect(reply).toContain('Clipboard text:\nmy note');
    expect(reply).not.toContain('ghp_abcdef');
    expect(clipboardReply({ structuredContent: { text: '', types: [] } }, 'ok')).toContain('holds no text');
    expect(clipboardReply({}, 'ok')).toContain('holds no text');
  });

  it('cuts a very long clipboard', () => {
    expect(scrubClipboard('word '.repeat(5000))).toContain('cut at 8000 characters');
  });
});

describe('driver errors', () => {
  const refused = { output: 'Background delivery is not available: ... Retry this action with delivery_mode:"foreground"', isError: true };

  it('offers foreground delivery for a background refusal, and element actions when foreground is closed too', () => {
    expect(backgroundOnly(refused).output).toBe(backgroundOnlyNotice);
    expect(backgroundOnlyNotice).toContain('delivery "foreground"');
    expect(backgroundOnly(refused, true).output).toBe(foregroundUnavailableNotice);
    expect(backgroundOnly({ output: 'Foreground delivery is not available: the Shell helper is disabled', isError: true }, true).output).toContain(foregroundUnavailableNotice);
    const closed = backgroundOnly({ output: 'foreground_unavailable: no trusted Wayland compositor adapter can confirm exact target window 1', isError: true }, true).output;
    expect(closed).toContain(foregroundUnavailableNotice);
    expect(closed).toContain('Cua said: foreground_unavailable');
    expect(backgroundOnly({ output: 'Clicked element [30].' }).output).toBe('Clicked element [30].');
  });

  it('turns macOS permission errors into the one thing to do, keeping what Cua said', () => {
    const accessibility = friendlyDriverError({ output: 'Accessibility permission not granted', isError: true }, 'darwin');
    expect(accessibility.output).toContain(macosAccessibilityNotice);
    expect(accessibility.output).toContain('Cua said: Accessibility permission not granted');
    expect(friendlyDriverError({ output: 'Screen Recording permission not granted', isError: true }, 'darwin').output).toContain(macosScreenRecordingNotice);
    expect(friendlyDriverError({ output: 'Accessibility permission not granted', isError: true }, 'linux').output).toBe('Accessibility permission not granted');
  });

  it('explains Windows elevated windows and session 0', () => {
    expect(friendlyDriverError({ output: 'SendInput failed: Access is denied (0x80070005)', isError: true }, 'win32').output).toContain(windowsElevatedNotice);
    expect(friendlyDriverError({ output: 'Refused: SessionId 0 has no desktop', isError: true }, 'win32').output).toContain('session 0');
    expect(friendlyDriverError({ output: 'fine', isError: false }, 'win32').output).toBe('fine');
  });

  it('reads the macOS grants from permissions status', () => {
    expect(permissionsNotice('{"accessibility":false,"screen_recording":true}', 'darwin')).toBe(macosAccessibilityNotice);
    expect(permissionsNotice('{"accessibility":true,"screen_recording":false}', 'darwin')).toBe(macosScreenRecordingNotice);
    expect(permissionsNotice('{"accessibility":true,"screen_recording":true}', 'darwin')).toBeUndefined();
    expect(permissionsNotice('not json', 'darwin')).toBeUndefined();
    expect(permissionsNotice('{"accessibility":false}', 'linux')).toBeUndefined();
  });
});
