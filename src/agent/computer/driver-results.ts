/** What comes back from Cua, made fit for the model: an app list a person could read, errors that say what
 * to do, and a clipboard that never carries a credential. */
import type { McpCallResult } from '../mcp/client.js';
import { redactForLog } from '../../runtime/redact.js';
import { hideKeyLikeText } from './secret-finder.js';

type AppRecord = {
  name?: unknown; pid?: unknown; running?: unknown; bundle_id?: unknown; kind?: unknown;
  windows?: Array<{ window_id?: unknown; title?: unknown; width?: unknown; height?: unknown }>;
};

const RUNNING_LIMIT = 60;
const INSTALLED_LIMIT = 40;

const visibleWindows = (app: AppRecord) => (app.windows ?? []).filter((window) => Number(window.width) > 0 && Number(window.height) > 0);

/** The graphical apps from `list_apps`: running ones that own a window with an area, plus (only when a
 * query names them) the installed ones that are not running. A bare process list can hold hundreds of
 * kernel threads and helpers nobody can launch or see. Undefined when the answer has a shape we do not know. */
export function summarizeApps(result: McpCallResult, query?: string): string | undefined {
  const structured = result.structuredContent as { apps?: unknown } | undefined;
  if (!structured || !Array.isArray(structured.apps)) return undefined;
  const apps = (structured.apps as AppRecord[]).filter((app) => app && typeof app === 'object' && typeof app.name === 'string');
  const needle = query?.trim().toLowerCase();
  const matches = (app: AppRecord): boolean => !needle || [app.name, app.bundle_id, ...(app.windows ?? []).map((window) => window.title)].some((part) => typeof part === 'string' && part.toLowerCase().includes(needle));
  // One process can match several launcher entries (VS Code's .desktop and snap ids): list it once.
  const seen = new Set<unknown>();
  // macOS lists apps with no per-app window list at all: a running desktop app counts, and `windows` gives its window ids.
  const windowless = (app: AppRecord): boolean => app.windows === undefined && Boolean(app.kind);
  const running = apps.filter((app) => app.running === true && (visibleWindows(app).length > 0 || windowless(app)) && matches(app) && (app.pid === undefined || !seen.has(app.pid) && seen.add(app.pid)));
  const installed = apps.filter((app) => app.running !== true && Boolean(app.kind) && Boolean(needle) && matches(app));
  const hiddenInstalled = apps.filter((app) => app.running !== true && Boolean(app.kind)).length;
  const lines: string[] = [];
  for (const app of running.slice(0, RUNNING_LIMIT)) {
    const windows = windowless(app) ? 'use the windows action for its window ids' : visibleWindows(app).slice(0, 4).map((window) => `window ${String(window.window_id)} ${JSON.stringify(String(window.title ?? '').slice(0, 80))}`).join(', ');
    lines.push(`- ${String(app.name)} (pid ${String(app.pid)})${app.bundle_id ? ` [${String(app.bundle_id)}]` : ''}: ${windows}`);
  }
  if (running.length > RUNNING_LIMIT) lines.push(`... and ${running.length - RUNNING_LIMIT} more running apps; narrow with query.`);
  const installedLines = installed.slice(0, INSTALLED_LIMIT).map((app) => `- ${String(app.name)}${app.bundle_id ? ` [${String(app.bundle_id)}]` : ''} (installed, not running)`);
  const head = `${running.length} running app(s) with a window${needle ? ` matching "${query}"` : ''}.`;
  const tail = !needle && hiddenInstalled ? `${hiddenInstalled} installed apps are not listed; pass query to search them and launch one with launch_app.` : installedLines.length ? 'Installed apps (launch with launch_app, app = the name):' : '';
  return [head, ...lines, ...(installedLines.length ? [tail, ...installedLines] : tail ? [tail] : [])].join('\n');
}

const CLIPBOARD_CAP = 8000;
const CLIPBOARD_NOTE = 'Clipboard text was read on request; anything shaped like a password, key or token is hidden.';

/** The clipboard as the model may see it: key-shaped and credential-shaped text hidden, held secrets scrubbed, capped. */
export function scrubClipboard(output: string): string {
  const hidden = hideKeyLikeText(redactForLog(output)).text;
  const clipped = hidden.length > CLIPBOARD_CAP ? `${hidden.slice(0, CLIPBOARD_CAP)}\n... (clipboard text cut at ${CLIPBOARD_CAP} characters)` : hidden;
  return `${clipped}\n\n${CLIPBOARD_NOTE}`;
}

/** What `clipboard_read` returns: Cua's one-line summary, then the text (which it keeps in structuredContent), scrubbed. */
export function clipboardReply(result: McpCallResult, summary: string): string {
  const text = (result.structuredContent as { text?: unknown } | undefined)?.text;
  const body = typeof text === 'string' ? (text.length ? `Clipboard text:\n${text}` : 'The clipboard holds no text.') : 'The clipboard holds no text.';
  return scrubClipboard(`${summary}\n${body}`);
}

