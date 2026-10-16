/** Small, window-scoped computer tools. Cua validates exact targets and stale
 * element handles; these wrappers deliberately expose no desktop-wide input,
 * clipboard, process termination or existing-browser-profile attachment. */
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import { callComputerDriver } from '../computer/driver.js';
import { formatMcpResult } from '../mcp/tools.js';
import { computerEnabled } from '../computer/settings.js';

const target = {
  pid: { type: 'integer', minimum: 1, description: 'Process id from computer_windows.' },
  window_id: { type: 'integer', minimum: 0, description: 'Exact window id from computer_windows.' },
};

const call = async (name: string, args: Record<string, unknown>, acceptsImages: boolean, signal?: AbortSignal) =>
  formatMcpResult(await callComputerDriver(name, args, signal), acceptsImages);

export async function computerAllowed(stateDir: string): Promise<boolean> { return computerEnabled(stateDir); }

export const computerWindowsTool = defineTool({
  name: 'computer_windows', class: 'exec',
  description: 'List windows on the connected local desktop. Requires cua-driver installed on that desktop. Choose an exact pid and window_id before observing or acting.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Computer windows',
  run: async (_args, ctx) => (await computerAllowed(ctx.stateDir))
    ? call('list_windows', { on_screen_only: true }, false, ctx.signal)
    : { output: 'Computer use is off. Run `clikcode computer on` to enable it.', isError: true },
});

export const computerObserveTool = defineTool<{ pid: number; window_id: number; query?: string }>({
  name: 'computer_observe', class: 'exec',
  description: 'Observe one exact desktop window. Returns accessibility elements and a screenshot when the model can see images. Use its fresh element_token to act; tokens expire after another observation.',
  parameters: { type: 'object', additionalProperties: false, required: ['pid', 'window_id'], properties: {
    ...target, query: { type: 'string', description: 'Optional accessibility tree search.' },
  } },
  label: (args) => `Observe window ${args.window_id}`,
  run: async (args, ctx) => (await computerAllowed(ctx.stateDir))
    ? call('get_window_state', { pid: args.pid, window_id: args.window_id, max_elements: 1500, ...(args.query ? { query: args.query } : {}), include_screenshot: ctx.acceptsImages === true }, ctx.acceptsImages === true, ctx.signal)
    : { output: 'Computer use is off. Run `clikcode computer on` to enable it.', isError: true },
});

type ComputerAction = {
  pid: number; window_id: number; action: 'click' | 'type' | 'hotkey' | 'scroll';
  element_token?: string; x?: number; y?: number; text?: string; keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right'; amount?: number;
};

/** Keep the target exact and the action vocabulary narrow. In particular, a
 * model cannot request `scope: desktop` or `delivery_mode: foreground`. */
export function computerDriverAction(args: ComputerAction): { name: string; args: Record<string, unknown> } {
  if (!Number.isSafeInteger(args.pid) || args.pid < 1 || !Number.isSafeInteger(args.window_id) || args.window_id < 0) throw new Error('Choose an exact window from computer_windows.');
  const base = { pid: args.pid, window_id: args.window_id, scope: 'window' };
  const at = args.element_token ? { element_token: args.element_token } : Number.isFinite(args.x) && Number.isFinite(args.y) ? { x: args.x, y: args.y } : undefined;
  switch (args.action) {
    case 'click':
      if (!at) throw new Error('Click needs an element_token or x and y from a fresh observation.');
      return { name: 'click', args: { ...base, ...at } };
    case 'type':
      if (typeof args.text !== 'string' || args.text.length > 20_000) throw new Error('Type needs text of at most 20,000 characters.');
      if (!at) throw new Error('Type needs an element_token or x and y from a fresh observation.');
      return { name: 'type_text', args: { ...base, ...at, text: args.text } };
    case 'hotkey':
      if (!Array.isArray(args.keys) || args.keys.length < 2 || args.keys.length > 4 || args.keys.some((key) => !/^[a-z0-9_-]{1,20}$/i.test(key))) throw new Error('Hotkey needs two to four simple keys.');
      return { name: 'hotkey', args: { ...base, keys: args.keys } };
    case 'scroll':
      if (!args.direction || !['up', 'down', 'left', 'right'].includes(args.direction)) throw new Error('Scroll needs a direction.');
      return { name: 'scroll', args: { ...base, direction: args.direction, amount: Math.min(10, Math.max(1, Math.floor(args.amount ?? 1))) } };
    default: throw new Error('Unknown computer action.');
  }
}

export const computerActTool = defineTool<ComputerAction>({
  name: 'computer_act', class: 'exec',
  description: 'Click, type, press a hotkey, or scroll in one exact local desktop window. Observe first. This cannot control the full display, read clipboard, attach a personal browser profile, or elevate itself.',
  parameters: { type: 'object', additionalProperties: false, required: ['pid', 'window_id', 'action'], properties: {
    ...target, action: { type: 'string', enum: ['click', 'type', 'hotkey', 'scroll'] },
    element_token: { type: 'string', description: 'Preferred target from the latest computer_observe.' },
    x: { type: 'number', description: 'Window screenshot x coordinate when no accessible element exists.' },
    y: { type: 'number', description: 'Window screenshot y coordinate when no accessible element exists.' },
    text: { type: 'string', description: 'Text for type.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Keys for hotkey, for example ["ctrl", "l"].' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 10 },
  } },
  label: (args) => `${args.action} in window ${args.window_id}`,
  describe: async (args) => `Window ${args.window_id} of process ${args.pid}; ${args.action}${args.action === 'type' ? ` (${args.text?.length ?? 0} characters)` : ''}.`,
  async run(args, ctx) {
    if (!(await computerAllowed(ctx.stateDir))) return { output: 'Computer use is off. Run `clikcode computer on` to enable it.', isError: true };
    try { const request = computerDriverAction(args); return await call(request.name, request.args, false, ctx.signal); }
    catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});

export const computerTools: ToolDefinition[] = [computerWindowsTool, computerObserveTool, computerActTool];
