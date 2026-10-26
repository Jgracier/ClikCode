/** What the model may ask of the desktop, and the one Cua tool call each request becomes.
 *
 * Pure: no connection, no process. Every field is validated here, so a model can name only an exact
 * window it listed, a narrow set of actions, and (explicitly, per call) a foreground delivery. */

export const DESKTOP_ACTIONS = [
  'windows', 'apps', 'observe', 'click', 'double_click', 'right_click', 'drag', 'type', 'key', 'hotkey', 'scroll', 'zoom',
  'launch_app', 'bring_to_front', 'invoke_menu', 'set_window_frame', 'screen_size', 'clipboard_read', 'clipboard_write',
] as const;
export type DesktopAction = typeof DESKTOP_ACTIONS[number];

export type DesktopArgs = {
  action: DesktopAction;
  pid?: number; window_id?: number; element_token?: string;
  x?: number; y?: number; to_x?: number; to_y?: number; width?: number; height?: number;
  text?: string; key?: string; keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; query?: string;
  app?: string; urls?: string[]; path?: string[];
  delivery?: 'background' | 'foreground';
};

export type DriverRequest = { name: string; args: Record<string, unknown> };

/** Actions that send input and so can ask to be delivered in the foreground. */
const INPUT_ACTIONS: ReadonlySet<string> = new Set(['click', 'double_click', 'right_click', 'drag', 'type', 'key', 'hotkey', 'scroll']);

/** How long Cua may walk a window's accessibility tree. Its default (1 second) cuts off big Electron apps. */
export const WINDOW_STATE_TIMEOUT_MS = 10_000;
export const WINDOW_STATE_MAX_ELEMENTS = 1500;

const simpleKeys = (keys: unknown): keys is string[] =>
  Array.isArray(keys) && keys.length >= 2 && keys.length <= 4 && keys.every((key) => typeof key === 'string' && /^[a-z0-9_-]{1,20}$/i.test(key));

const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;
const signed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100_000;

