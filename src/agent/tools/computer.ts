/** Desktop control through Cua. One tool: the primary desktop by default, or
 * one exact window (for example a browser popup or native dialog that the page
 * tools cannot reach) when a pid and window id are given. */
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import { callComputerDriver, driverNotice, driverPermissionNotice, driverSupports } from '../computer/driver.js';
import { formatMcpResult } from '../mcp/tools.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { credentialOnScreen } from '../computer/sensitive-fields.js';
import { computerDriverAction, DESKTOP_ACTIONS, type DesktopArgs } from '../computer/driver-actions.js';
import { backgroundOnly, backgroundOnlyNotice, clipboardReply, friendlyDriverError, summarizeApps } from '../computer/driver-results.js';

export { computerDriverAction, backgroundOnly, backgroundOnlyNotice };

const privateNotice = 'A password, code or card number is showing in the ClikCode browser, and a screenshot would show it. Submit or clear the form first.';
const needsImages = 'Zoom returns a picture, and this model cannot see images. Use observe and act on element_token instead.';

const describeAction = (args: DesktopArgs): string => {
  const where = args.window_id !== undefined ? `Window ${args.window_id} of process ${args.pid}` : 'Primary desktop';
  switch (args.action) {
    case 'type': return `${where}: type (${args.text?.length ?? 0} characters).`;
    case 'clipboard_read': return 'Read the text on the clipboard (privacy sensitive; anything shaped like a password or key is hidden from the agent).';
    case 'clipboard_write': return `Replace the clipboard with ${args.text?.length ?? 0} characters of text.`;
    case 'launch_app': return `Launch ${args.app ?? (args.urls ?? []).join(', ')}.`;
    case 'invoke_menu': return `${where}: menu ${(args.path ?? []).join(' > ')}.`;
    case 'bring_to_front': return `${where}: bring to the front (takes focus).`;
    case 'windows': case 'apps': case 'screen_size': return `${args.action === 'windows' ? 'List windows' : args.action === 'apps' ? 'List apps' : 'Read the screen size'}.`;
    default: return `${where}: ${args.action}${args.delivery === 'foreground' ? ' (foreground: takes focus)' : ''}.`;
  }
};

