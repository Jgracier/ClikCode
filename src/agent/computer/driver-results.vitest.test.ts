import { describe, expect, it } from 'vitest';
import {
  backgroundOnly, backgroundOnlyNotice, foregroundUnavailableNotice, friendlyDriverError, macosAccessibilityNotice, macosPermissionsPendingNotice, noWindowFrameNotice, macosScreenRecordingNotice,
  clipboardReply, permissionsNotice, scrubClipboard, summarizeApps, windowsElevatedNotice,
  driverElementToken, inToolWords, noElementTokensNotice, noObservationNotice, observedSnapshot, staleTokenNotice, unaddressableObservation, withTokenLine,
} from './driver-results.js';

const app = (name: string, extra: Record<string, unknown> = {}) => ({ name, pid: 0, running: false, bundle_id: null, kind: null, windows: [], ...extra });
const window = (id: number, title: string, width = 800, height = 600) => ({ window_id: id, title, width, height });

describe('apps listing on macOS, where cua gives no window list per app', () => {
  it('still lists the running desktop apps', () => {
    const result = { structuredContent: { apps: [
      { name: 'Calculator', pid: 36804, running: true, bundle_id: 'com.apple.calculator', kind: 'desktop' },
      { name: 'Pages', running: false, bundle_id: 'com.apple.iWork.Pages', kind: 'desktop' },
    ] } } as never;
    const text = summarizeApps(result) ?? '';
    expect(text).toContain('1 running app(s)');
    expect(text).toContain('Calculator (pid 36804) [com.apple.calculator]: use the windows action');
    expect(summarizeApps(result, 'Calc')).toContain('Calculator');
  });
});

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

  it('replaces cua\'s internal tool name when a window pixel action has no screenshot yet', () => {
    const said = 'No screenshot frame for window 9639: its latest read had no screenshot. Call get_window_state(pid:1, window_id:2) with the default screenshot.';
    const reply = friendlyDriverError({ output: said, isError: true }, 'darwin');
    expect(reply.output.startsWith(noWindowFrameNotice)).toBe(true);
    expect(friendlyDriverError({ output: said, isError: true }, 'linux').output.startsWith(noWindowFrameNotice)).toBe(true);
  });

  it('reads the macOS grants from permissions status', () => {
    expect(permissionsNotice('{"accessibility":false,"screen_recording":true}', 'darwin')).toBe(macosAccessibilityNotice);
    expect(permissionsNotice('{"accessibility":true,"screen_recording":false}', 'darwin')).toBe(macosScreenRecordingNotice);
    expect(permissionsNotice('{"accessibility":true,"screen_recording":true}', 'darwin')).toBeUndefined();
    expect(permissionsNotice('not json', 'darwin')).toBeUndefined();
    // What cua-driver 0.38 really prints on a Mac before the grant is approved, with and without its daemon.
    expect(permissionsNotice('{"daemon_running":false,"status":"unknown"}', 'darwin')).toBe(macosPermissionsPendingNotice);
    expect(permissionsNotice('{"daemon_running":true,"status":"unknown"}', 'darwin')).toBe(macosPermissionsPendingNotice);
    expect(friendlyDriverError({ output: 'permissions_pending: macOS Accessibility or Screen Recording permission is still pending; no action started', isError: true }, 'darwin').output).toContain(macosPermissionsPendingNotice);
    expect(permissionsNotice('{"accessibility":false}', 'linux')).toBeUndefined();
  });
});

