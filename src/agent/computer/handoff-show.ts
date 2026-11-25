/** show: let the person at this computer watch a chat's tab. ClikCode's Chrome runs on a hidden display (browser.ts), so by default there is
 * no window to look at; this opens a live view of the tab in their own default browser, on their own desktop, served on 127.0.0.1 only.
 *
 * It is the handoff's live view (handoff-serve.ts) with a different contract: nothing waits on the user and the agent keeps working in the
 * tab, so there is no Done and no one-use link. One view per chat tab, at one address, for as long as the chat has a tab: asking again
 * returns the same address, a viewer follows the chat to the tab it moves to, and the view ends when it is cleared or the chat has had no
 * open tab for ten minutes (an idle chat's tab is closed by the tab sweep, so that is also the idle limit).
 *
 * When the browser itself is already on the desktop (`clikcode computer display visible`, macOS, Windows) there is nothing to serve: the
 * tab is brought to the front of that window. */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from 'playwright-core';
import { childEnvironment } from '../../runtime/electron-env.js';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { computerPage, ownedPages, tabIsInCloud } from './browser.js';
import { runningHostDisplay, type HostDisplay } from './browser-host.js';
import { desktopSession, remoteSession } from './browser-launch.js';
import { serveLiveView, type LiveServer } from './handoff-serve.js';
import { sharedState } from './shared-state.js';

/** The chat has had no open tab for this long: nobody is working there, the view ends. */
export const SHOW_NO_TAB_MS = 10 * 60_000;
const TEND_EVERY_MS = 2_000;

interface ShowView { server: LiveServer; timer: NodeJS.Timeout; noTabSince?: number }
const views = sharedState('show-views', () => new Map<string, ShowView>());

/** The most a show takes. It answers with the view's address or the reason there is none, never with a wait: a tab whose page is
 * busy, a browser being restarted or a desktop that does not answer leaves the agent (and the user waiting on it) with nothing. */
export const SHOW_LIMIT_MS = 6_000;

class ShowTimeout extends Error { constructor(readonly step: string) { super(step); } }

/** `work`, or a ShowTimeout naming `step` once the show's deadline passes. */
function by<T>(deadline: number, step: string, work: Promise<T>, now: () => number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ShowTimeout(step)), Math.max(0, deadline - now())); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const STEP_TEXT: Record<string, string> = {
  page: 'the browser did not hand over this chat\'s tab in time (it is busy, or being restarted)',
  display: 'the browser did not say where its window is in time',
  front: 'the tab did not come to the front in time (its page is busy)',
  serve: 'the live view could not be started in time',
  open: 'the desktop\'s browser opener did not answer in time',
};

/** How long an opener gets to say it failed. One that is still running after this is showing the page (a browser started in its place). */
const OPENER_SETTLE_MS = 2_500;

/** Ask the desktop to open an address in the person's default browser. True only when the desktop's opener started and did not report
 * a failure (no handler, no display): never true on hope. `session` is what desktopSession found to add to the environment. */
export async function openOnDesktop(url: string, session: Record<string, string>, options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; start?: typeof spawn; settleMs?: number } = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const [command, args] = platform === 'darwin' ? ['open', [url]] as const
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : ['xdg-open', [url]] as const;
  return new Promise<boolean>(resolve => {
    let child: ChildProcess;
    try { child = (options.start ?? spawn)(command, [...args], { stdio: 'ignore', detached: true, windowsHide: true, env: { ...childEnvironment(command, options.env ?? process.env), ...session } }); }
    catch (error) { quiet('agent/computer/handoff-show')(error); resolve(false); return; }
    const settle = setTimeout(() => resolve(true), options.settleMs ?? OPENER_SETTLE_MS);
    child.once('error', error => { clearTimeout(settle); quiet('agent/computer/handoff-show')(error); resolve(false); });
    child.once('exit', code => { clearTimeout(settle); resolve(code === 0); });
    child.unref();
  });
}

export interface ShowDeps {
  /** This chat's current tab; throws when it has none. */
  page(): Promise<Page>;
  /** The same, without touching it or waiting: undefined when the chat has no open tab. */
  current(): Page | undefined;
  inCloud(): boolean;
  hostDisplay(): Promise<HostDisplay | undefined>;
  session(): Record<string, string> | undefined;
  remote(): boolean;
  serve: typeof serveLiveView;
  open(url: string, session: Record<string, string>): Promise<boolean>;
  now(): number;
}

function realDeps(stateDir: string, tab: string | undefined): ShowDeps {
  return {
    page: () => computerPage(stateDir, tab),
    current: () => ownedPages(stateDir, tab).current,
    inCloud: () => tabIsInCloud(stateDir, tab),
    hostDisplay: () => runningHostDisplay(stateDir),
    session: () => desktopSession(),
    remote: () => remoteSession(),
    serve: serveLiveView,
    open: openOnDesktop,
    now: Date.now,
  };
}

const SETTING_HINT = 'To have the browser window itself on the desktop instead, the user can run `clikcode computer display visible` (it applies the next time the browser starts).';

async function endShow(key: string, why: string): Promise<boolean> {
  const view = views.get(key);
  if (!view) return false;
  views.delete(key);
  clearInterval(view.timer);
  lifecycle('browser.show.end', { why });
  await view.server.stop().catch(quiet('agent/computer/handoff-show'));
  return true;
}

