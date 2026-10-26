/** One supervised Cua MCP connection for the lifetime of this ClikCode process.
 * The connection owns Cua's implicit session and closes with the process. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { McpClient, type McpCallResult } from '../mcp/client.js';
import { permissionsNotice } from './driver-results.js';
import { ensureDesktopDriverService } from './driver-macos-session.js';

let pending: Promise<McpClient> | undefined;
let connected: McpClient | undefined;
let fields: Map<string, ReadonlySet<string>> | undefined;

/** Where `clikcode computer driver install` puts cua-driver: its own versioned layout, so PATH is not needed. */
export function driverHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CUA_DRIVER_RS_HOME?.trim() || join(home, '.cua-driver');
}

/** The cua-driver to run: the one on PATH, else the active release of our own install, else the macOS app.
 * Undefined when there is none (the caller then runs the bare name and reports it missing). */
export function findDriverBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
  const exe = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (dir && exists(join(dir, exe))) return join(dir, exe);
  }
  const candidates = [join(driverHome(env), 'packages', 'current', exe)];
  if (platform === 'darwin') candidates.push('/Applications/CuaDriver.app/Contents/MacOS/cua-driver');
  return candidates.find((path) => exists(path));
}

const driverCommand = (): string => findDriverBinary() ?? 'cua-driver';

/** On macOS a permission belongs to the app that asked, so `--direct` (cua running inside ClikCode's own process) would
 * need the grant for the terminal or editor that started ClikCode and finds no windows with the grant made to CuaDriver.app.
 * Bare `mcp` proxies to CuaDriver.app, the identity `permissions grant` approves. Linux and Windows run it directly. */
export function driverMcpArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['mcp'] : ['mcp', '--direct'];
}

function start(): Promise<McpClient> {
  if (connected && !connected.closed) return Promise.resolve(connected);
  if (pending) return pending;
  const command = driverCommand();
  pending = ensureDesktopDriverService(command).then(() => McpClient.connect(
    { name: 'clikcode-computer', transport: 'stdio', command, args: driverMcpArgs(), env: driverEnv() },
    { timeoutMs: 15_000 },
  )).then((client) => {
    connected = client;
    fields = undefined;
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
  return `cua-driver ${version} cannot see native Wayland windows; ${WAYLAND_DRIVER_VERSION} or newer can. Update it with: clikcode computer driver update`;
}

let notice: Promise<string | undefined> | undefined;
export function driverNotice(): Promise<string | undefined> {
  notice ??= new Promise((resolve) => execFile(driverCommand(), ['--version'], { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : driverVersionNotice(stdout))));
  return notice;
}

let permissions: { at: number; notice: Promise<string | undefined> } | undefined;
/** On macOS, a line when Cua lacks the Accessibility or Screen Recording grant (read-only; never prompts). Rechecked each minute, so a grant made meanwhile is noticed. */
export function driverPermissionNotice(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  if (!permissions || Date.now() - permissions.at > 60_000) {
    permissions = { at: Date.now(), notice: new Promise((resolve) => execFile(driverCommand(), ['permissions', 'status', '--json'], { timeout: 10_000 }, (_error, stdout) => resolve(permissionsNotice(stdout)))) };
  }
  return permissions.notice;
}

/** The Cua driver is a separate install; say so plainly instead of leaking a spawn error. */
export const DRIVER_MISSING = 'Desktop control needs cua-driver, which is not installed on this computer. Install it with this one command: clikcode computer driver install (browser pages work without it through browser_use).';

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

/** Whether the installed cua-driver's schema for `tool` has `field`: older releases lack newer fields, and a
 * field they do not know is refused. Undefined when the schema cannot be read (treat the field as unsupported). */
export async function driverSupports(tool: string, field: string): Promise<boolean> {
  try {
    const client = await start();
    if (!fields) {
      const tools = await client.listTools(15_000);
      fields = new Map(tools.map((info) => {
        const properties = (info as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema?.properties;
        return [info.name, new Set(Object.keys(properties ?? {}))] as const;
      }));
    }
    return fields.get(tool)?.has(field) === true;
  } catch { return false; }
}