/** Cua's refusal to send keys or scrolling without bringing the window forward. */
const BACKGROUND_UNAVAILABLE = /Background delivery is not available|background_unavailable/i;
/** What Cua says when the foreground escalation is itself closed (GNOME 50 disabled its Shell helper). */
const FOREGROUND_UNAVAILABLE = /foreground[^.\n]*(not available|unavailable|refused|disabled)|(not available|unavailable|refused|disabled)[^.\n]*foreground|activation[^.\n]*(unavailable|not available)/i;

export const backgroundOnlyNotice = 'This desktop cannot send that key, hotkey, scroll or click to a window without bringing the window to the front. Either act on elements (observe, then click the button the key would press, or type into the field by its element_token), or retry the same action with delivery "foreground", which briefly takes focus from whatever the user is doing and puts it back; use that only when the user can spare the focus.';
export const foregroundUnavailableNotice = 'Foreground delivery is not available on this desktop (on GNOME 50 and newer Wayland, Cua cannot activate other windows). Act on elements instead: observe, then click the button the key would press, or type into the field by its element_token.';

type Reply = { output: string; isError?: boolean };
const brief = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 240);

export function backgroundOnly<T extends Reply>(result: T, askedForeground = false): T {
  if (!result.isError) return result;
  // The escalation itself is closed (bring_to_front, a menu that must activate, or delivery foreground).
  if (FOREGROUND_UNAVAILABLE.test(result.output) && !/Retry this action with delivery_mode/i.test(result.output)) return { ...result, output: `${foregroundUnavailableNotice}\n(Cua said: ${brief(result.output)})` };
  if (BACKGROUND_UNAVAILABLE.test(result.output)) return { ...result, output: askedForeground ? foregroundUnavailableNotice : backgroundOnlyNotice };
  return result;
}


export const macosAccessibilityNotice = 'cua-driver does not have the macOS Accessibility permission, so it can neither read nor control any window. Open System Settings > Privacy & Security > Accessibility and turn on CuaDriver (run `cua-driver permissions grant` to be prompted), then try again.';
export const macosScreenRecordingNotice = 'cua-driver does not have the macOS Screen Recording permission, so screenshots and pixel clicks are unavailable (the accessibility tree still works: use element_token actions). Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on CuaDriver (run `cua-driver permissions grant`), then try again.';
export const macosPermissionsPendingNotice = 'cua-driver has not been given its macOS permissions yet (Accessibility and Screen Recording), so it sees no windows. Run `cua-driver permissions grant` and turn on CuaDriver in the System Settings pages it opens, then try again.';
export const windowsElevatedNotice = 'Windows refused the input: the target window most likely runs as administrator (elevated), and a program that is not elevated, as ClikCode is, cannot drive it. Ask the user to close it and open it again without "Run as administrator", or to start ClikCode elevated.';
export const windowsSessionNotice = 'cua-driver is running in Windows session 0 (a service or SSH session) where there is no desktop to read. Start it from the user\'s signed-in desktop session (`schtasks /Run /TN cua-driver-serve`), then try again.';

/** An error Cua gave in its own words, replaced by what to do about it. The first lines of Cua's text stay, because
 * these patterns come from its documentation and a wrong guess must not hide the real cause. */
export function friendlyDriverError<T extends Reply>(result: T, platform: NodeJS.Platform = process.platform): T {
  if (!result.isError) return result;
  const said = result.output;
  const withCause = (notice: string): T => ({ ...result, output: `${notice}\n(Cua said: ${brief(said)})` });
  if (platform === 'darwin') {
    if (/Accessibility permission (is )?not granted|accessibility[^.\n]*not (been )?(granted|trusted|enabled)/i.test(said)) return withCause(macosAccessibilityNotice);
    if (/Screen Recording permission (is )?not granted|screen recording[^.\n]*not (been )?(granted|enabled)/i.test(said)) return withCause(macosScreenRecordingNotice);
    if (/permissions_pending|permission[^.\n]*still pending/i.test(said)) return withCause(macosPermissionsPendingNotice);
  }
  if (platform === 'win32') {
    if (/session ?0|SessionId[: ]+0/i.test(said)) return withCause(windowsSessionNotice);
    if (/access is denied|UIPI|elevated|integrity level|0x80070005/i.test(said)) return withCause(windowsElevatedNotice);
  }
  return result;
}

/** The two macOS grants, from `cua-driver permissions status --json`; a line to show when one is missing. */
export function permissionsNotice(statusJson: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  let status: { accessibility?: unknown; screen_recording?: unknown; status?: unknown };
  try { status = JSON.parse(statusJson) as typeof status; } catch { return undefined; }
  // cua-driver 0.38 reports no grants at all, only "unknown", until `permissions grant` has been approved and verified once.
  if (status.status === 'unknown' && status.accessibility === undefined) return macosPermissionsPendingNotice;
  if (status.accessibility === false) return macosAccessibilityNotice;
  if (status.screen_recording === false) return macosScreenRecordingNotice;
  return undefined;
}