/** An app is named by its display name, bundle id or package id (never a path or a command line with flags). */
const APP_NAME = /^[\p{L}\p{N} ._+@!:-]{1,120}$/u;
const REVERSE_DNS = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function launchRequest(args: DesktopArgs, platform: NodeJS.Platform): DriverRequest {
  const launch: Record<string, unknown> = {};
  if (args.app !== undefined) {
    if (typeof args.app !== 'string' || !APP_NAME.test(args.app) || /^[-\s]|\s-/.test(args.app)) throw new Error('Launch needs an app name or id from apps, with no path and no flags.');
    // Each OS names an app its own way; the portable fallback is the name.
    if (platform === 'darwin' && REVERSE_DNS.test(args.app)) launch['bundle_id'] = args.app;
    else if (platform === 'win32' && args.app.includes('!')) launch['aumid'] = args.app;
    else launch['name'] = args.app;
  }
  if (args.urls !== undefined) {
    const urls = args.urls;
    const ok = Array.isArray(urls) && urls.length >= 1 && urls.length <= 5 && urls.every((url) => {
      try { return typeof url === 'string' && url.length <= 2000 && ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
    });
    if (!ok) throw new Error('Launch urls must be one to five http or https addresses.');
    launch['urls'] = urls;
  }
  if (!Object.keys(launch).length) throw new Error('Launch needs an app (a name or id from apps) or urls.');
  return { name: 'launch_app', args: launch };
}

/** Keep the target exact and the action vocabulary narrow. A model picks a window from `windows` or the
 * primary desktop and nothing else. A foreground delivery (which takes focus) is a per-call choice, never a default. */
export function computerDriverAction(args: DesktopArgs, platform: NodeJS.Platform = process.platform): DriverRequest {
  if (args.action === 'windows') return { name: 'list_windows', args: { on_screen_only: true } };
  if (args.action === 'apps') return { name: 'list_apps', args: {} };
  if (args.action === 'screen_size') return { name: 'get_screen_size', args: {} };
  if (args.action === 'clipboard_read') return { name: 'clipboard_read', args: { include_text: true } };
  if (args.action === 'clipboard_write') {
    if (typeof args.text !== 'string' || !args.text.length || args.text.length > 20_000) throw new Error('Clipboard write needs text of 1 to 20,000 characters.');
    return { name: 'clipboard_write', args: { text: args.text } };
  }
  if (args.action === 'launch_app') return launchRequest(args, platform);
  if (args.delivery !== undefined && args.delivery !== 'background' && args.delivery !== 'foreground') throw new Error('Delivery is background (the default) or foreground.');
  if (args.delivery === 'foreground' && !INPUT_ACTIONS.has(args.action)) throw new Error('Delivery foreground applies only to click, double_click, right_click, drag, type, key, hotkey and scroll.');
  const windowed = args.pid !== undefined || args.window_id !== undefined;
  if (windowed && (!Number.isSafeInteger(args.pid) || args.pid! < 1 || !Number.isSafeInteger(args.window_id) || args.window_id! < 0)) {
    throw new Error('Choose an exact window from the windows action, with both pid and window_id.');
  }
  const needWindow = (what: string): void => { if (!windowed) throw new Error(`${what} needs an exact window: give pid and window_id from the windows action.`); };
  const foreground = args.delivery === 'foreground' ? { delivery_mode: 'foreground' } : {};
  const base = windowed ? { pid: args.pid, window_id: args.window_id, scope: 'window' } : { target: { kind: 'desktop', display_id: 'primary' } };
  const point = coordinate(args.x) && coordinate(args.y) ? { x: args.x, y: args.y } : undefined;
  const at = windowed && args.element_token ? { element_token: args.element_token } : point;
  switch (args.action) {
    case 'observe':
      return windowed
        ? { name: 'get_window_state', args: { pid: args.pid, window_id: args.window_id, max_elements: WINDOW_STATE_MAX_ELEMENTS, timeout_ms: WINDOW_STATE_TIMEOUT_MS, ...(args.query ? { query: args.query } : {}) } }
        : { name: 'get_desktop_state', args: {} };
    case 'click':
      if (!at) throw new Error(windowed ? 'Click needs an element_token or x and y from a fresh observation.' : 'Click needs x and y from a fresh desktop observation.');
      return { name: 'click', args: { ...base, ...at, ...foreground } };
    case 'double_click':
    case 'right_click': {
      if (!at) throw new Error(windowed ? `${args.action === 'double_click' ? 'Double click' : 'Right click'} needs an element_token or x and y from a fresh observation.` : `${args.action === 'double_click' ? 'Double click' : 'Right click'} needs x and y from a fresh desktop observation.`);
      // Cua's own tools for a window; on the desktop (which they cannot target) the click tool carries the count or button.
      if (windowed) return { name: args.action, args: { pid: args.pid, window_id: args.window_id, ...at, ...foreground } };
      return { name: 'click', args: { ...base, ...at, ...(args.action === 'double_click' ? { count: 2 } : { button: 'right' }), ...foreground } };
    }
    case 'drag':
      if (!point || !coordinate(args.to_x) || !coordinate(args.to_y)) throw new Error('Drag needs x and y (where to press) and to_x and to_y (where to release), from a fresh observation.');
      return { name: 'drag', args: { ...base, from_x: args.x, from_y: args.y, to_x: args.to_x, to_y: args.to_y, ...foreground } };
    case 'zoom':
      needWindow('Zoom');
      if (!point || !coordinate(args.to_x) || !coordinate(args.to_y) || args.to_x <= args.x! || args.to_y <= args.y!) throw new Error('Zoom needs the region corners: x and y (top left) and to_x and to_y (bottom right), in pixels of the latest window observation.');
      return { name: 'zoom', args: { pid: args.pid, window_id: args.window_id, x1: args.x, y1: args.y, x2: args.to_x, y2: args.to_y } };
    case 'type':
      if (typeof args.text !== 'string' || args.text.length > 20_000) throw new Error('Type needs text of at most 20,000 characters.');
      if (windowed && !at) throw new Error('Type needs an element_token or x and y from a fresh observation.');
      return { name: 'type_text', args: { ...base, ...(at ?? {}), text: args.text, ...foreground } };
    case 'key':
      if (!args.key || !/^[A-Za-z0-9_-]{1,30}$/.test(args.key)) throw new Error('Key needs one simple key.');
      return { name: 'press_key', args: { ...base, key: args.key, ...foreground } };
    case 'hotkey':
      if (!simpleKeys(args.keys)) throw new Error('Hotkey needs two to four simple keys.');
      return { name: 'hotkey', args: { ...base, keys: args.keys, ...foreground } };
    case 'scroll':
      if (!args.direction || !['up', 'down', 'left', 'right'].includes(args.direction)) throw new Error('Scroll needs a direction.');
      return { name: 'scroll', args: { ...base, ...(point && !windowed ? point : {}), direction: args.direction, amount: Math.min(10, Math.max(1, Math.floor(args.amount ?? 1))), ...foreground } };
    case 'bring_to_front':
      needWindow('Bring to front');
      return { name: 'bring_to_front', args: { pid: args.pid, window_id: args.window_id } };
    case 'invoke_menu': {
      needWindow('Menu');
      const path = args.path;
      if (!Array.isArray(path) || path.length < 1 || path.length > 16 || !path.every((label) => typeof label === 'string' && label.trim().length > 0 && label.length <= 100)) {
        throw new Error('Menu needs a path of one to sixteen menu labels, such as ["File", "Save As..."].');
      }
      return { name: 'invoke_menu', args: { pid: args.pid, window_id: args.window_id, path } };
    }
    case 'set_window_frame':
      needWindow('Set window frame');
      if (!signed(args.x) || !signed(args.y) || !dimension(args.width) || !dimension(args.height)) throw new Error('Set window frame needs x, y (top left) and width, height, in the units of the windows listing.');
      return { name: 'set_window_frame', args: { pid: args.pid, window_id: args.window_id, x: args.x, y: args.y, width: args.width, height: args.height } };
    default: throw new Error('Unknown desktop action.');
  }
}
