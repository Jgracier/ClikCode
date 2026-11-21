/** computer_use against a stand-in for cua-driver that answers with what cua-driver 0.38 really printed on
 * Linux (GNOME Wayland, 2026-11-21): an observe must hand the model element references the next action accepts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tool-contract.js';

const TOKEN = /^s[0-9a-f]{8}:[0-9]+$/; // cua-driver's own pattern for its element_token argument
const INTERNAL = /get_window_state|get_desktop_state|type_text|press_key|list_windows|delivery_mode|max_elements/;
const TREE = '- [0] frame "Billing - Google Chrome" [actions=[doDefault,showContextMenu]]\n  - [77] page tab "Amazon Web Services" [actions=[doDefault,showContextMenu]]';

const driver = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /** A pid with several windows: cua reads the whole app and issues no snapshot. */
  manyWindows: false,
  serial: 0,
  current: new Map<number, string>(),
}));

vi.mock('../computer/settings.js', async (original) => ({ ...(await original<Record<string, unknown>>()), computerEnabled: async () => true }));
vi.mock('../computer/sensitive-fields.js', async (original) => ({ ...(await original<Record<string, unknown>>()), credentialOnScreen: async () => false }));
vi.mock('../computer/driver-macos-session.js', async (original) => ({ ...(await original<Record<string, unknown>>()), ensureDesktopDriverService: async () => undefined }));
vi.mock('../mcp/client.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  McpClient: { connect: async () => ({
    closed: false, killNow: () => undefined,
    listTools: async () => [{ name: 'get_window_state', inputSchema: { properties: { timeout_ms: {} } } }],
    callTool: async (name: string, args: Record<string, unknown>) => {
      driver.calls.push({ name, args });
      const pid = Number(args['pid']);
      const refuse = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
      if (name === 'get_desktop_state') return { content: [{ type: 'text', text: '✅ Desktop screenshot 2560x1440 (screen 2560x1440)\nVisible windows (use these pid + window_id values in every tool call):\n- pid=2948997 window_id=193265467392 "get_window_state notes - Google Chrome" 1439x899 at (40,40) app=Google Chrome\n→ get_window_state(pid, window_id) lists clickable elements; click/type_text take the same pid (+ window_id for x,y).' }] };
      if (name === 'get_window_state') {
        const head = `window_id=${String(args['window_id'])} pid=${pid} elements=187 walk_ms=439`;
        if (driver.manyWindows) {
          driver.current.delete(pid);
          return { content: [{ type: 'text', text: `${head}\n\n${TREE}` }], structuredContent: { pid, degraded: true, degraded_reason: 'accessibility_window_identity_unproven: tree is application-scoped; exact-window element tokens and bounds are unavailable' } };
        }
        const snapshot = `s${(++driver.serial).toString(16).padStart(8, '0')}`;
        driver.current.set(pid, snapshot);
        return { content: [{ type: 'text', text: `${head} snapshot_id=${snapshot}\nelement_token for row [N] = ${snapshot}:N (row [1] is "${snapshot}:1")\n\n${TREE}` }], structuredContent: { pid, snapshot_id: snapshot } };
      }
      const token = String(args['element_token'] ?? '');
      const now = driver.current.get(pid);
      if (!TOKEN.test(token)) return refuse(`element_token "${token}" is a row number, and pid ${pid} has no current snapshot. Call get_window_state, then pass "<snapshot_id>:${token}".`);
      if (token.split(':')[0] !== now) return refuse(`element_token is stale; call get_window_state again to refresh; current snapshots for pid ${pid}: ${now ?? 'none'}`);
      return { content: [{ type: 'text', text: `Clicked element [${token.split(':')[1]}] (pid ${pid}).` }] };
    },
  }) },
}));

const { computerDesktopTool } = await import('./computer.js');
const context = { stateDir: '/nonexistent', acceptsImages: false } as unknown as ToolContext;
const use = (args: Record<string, unknown>) => computerDesktopTool.run(args as never, context);
const window = { pid: 2948997, window_id: 193265467392 };

