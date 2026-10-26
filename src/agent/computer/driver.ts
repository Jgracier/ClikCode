/** One supervised Cua MCP connection for the lifetime of this ClikCode process.
 * The connection owns Cua's implicit session and closes with the process. */
import { execFile } from 'node:child_process';
import { McpClient, type McpCallResult } from '../mcp/client.js';

let pending: Promise<McpClient> | undefined;
let connected: McpClient | undefined;

function start(): Promise<McpClient> {
  if (connected && !connected.closed) return Promise.resolve(connected);
  if (pending) return pending;
  pending = McpClient.connect(
    { name: 'clikcode-computer', transport: 'stdio', command: 'cua-driver', args: ['mcp', '--direct'], env: driverEnv() },
    { timeoutMs: 15_000 },
  ).then((client) => {
    connected = client;
    process.once('exit', () => client.killNow());
    return client;
  }).finally(() => { pending = undefined; });
  return pending;
}

/** A Wayland session: Cua's native Wayland backend finds windows through the accessibility bus and acts
 * on their elements. Without it Cua looks only at X11, where native Wayland apps have no windows. */
export function waylandSession(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY));
}

export function driverEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return waylandSession(env, platform) ? { CUA_DRIVER_RS_ENABLE_WAYLAND: '1' } : {};
}

/** The first Cua release whose Wayland backend lists native windows on GNOME without its Shell helper. */
export const WAYLAND_DRIVER_VERSION = '0.38.0';

const newer = (version: string, floor: string): boolean => {
  const a = version.split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** One line when this desktop needs a newer cua-driver than the one installed; undefined otherwise. */
export function driverVersionNotice(versionOutput: string, wayland = waylandSession()): string | undefined {
  const version = versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!wayland || !version || newer(version, WAYLAND_DRIVER_VERSION)) return undefined;
  return `cua-driver ${version} cannot see native Wayland windows; ${WAYLAND_DRIVER_VERSION} or newer can. Update it with: cua-driver update --apply`;
}

let notice: Promise<string | undefined> | undefined;
export function driverNotice(): Promise<string | undefined> {
  notice ??= new Promise((resolve) => execFile('cua-driver', ['--version'], { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : driverVersionNotice(stdout))));
  return notice;
}

/** The Cua driver is a separate install; say so plainly instead of leaking a spawn error. */
export const DRIVER_MISSING = 'Desktop control needs cua-driver installed on this computer (https://github.com/trycua/cua). Browser pages work without it through computer_web.';

export async function callComputerDriver(
  tool: string, args: Record<string, unknown>, signal?: AbortSignal,
): Promise<McpCallResult> {
  let client: McpClient;
  try { client = await start(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || /ENOENT|not found/i.test(error instanceof Error ? error.message : '')) throw new Error(DRIVER_MISSING);
    throw error;
  }
  return client.callTool(tool, args, { timeoutMs: 45_000, signal });
}