export const computerDesktopTool = defineTool<DesktopArgs>({
  name: 'computer_use', class: 'exec',
  description: 'Control the local desktop (Linux, macOS, Windows) through cua-driver. Use it for what page tools cannot reach: a browser popup window, a native permission or file dialog, or any other app. `windows` lists windows and `apps` the graphical apps (with `query` it also searches installed ones); `launch_app` opens one by name (or opens urls). Then `observe` and act: click, double_click, right_click, drag (x, y to to_x, to_y), type, key, hotkey, scroll, or `invoke_menu` with a menu path, which is exact and needs no pixels. `zoom` crops a window region (x, y to to_x, to_y) for a closer look; `set_window_frame` moves and sizes a window; `screen_size` gives the display size. With no pid and window_id an action works on the primary desktop by screenshot coordinates; with both (from `windows`) it works on that one window and prefers a fresh element_token. Always observe first; coordinates and tokens expire. On Linux Wayland a window observe may come back without a screenshot: act on its element_token, which works without one. Actions run in the background by default and do not move the user\'s focus. If one is refused because the window must be in front (keys, hotkeys, scrolling and clicks sometimes are, notably on Wayland), you may retry that same action once with delivery "foreground", which briefly takes focus from the user and puts it back; do that only when the user can spare it, never by default. `bring_to_front` leaves a window in front, which also takes focus. `clipboard_read` returns the user\'s clipboard text, which is private: call it only when the user asked you to use what they copied; `clipboard_write` replaces it. Observing the desktop, zooming, or observing the ClikCode browser window is refused while a typed password, code or card number is in a tab on screen. Never type credentials.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: [...DESKTOP_ACTIONS] },
    pid: { type: 'integer', minimum: 1, description: 'Process id from windows, to act on one window.' },
    window_id: { type: 'integer', minimum: 0, description: 'Exact window id from windows, with pid.' },
    element_token: { type: 'string', description: 'With a window: target from the latest observe.' },
    x: { type: 'number', description: 'Screenshot x coordinate (desktop or window). For drag and zoom the start or top-left corner; for set_window_frame the left edge.' },
    y: { type: 'number', description: 'Screenshot y coordinate (desktop or window). For drag and zoom the start or top-left corner; for set_window_frame the top edge.' },
    to_x: { type: 'number', description: 'drag: where to release. zoom: the bottom-right corner.' },
    to_y: { type: 'number', description: 'drag: where to release. zoom: the bottom-right corner.' },
    width: { type: 'number', minimum: 1, description: 'set_window_frame: new width, in the units of windows.' },
    height: { type: 'number', minimum: 1, description: 'set_window_frame: new height, in the units of windows.' },
    text: { type: 'string', description: 'Text to type or to put on the clipboard. Never include credentials.' },
    key: { type: 'string', description: 'One key, such as Escape or Enter.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Hotkey such as ["ctrl", "l"].' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 10 },
    query: { type: 'string', description: 'With a window: accessibility tree search for observe. With apps: search installed and running apps by name.' },
    app: { type: 'string', description: 'launch_app: the app name from apps (macOS: a bundle id such as com.apple.Safari; Windows: a name or package id with "!"). No paths, no flags.' },
    urls: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'launch_app: http or https addresses to open (in the default browser when no app is given).' },
    path: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16, description: 'invoke_menu: menu labels from the top menu to the item, such as ["File", "Save As..."].' },
    delivery: { type: 'string', enum: ['background', 'foreground'], description: 'Click, double_click, right_click, drag, type, key, hotkey, scroll only. "background" (default) never moves focus. "foreground" briefly brings the window to the front, acts, and restores focus: it interrupts the user, so use it only after a background attempt was refused.' },
  } },
  label: (args) => `Desktop ${args.action}${args.window_id !== undefined ? ` (window ${args.window_id})` : ''}`,
  describe: async (args) => describeAction(args),
  async run(args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: COMPUTER_OFF, isError: true };
    const picture = args.action === 'observe' || args.action === 'zoom';
    // Only the picture of the screen could show a typed credential: acting (an OAuth popup) is allowed, looking is not.
    // One window that is not the ClikCode browser cannot show the browser's fields; the whole desktop can.
    if (picture && await credentialOnScreen(ctx.stateDir, args.pid)) return { output: privateNotice, isError: true };
    if (args.action === 'zoom' && ctx.acceptsImages !== true) return { output: needsImages, isError: true };
    try {
      const request = computerDriverAction(args);
      const withImage = ctx.acceptsImages === true && picture;
      const driverArgs: Record<string, unknown> = request.name === 'get_window_state' ? { ...request.args, include_screenshot: withImage } : { ...request.args };
      // Older cua-driver releases do not know the tree-walk budget; they keep their own default.
      if (request.name === 'get_window_state' && !(await driverSupports('get_window_state', 'timeout_ms'))) delete driverArgs['timeout_ms'];
      const raw = await callComputerDriver(request.name, driverArgs, ctx.signal);
      let result = formatMcpResult(raw, withImage);
      if (args.action === 'apps' && !raw.isError) result = { ...result, output: summarizeApps(raw, args.query) ?? result.output };
      if (args.action === 'clipboard_read' && !raw.isError) result = { ...result, output: clipboardReply(raw, result.output) };
      result = friendlyDriverError(backgroundOnly(result, args.delivery === 'foreground'));
      if (args.action !== 'windows') return result;
      const notices = (await Promise.all([driverNotice(), driverPermissionNotice()])).filter((notice): notice is string => Boolean(notice));
      return notices.length ? { ...result, output: `${notices.join('\n')}\n\n${result.output}` } : result;
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});

export const computerTools: ToolDefinition[] = [computerDesktopTool];