beforeEach(() => { driver.calls.length = 0; driver.manyWindows = false; });

describe('computer_use element tokens', () => {
  it('prints tokens in an observe that the click path accepts as they are', async () => {
    const seen = await use({ action: 'observe', ...window });
    expect(seen.isError).toBeFalsy();
    const example = /row \[1\] is "([^"]+)"/.exec(seen.output)?.[1];
    expect(example).toMatch(TOKEN);
    const token = example!.replace(/:1$/, ':77');
    const clicked = await use({ action: 'click', ...window, element_token: token });
    expect(clicked).toEqual({ output: 'Clicked element [77] (pid 2948997).' });
    expect(driver.calls.at(-1)).toEqual({ name: 'click', args: { ...window, scope: 'window', element_token: token } });
  });

  it('resolves a bare row number to the latest observe of that window', async () => {
    await use({ action: 'observe', ...window });
    const again = await use({ action: 'observe', ...window, query: 'Amazon' });
    const latest = /snapshot_id=(\S+)/.exec(again.output)![1]!;
    for (const [action, row] of [['click', '77'], ['double_click', '[77]'], ['right_click', '77'], ['type', '77']] as const) {
      const done = await use({ action, ...window, element_token: row, ...(action === 'type' ? { text: 'hi' } : {}) });
      expect(done.isError, `${action}: ${done.output}`).toBeFalsy();
      expect(driver.calls.at(-1)!.args['element_token']).toBe(`${latest}:77`);
    }
  });

  it('says to observe, in its own words, when the window was never observed or the token is old', async () => {
    const never = await use({ action: 'click', pid: 4242, window_id: 7, element_token: '77' });
    expect(never.isError).toBe(true);
    expect(never.output).toContain('action observe with this pid and window_id');
    const first = /snapshot_id=(\S+)/.exec((await use({ action: 'observe', ...window })).output)![1]!;
    await use({ action: 'observe', ...window });
    const old = await use({ action: 'click', ...window, element_token: `${first}:77` });
    expect(old.isError).toBe(true);
    expect(old.output).toContain('older observation');
    for (const reply of [never, old]) expect(reply.output).not.toMatch(INTERNAL);
  });

  it('says plainly when an observe issued no tokens, and does not send one to the driver', async () => {
    driver.manyWindows = true;
    const seen = await use({ action: 'observe', ...window });
    expect(seen.isError).toBeFalsy();
    expect(seen.output.startsWith('No element_token works in this window right now')).toBe(true);
    expect(seen.output).toContain('[77] page tab "Amazon Web Services"');
    expect(seen.output).not.toMatch(INTERNAL);
    driver.calls.length = 0;
    const refused = await use({ action: 'click', ...window, element_token: '77' });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain('observe with no pid');
    expect(refused.output).not.toMatch(INTERNAL);
    expect(driver.calls).toEqual([]);
    // Pixels in the window are still the driver's to answer, and a later observe with one window gives tokens again.
    await use({ action: 'click', ...window, x: 5, y: 9 });
    expect(driver.calls.at(-1)!.args).toEqual({ ...window, scope: 'window', x: 5, y: 9 });
    driver.manyWindows = false;
    await use({ action: 'observe', ...window });
    expect((await use({ action: 'click', ...window, element_token: '77' })).isError).toBeFalsy();
  });

  it('keeps cua\'s tool names out of a desktop observe, but not out of a window title', async () => {
    const seen = await use({ action: 'observe' });
    expect(seen.output).toContain('→ observe with pid, window_id lists clickable elements; click and type take the same pid');
    expect(seen.output).toContain('"get_window_state notes - Google Chrome"');
    expect(seen.output.split('\n').filter((line) => !line.startsWith('- ')).join('\n')).not.toMatch(INTERNAL);
  });
});