/** One look at an open view: a viewer is moved to the tab the chat is in now, and a chat with no tab for long enough ends the view.
 * Exported for tests; the view's own timer calls it. */
export async function tendShow(key: string, deps: Pick<ShowDeps, 'current' | 'now'>): Promise<void> {
  const view = views.get(key);
  if (!view) return;
  const current = deps.current();
  if (!current || current.isClosed()) {
    view.noTabSince ??= deps.now();
    if (deps.now() - view.noTabSince >= SHOW_NO_TAB_MS) await endShow(key, 'no-tab');
    return;
  }
  delete view.noTabSince;
  const viewing = view.server.viewing();
  if (viewing && viewing !== current) view.server.reconnect();
}

/** The show action. Returns what to tell the agent; throws when the chat has no tab to show. */
export async function showTab(input: { stateDir: string; tab?: string; clear?: boolean; limitMs?: number }, overrides: Partial<ShowDeps> = {}): Promise<string> {
  const key = input.tab ? `${input.stateDir}#${input.tab}` : input.stateDir;
  const deps: ShowDeps = { ...realDeps(input.stateDir, input.tab), ...overrides };
  if (input.clear === true) return await endShow(key, 'cleared') ? 'The live view is closed. The tab is unchanged.' : 'No live view is open on this tab.';
  const deadline = Date.now() + (input.limitMs ?? SHOW_LIMIT_MS);
  try {
    return await showWithin(key, deps, (step, work) => by(deadline, step, work, Date.now));
  } catch (error) {
    if (!(error instanceof ShowTimeout)) throw error;
    lifecycle('browser.show.open', { opened: false, why: 'timeout', step: error.step });
    const view = views.get(key);
    const served = view ? ` The live view is being served at ${view.server.address} (this computer only): the user can open that address in their browser.` : '';
    return `NOT OPENED: ${STEP_TEXT[error.step] ?? error.step} (gave up after ${Math.round((input.limitMs ?? SHOW_LIMIT_MS) / 1000)} s).${served} Carry on with the task; call show again in a moment.`;
  }
}

async function showWithin(key: string, deps: ShowDeps, step: <T>(name: string, work: Promise<T>) => Promise<T>): Promise<string> {
  const page = await step('page', deps.page());
  const remote = deps.remote();
  // The browser's own window is in front of the person already: put this tab in front of it. (A cloud tab is in no local window.)
  if (!remote && !deps.inCloud() && await step('display', deps.hostDisplay()) === 'visible') {
    await endShow(key, 'browser-visible');
    await step('front', page.bringToFront());
    lifecycle('browser.show.open', { opened: false, why: 'browser-visible' });
    return 'ClikCode\'s browser window is on this computer\'s desktop, and this tab is now in front in it: the user can watch there. Keep working as usual. Nothing else was opened.';
  }
  let view = views.get(key);
  const reused = view !== undefined;
  if (!view) {
    const serving = deps.serve({ host: '127.0.0.1', watch: true, ownHostOnly: true, page: deps.page });
    // A server that comes up after the deadline is stopped, not left listening with nobody holding it.
    const server = await step('serve', serving).catch((error: unknown) => { void serving.then(late => late.stop()).catch(quiet('agent/computer/handoff-show')); throw error; });
    const timer = setInterval(() => { void tendShow(key, deps).catch(quiet('agent/computer/handoff-show')); }, TEND_EVERY_MS);
    // The view is a courtesy: it never keeps a finished process alive.
    timer.unref();
    view = { server, timer };
    views.set(key, view);
  }
  const address = view.server.address;
  const carryOn = 'It stays open while you work: keep acting on the tab as usual, and it follows this chat to another tab. The user can also click and type in it. show with clear: true closes it.';
  if (reused && view.server.viewing()) {
    lifecycle('browser.show.open', { reused, opened: false, why: 'already-viewing' });
    return `The user already has the live view of this tab open (${address}). ${carryOn}`;
  }
  const session = remote ? undefined : deps.session();
  if (!session) {
    lifecycle('browser.show.open', { reused, opened: false, why: remote ? 'remote' : 'no-desktop' });
    const why = remote ? 'This chat is being driven from a remote session (ssh or a remote terminal), so a window on this computer\'s desktop would not be in front of the user'
      : 'No desktop session was found from here (no DISPLAY or WAYLAND_DISPLAY: a server, a container)';
    return `NOT OPENED. ${why}. The live view is being served at ${address}, which answers only on this computer itself (127.0.0.1): give the user that address to open in a browser on this computer. For a user on another device, use handoff (a link on their Tailscale network). ${carryOn}`;
  }
  const opened = await step('open', deps.open(address, session));
  lifecycle('browser.show.open', { reused, opened });
  if (!opened) return `NOT OPENED. The desktop's browser opener could not be started or reported a failure. The live view is being served at ${address} (this computer only): give the user that address to open in their browser. ${carryOn}`;
  return `${reused ? 'Opened the live view again, at the same address' : 'Opened a live view of this tab in the user\'s default browser on their desktop'}: ${address}\nTell the user it is open (the address answers only on this computer). ${carryOn} ${SETTING_HINT}`;
}