/** What cua-driver 0.38 really prints on Linux (GNOME Wayland), captured from the driver. */
describe('element tokens of a window observe', () => {
  const tree = '- [0] frame "Billing - Google Chrome" [actions=[doDefault,showContextMenu]]\n  - [77] page tab "Amazon Web Services" [actions=[doDefault,showContextMenu]]';
  const withId = { content: [{ type: 'text', text: `window_id=193265467392 pid=2948997 elements=187 walk_ms=439 snapshot_id=s0000002a\nelement_token for row [N] = s0000002a:N (row [1] is "s0000002a:1")\n\n${tree}` }], structuredContent: { snapshot_id: 's0000002a', pid: 2948997 } } as never;
  const noId = { content: [{ type: 'text', text: `window_id=193265467392 pid=2948997 elements=187 walk_ms=439\n\n${tree}` }], structuredContent: { pid: 2948997 } } as never;

  it('finds the snapshot in the structured result or the header, and none when the read made none', () => {
    expect(observedSnapshot(withId)).toBe('s0000002a');
    expect(observedSnapshot({ content: (withId as { content: never }).content } as never)).toBe('s0000002a');
    expect(observedSnapshot(noId)).toBeUndefined();
    expect(observedSnapshot({ structuredContent: { snapshot_id: 'get_window_state' } } as never)).toBeUndefined();
  });

  it('knows a read of the whole app, which has no tokens, from an ordinary one', () => {
    // cua-driver 0.38.0 and 0.56.8, GNOME Wayland, a Chrome process with five windows.
    const appWide = { content: (noId as { content: never }).content, structuredContent: { pid: 2954614, degraded: true, degraded_reason: 'accessibility_window_identity_unproven: tree is application-scoped; exact-window element tokens and bounds are unavailable' } } as never;
    expect(unaddressableObservation(appWide)).toBe(true);
    expect(unaddressableObservation(withId)).toBe(false);
    // A driver that names no snapshot and reports nothing wrong (another platform or release) is left as it is.
    expect(unaddressableObservation(noId)).toBe(false);
    expect(noElementTokensNotice).not.toMatch(/get_window_state|get_desktop_state|type_text/);
  });

  it('turns a bare row of the latest observe into the token the driver accepts, and leaves a full token alone', () => {
    const accepted = /^s[0-9a-f]{8}:[0-9]+$/; // the pattern of cua-driver's own element_token argument
    expect(driverElementToken('77', 's0000002a')).toBe('s0000002a:77');
    expect(driverElementToken('[77]', 's0000002a')).toBe('s0000002a:77');
    expect(driverElementToken('77', 's0000002a')).toMatch(accepted);
    expect(driverElementToken('s00000029:77', 's0000002a')).toBe('s00000029:77');
    expect(driverElementToken('AXButton-opaque', 's0000002a')).toBe('AXButton-opaque');
    expect(driverElementToken('77', undefined)).toBe('77');
  });

  it('prints a token the click path accepts, adding the line when the driver text has only the header', () => {
    const printed = (withId as { content: Array<{ text: string }> }).content[0]!.text;
    expect(withTokenLine(printed, 's0000002a')).toBe(printed);
    const added = withTokenLine('window_id=1 pid=2 elements=3 walk_ms=4 snapshot_id=s0000002a\n\n- [0] frame "x"', 's0000002a').split('\n');
    expect(added[1]).toBe('element_token for row [N] = s0000002a:N (row [1] is "s0000002a:1")');
    const example = /row \[1\] is "([^"]+)"/.exec(added[1]!)![1]!;
    expect(driverElementToken(example, undefined)).toMatch(/^s[0-9a-f]{8}:[0-9]+$/);
    expect(withTokenLine('window_id=1 pid=2 elements=3 walk_ms=4', undefined)).toBe('window_id=1 pid=2 elements=3 walk_ms=4');
  });
});

describe('cua\'s own tool names never reach the model', () => {
  const INTERNAL = /get_window_state|get_desktop_state|type_text|press_key|list_windows|list_apps|delivery_mode|max_elements/;

  it('rewrites the token refusals into this tool\'s actions', () => {
    const none = friendlyDriverError({ output: 'element_token "77" is a row number, and pid 2948997 has no current snapshot. Call get_window_state, then pass "<snapshot_id>:77".', isError: true }, 'linux');
    expect(none.output).toBe(noObservationNotice);
    expect(friendlyDriverError({ output: 'element_token "77" is a row number, not a token. Pass the full token, <snapshot_id>:77; or add window_id.', isError: true }, 'linux').output).toBe(noObservationNotice);
    const stale = friendlyDriverError({ output: 'element_token is stale; call get_window_state again to refresh; current snapshots for pid 2954614: s00000002 (window 193633583104)', isError: true }, 'linux');
    expect(stale.output).toBe(staleTokenNotice);
    const beyond = friendlyDriverError({ output: 'element_token s00000001:999 is out of range: snapshot s00000001 has rows [0] to [166] only (167 element(s)). Row numbers belong to one read: a read with a smaller max_elements, max_depth or another query can stop before row [999]. Use a row printed in s00000001, or re-read with a larger max_elements (or a query that matches the target) and use that read\'s rows.', isError: true }, 'linux');
    expect(beyond.output).toContain('Row 999 is not in the latest observation');
    expect(beyond.output).toContain('rows [0] to [166]');
    for (const reply of [none, stale, beyond]) { expect(reply.output).not.toMatch(INTERNAL); expect(reply.output).toContain('observe'); }
  });

  it('puts every other mention in this tool\'s words', () => {
    const said = [
      '→ get_window_state(pid, window_id) lists clickable elements; click/type_text take the same pid (+ window_id for x,y).',
      'Menu opened (popup: window_id=9, bounds x=1 y=2); call get_window_state(pid=4, window_id=9) to index its items and click them by element_token.',
      'Typed 3 character(s); the write may not have committed. Confirm with get_window_state or a screenshot.',
      'Tree truncated at max_elements=1500 (12 more node(s) not shown). Pass a larger max_elements, or query/max_depth to reach the rest.',
      'Use press_key or type_text; list_windows and list_apps show targets; get_desktop_state for pixels; Retry with delivery_mode:"foreground".',
    ];
    for (const line of said) expect(inToolWords(line), line).not.toMatch(INTERNAL);
    expect(inToolWords(said[0]!)).toBe('→ observe with pid, window_id lists clickable elements; click and type take the same pid (+ window_id for x,y).');
    expect(inToolWords(said[1]!)).toContain('observe with pid=4, window_id=9');
    expect(inToolWords(said[3]!)).toContain('Observe again with a query');
  });

  it('leaves what the screen says alone: tree rows and window titles', () => {
    const rows = '- [3] link "type_text docs"\n  - [4] text "get_window_state"\n  window_id=7 pid=9 "list_windows - Editor" 10x10+0+0 app=code';
    expect(inToolWords(rows)).toBe(rows);
  });
});
