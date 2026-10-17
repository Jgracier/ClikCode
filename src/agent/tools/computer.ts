/** Desktop control through Cua. One tool: the primary desktop by default, or
 * one exact window (for example a browser popup or native dialog that the page
 * tools cannot reach) when a pid and window id are given. */
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import { callComputerDriver } from '../computer/driver.js';
import { formatMcpResult } from '../mcp/tools.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { credentialOnScreen } from '../computer/sensitive-fields.js';

const privateNotice = 'A password, code or card number is showing in the ClikCode browser, and a screenshot would show it. Submit or clear the form first.';

type DesktopArgs = {
  action: 'windows' | 'observe' | 'click' | 'type' | 'key' | 'hotkey' | 'scroll';
  pid?: number; window_id?: number; element_token?: string;
  x?: number; y?: number; text?: string; key?: string; keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; query?: string;
};

const simpleKeys = (keys: unknown): keys is string[] =>
  Array.isArray(keys) && keys.length >= 2 && keys.length <= 4 && keys.every((key) => typeof key === 'string' && /^[a-z0-9_-]{1,20}$/i.test(key));

/** Keep the target exact and the action vocabulary narrow. A model cannot ask
 * for another scope or a foreground delivery mode: it picks a window from
 * `windows` or the primary desktop, and nothing else. */
export function computerDriverAction(args: DesktopArgs): { name: string; args: Record<string, unknown> } {
  if (args.action === 'windows') return { name: 'list_windows', args: { on_screen_only: true } };
  const windowed = args.pid !== undefined || args.window_id !== undefined;
  if (windowed && (!Number.isSafeInteger(args.pid) || args.pid! < 1 || !Number.isSafeInteger(args.window_id) || args.window_id! < 0)) {
    throw new Error('Choose an exact window from the windows action, with both pid and window_id.');
  }
  const base = windowed ? { pid: args.pid, window_id: args.window_id, scope: 'window' } : { target: { kind: 'desktop', display_id: 'primary' } };
  const point = Number.isFinite(args.x) && Number.isFinite(args.y) && args.x! >= 0 && args.y! >= 0 ? { x: args.x, y: args.y } : undefined;
  const at = windowed && args.element_token ? { element_token: args.element_token } : point;
  switch (args.action) {
    case 'observe':
      return windowed
        ? { name: 'get_window_state', args: { pid: args.pid, window_id: args.window_id, max_elements: 1500, ...(args.query ? { query: args.query } : {}) } }
        : { name: 'get_desktop_state', args: {} };
    case 'click':
      if (!at) throw new Error(windowed ? 'Click needs an element_token or x and y from a fresh observation.' : 'Click needs x and y from a fresh desktop observation.');
      return { name: 'click', args: { ...base, ...at } };
    case 'type':
      if (typeof args.text !== 'string' || args.text.length > 20_000) throw new Error('Type needs text of at most 20,000 characters.');
      if (windowed && !at) throw new Error('Type needs an element_token or x and y from a fresh observation.');
      return { name: 'type_text', args: { ...base, ...(at ?? {}), text: args.text } };
    case 'key':
      if (!args.key || !/^[A-Za-z0-9_-]{1,30}$/.test(args.key)) throw new Error('Key needs one simple key.');
      return { name: 'press_key', args: { ...base, key: args.key } };
    case 'hotkey':
      if (!simpleKeys(args.keys)) throw new Error('Hotkey needs two to four simple keys.');
      return { name: 'hotkey', args: { ...base, keys: args.keys } };
    case 'scroll':
      if (!args.direction || !['up', 'down', 'left', 'right'].includes(args.direction)) throw new Error('Scroll needs a direction.');
      return { name: 'scroll', args: { ...base, ...(point && !windowed ? point : {}), direction: args.direction, amount: Math.min(10, Math.max(1, Math.floor(args.amount ?? 1))) } };
    default: throw new Error('Unknown desktop action.');
  }
}

export const computerDesktopTool = defineTool<DesktopArgs>({
  name: 'computer_desktop', class: 'exec',
  description: 'Control the local desktop through cua-driver. Use it for what page tools cannot reach: a browser popup window, a native permission or file dialog, or any other app. `windows` lists windows; `observe`, then click, type, key, hotkey or scroll. With no pid and window_id it acts on the primary desktop by screenshot coordinates; with both (from `windows`) it acts on that one window and prefers a fresh element_token. Always observe first; coordinates and tokens expire. `observe` is refused while a sign-in page is open in the ClikCode browser, so the screen cannot show what the page withholds. Never type credentials.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['windows', 'observe', 'click', 'type', 'key', 'hotkey', 'scroll'] },
    pid: { type: 'integer', minimum: 1, description: 'Process id from windows, to act on one window.' },
    window_id: { type: 'integer', minimum: 0, description: 'Exact window id from windows, with pid.' },
    element_token: { type: 'string', description: 'With a window: target from the latest observe.' },
    x: { type: 'number', description: 'Screenshot x coordinate (desktop or window).' },
    y: { type: 'number', description: 'Screenshot y coordinate (desktop or window).' },
    text: { type: 'string', description: 'Text to type. Never include credentials.' },
    key: { type: 'string', description: 'One key, such as Escape or Enter.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Hotkey such as ["ctrl", "l"].' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 10 },
    query: { type: 'string', description: 'With a window: accessibility tree search for observe.' },
  } },
  label: (args) => `Desktop ${args.action}${args.window_id !== undefined ? ` (window ${args.window_id})` : ''}`,
  describe: async (args) => `${args.window_id !== undefined ? `Window ${args.window_id} of process ${args.pid}` : 'Primary desktop'}: ${args.action}${args.action === 'type' ? ` (${args.text?.length ?? 0} characters)` : ''}.`,
  async run(args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: COMPUTER_OFF, isError: true };
    // Only the picture of the screen could show a typed credential: acting (an OAuth popup) is allowed, looking is not.
    if (args.action === 'observe' && await credentialOnScreen(ctx.stateDir)) return { output: privateNotice, isError: true };
    try {
      const request = computerDriverAction(args);
      const withImage = ctx.acceptsImages === true && args.action === 'observe';
      const driverArgs = request.name === 'get_window_state' ? { ...request.args, include_screenshot: withImage } : request.args;
      return formatMcpResult(await callComputerDriver(request.name, driverArgs, ctx.signal), withImage);
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});

export const computerTools: ToolDefinition[] = [computerDesktopTool];
