/** Detached owner of ClikCode's Chrome profile. Workers connect over local CDP. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { leaveDialogsToWorkers } from './page-dialogs.js';
import { hostStatusFile, launchComputerBrowser, shouldRunHeadless, VIRTUAL_DISPLAY_ENV, writeHostStatus } from './browser-launch.js';
import { headlessSetting, HOME_EGRESS } from './settings.js';
import { restoreTabs, startBrowserJanitor, takeRecycle } from './browser-janitor.js';
import { startHandoffDesk } from './handoff-desk.js';
import { findTailnetAddress } from './tailnet-handoff.js';
import { startEgressService } from './egress-host.js';
import { egressServer, egressTimeZone, tunnelManager } from './egress.js';
import { pidIsAlive } from '../../session/store/locks.js';
import { readFileSync } from 'node:fs';
import { scopeLeftovers } from './browser-host-scope.js';
import { writeTabRecord } from './tab-registry.js';
import { downloadsInbox } from './downloads.js';

export function computerProfile(stateDir: string): string { return path.join(stateDir, 'computer', 'chrome'); }
export function computerHostFile(stateDir: string): string { return path.join(stateDir, 'computer', 'host.json'); }

/** Whether `pid` is a running process. A zombie is not: a Chrome that crashed under a host that never reaped it still answers
 * kill(0), and counting it alive kept every worker waiting on a browser that was gone (2026-11-25, 9 hours). */
export async function processRunning(pid: number): Promise<boolean> {
  if (!pidIsAlive(pid)) return false;
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  // No /proc (macOS, Windows): kill(0) is all there is.
  return stat === undefined || stat.replace(/^.*\)\s+/, '')[0] !== 'Z';
}

/** The main Chrome process holding ClikCode's profile, from its SingletonLock (`<host>-<pid>`); undefined when there is no lock. */
export async function profileChromePid(stateDir: string): Promise<number | undefined> {
  const lock = await fs.readlink(path.join(computerProfile(stateDir), 'SingletonLock')).catch(() => undefined);
  const pid = Number(lock?.match(/-(\d+)$/)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Ends what Chrome left in the host's own unit (zygotes, renderers whose browser died): while any remain the unit stays, the next
 * host cannot start in it and runs without its limits. Only this unit's own pids, each by pid. */
function endScopeLeftovers(): void {
  let cgroup = '';
  try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { return; }
  const procs = (dir: string): string | undefined => { try { return readFileSync(path.join('/sys/fs/cgroup', dir, 'cgroup.procs'), 'utf8'); } catch { return undefined; } };
  for (const pid of scopeLeftovers(cgroup, procs, process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* fail-open-ok: already gone */ } }
}

/** How long the host's health probe waits for Chrome to answer CDP before calling it gone. */
const CDP_PROBE_MS = 15_000;

export { BROWSER_CHANNELS, launchFirst, VIRTUAL_DISPLAY_ENV } from './browser-launch.js';

/** Where the running browser's window is, as host.json says it: on the desktop, on the virtual display, or nowhere (headless). */
export type HostDisplay = 'visible' | 'hidden' | 'headless';
export function hostDisplay(options: { headless: boolean; virtualDisplay: boolean }): HostDisplay {
  return options.headless ? 'headless' : options.virtualDisplay ? 'hidden' : 'visible';
}
/** Where the browser that is running now shows itself; undefined when none is running (or an older host that did not say). */
export async function runningHostDisplay(stateDir: string, alive: (pid: number) => boolean = pidIsAlive): Promise<HostDisplay | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(computerHostFile(stateDir), 'utf8')) as { pid?: unknown; display?: unknown };
    if (typeof record.pid !== 'number' || !alive(record.pid)) return undefined;
    return record.display === 'visible' || record.display === 'hidden' || record.display === 'headless' ? record.display : undefined;
  } catch { return undefined; }
}

/** Keep one page of the host's own open (the blank page Chrome starts with, else a new one) and record it as the anchor, so closing
 * every worker's tab never leaves Chrome without a window. */
async function holdAnchorPage(stateDir: string, context: BrowserContext): Promise<void> {
  const page = context.pages().find(item => item.url() === 'about:blank') ?? await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    const id = ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    const now = Date.now();
    await writeTabRecord(stateDir, { id, tab: 'browser-host', ownerPid: process.pid, owner: `browser host ${process.pid}`, openedAt: now, lastUsedAt: now, url: 'about:blank', anchor: true });
  } finally { await session.detach().catch(quiet('agent/computer/browser-host')); }
}

/** Chrome's own arguments for the host. FedCm off: Google's sign-in button then uses its popup, not a browser-drawn dialog that no page tool
 * can see or press. This --disable-features also has to stay: Chrome keeps only the last one given, so it replaces Playwright's default
 * list, which turns MediaRouter (Cast) off, and a Chrome without Cast is what fingerprint.com names a "chromium_automation" bot (measured
 * 2026-11-24: Playwright's list alone flagged it, the same Chrome with this one passed). Playwright's default --enable-automation (left out by the caller) and Chrome's port-0 debugging each advertise WebDriver
 * to sites; the private CDP connection stays, the signal to page JavaScript goes. On a virtual display Chrome is told to use X11 (else it
 * finds the user's Wayland compositor) and to draw WebGL through EGL on the machine's GPU: on Xvfb it otherwise reports the software
 * "SwiftShader" renderer, the classic headless-server tell, where EGL reports the real card (measured 2026-11-20: "AMD Radeon 780M"). */
export function hostChromeArgs(options: { headless: boolean; virtualDisplay: boolean }): string[] {
  return ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-blink-features=AutomationControlled', '--disable-features=FedCm',
    ...(options.headless ? ['--window-size=1440,900'] : []),
    ...(options.virtualDisplay && !options.headless ? ['--ozone-platform=x11', '--use-gl=angle', '--use-angle=gl-egl'] : [])];
}

/** The user agent a headless Chrome should send instead of its own: the same string without "Headless" (Chrome 149 headless sends
 * "HeadlessChrome/149..."), the one word that marks it a robot (measured 2026-11-24: BrowserScan "Robot", a Microsoft account signup
 * blocked). Undefined when the agent is already a plain one. The client hints brands are already "Google Chrome" in headless. */
export function plainUserAgent(userAgent: string): string | undefined {
  return /HeadlessChrome\//.test(userAgent) ? userAgent.replace(/HeadlessChrome\//g, 'Chrome/') : undefined;
}

/** Where the separate persistent profile `name` keeps its cookies and history: beside the shared one, never inside it. */
export function separateProfileDir(stateDir: string, name: string): string { return path.join(stateDir, 'computer', 'profiles', name); }

/** How a separate profile's Chrome reaches the internet when it leaves through an egress: the proxy, and the clock of the address it
 * leaves from. */
export interface ProfileNet { egress: string; server: string; timeZone?: string }

/** Chrome's own arguments and environment for a profile on an egress. Everything is set on the process (and WebRTC in the profile's
 * preferences, writeWebRtcPolicy), not patched into pages, since a patched page is itself a tell: the proxy for every request, and TZ
 * so the clock matches the exit address. */
export function profileNetLaunch(net: ProfileNet | undefined): { args: string[]; env?: Record<string, string> } {
  if (!net) return { args: [] };
  return {
    args: [`--proxy-server=${net.server}`],
    ...(net.timeZone ? { env: { TZ: net.timeZone } } : {}),
  };
}

/** WebRTC's own setting in the profile, written before its Chrome starts: on an egress it may send only what goes through the proxy,
 * so its STUN request cannot go straight out and report the home address. Chrome 149 ignores the --force-webrtc-ip-handling-policy
 * switch (measured 2026-11-24: the switch on the command line, "srflx:98.97.3.234" still reported); the preference is what Chrome's
 * privacy API and enterprise policy set. Home puts it back to Chrome's default. */
export async function writeWebRtcPolicy(dir: string, onEgress: boolean): Promise<void> {
  const file = path.join(dir, 'Default', 'Preferences');
  let prefs: { webrtc?: Record<string, unknown> } & Record<string, unknown> = {};
  try { prefs = JSON.parse(await fs.readFile(file, 'utf8')) as typeof prefs; } catch { prefs = {}; }
  const webrtc = { ...(prefs.webrtc ?? {}) };
  if (onEgress) webrtc.ip_handling_policy = 'disable_non_proxied_udp';
  else if (webrtc.ip_handling_policy === undefined) return;
  else delete webrtc.ip_handling_policy;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ ...prefs, webrtc }), { mode: 0o600 });
}

/** The egress a separate profile keeps (in its own folder): a profile is one identity, and one identity keeps one address. */
const profileEgressFile = (dir: string): string => path.join(dir, 'clikcode-egress.json');
async function storedProfileEgress(dir: string): Promise<string | undefined> {
  try {
    const name = (JSON.parse(await fs.readFile(profileEgressFile(dir), 'utf8')) as { egress?: unknown }).egress;
    return typeof name === 'string' && name && name !== HOME_EGRESS ? name : undefined;
  } catch { return undefined; }
}

export interface ProfileNetwork {
  /** The proxy server for an egress (undefined: this computer's own connection). */
  server(egress: string): Promise<string | undefined>;
  /** The time zone of the egress's exit address, asked only when a Chrome is about to start. */
  timeZone(egress: string, server: string): Promise<string | undefined>;
}

/** The host's separate profiles: one more persistent Chrome per name, started on the first ask and kept until the host stops (or its
 * window is closed). Workers reach each over its own local debugging port; nothing in it is shared with the main profile. A profile may
 * leave through an egress: named once it sticks (`home` clears it), and a different way out (or a tunnel started again on a new port)
 * starts that profile's Chrome again, since a running Chrome's proxy and clock are fixed. */
export function separateProfiles(stateDir: string, launch: (dir: string, net?: ProfileNet) => Promise<BrowserContext>, readPort: (dir: string) => Promise<number> = devToolsPort, network?: ProfileNetwork): { open(name: string, egress?: string): Promise<{ port: number; egress?: string }>; closeAll(): Promise<void> } {
  interface Held { context: BrowserContext; port: number; server?: string; egress?: string; closed: boolean }
  const open = new Map<string, Promise<Held>>();
  return {
    async open(name, egress) {
      const previous = open.get(name);
      // One ask at a time per profile: a second waits for the first and reuses what it started.
      const held: Promise<Held> = (async () => {
        const old = await previous?.catch(() => undefined);
        const dir = separateProfileDir(stateDir, name);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const wanted = egress === undefined ? await storedProfileEgress(dir) : egress === HOME_EGRESS ? undefined : egress;
        if (wanted && !network) throw new Error('This browser host cannot send a separate profile through an egress.');
        const server = wanted ? await network!.server(wanted) : undefined;
        if (egress !== undefined) await fs.writeFile(profileEgressFile(dir), JSON.stringify({ egress: server ? wanted : HOME_EGRESS }), { mode: 0o600 });
        if (old && !old.closed && old.server === server) return old;
        if (old && !old.closed) { old.closed = true; await old.context.close().catch(quiet('agent/computer/browser-host')); }
        const net = server && wanted ? { egress: wanted, server, timeZone: await network!.timeZone(wanted, server).catch(() => undefined) } : undefined;
        // A port file left by a Chrome that is gone would name a dead port.
        await fs.unlink(path.join(dir, 'DevToolsActivePort')).catch(quiet('agent/computer/browser-host'));
        await writeWebRtcPolicy(dir, Boolean(net));
        const context = await launch(dir, net);
        const entry: Held = { context, port: 0, ...(server ? { server, egress: wanted } : {}), closed: false };
        (context as unknown as { once(event: 'close', callback: () => void): void }).once('close', () => { entry.closed = true; });
        try { entry.port = await readPort(dir); return entry; } catch (error) { await context.close().catch(quiet('agent/computer/browser-host')); throw error; }
      })();
      open.set(name, held);
      held.catch(() => { if (open.get(name) === held) open.delete(name); });
      const { port, egress: through } = await held;
      return { port, ...(through ? { egress: through } : {}) };
    },
    async closeAll() {
      const all = [...open.values()];
      open.clear();
      await Promise.all(all.map(held => held.then(({ context }) => context.close(), () => undefined).catch(quiet('agent/computer/browser-host'))));
    },
  };
}

/** The local debugging port Chrome wrote into the profile once it listened (it takes a moment after launch). */
async function devToolsPort(dir: string): Promise<number> {
  const until = Date.now() + 15_000;
  for (;;) {
    const port = Number((await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
    if (Number.isInteger(port) && port > 0) return port;
    if (Date.now() > until) throw new Error('The separate profile\'s Chrome did not open its debugging port.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function runComputerHost(stateDir: string): Promise<void> {
  const profile = computerProfile(stateDir);
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser-host'));
  await writeHostStatus(stateDir, { pid: process.pid, state: 'starting' });
  const { chromium } = await import('playwright-core');
  const headless = shouldRunHeadless({ setting: await headlessSetting(stateDir) });
  const virtualDisplay = process.platform === 'linux' && process.env[VIRTUAL_DISPLAY_ENV] === '1';
  // The download folder the host names for the shared profile and for every context it makes later (egress): the same one each worker names.
  const inbox = downloadsInbox(stateDir);
  await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
  let context;
  let userAgentArgs: string[] = [];
  const launchAt = (dir: string, extra: string[] = [], env?: Record<string, string>) => launchComputerBrowser(chromium, dir, {
    headless, viewport: null, acceptDownloads: true, downloadsPath: inbox,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [...hostChromeArgs({ headless, virtualDisplay }), ...extra],
    ...(env ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
  }, stateDir);
  const launch = (extra: string[] = []) => launchAt(profile, extra);
  try {
    context = await launch();
    // Headless Chrome names itself in every request. Its version is only known once it runs, so it is asked once and started again
    // with the plain agent on the command line, which covers every tab any worker opens (a per-page override would miss theirs).
    if (headless) {
      const page = context.pages()[0] ?? await context.newPage();
      const plain = plainUserAgent(await page.evaluate(() => navigator.userAgent).catch(() => ''));
      if (plain) {
        await context.close();
        userAgentArgs = [`--user-agent=${plain}`];
        context = await launch(userAgentArgs);
      }
    }
  } catch (error) {
    // The worker that started this process cannot see its output: leave the reason where it will look.
    await writeHostStatus(stateDir, { pid: process.pid, state: 'failed', text: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  leaveDialogsToWorkers(context);
  const hostFile = computerHostFile(stateDir);
  // The egress contexts and their tunnels live here, for this Chrome's whole life (egress-host.ts); workers find the socket in host.json.
  // Separate profiles are started here too: this process has the display and outlives the worker that asks.
  const tunnels = tunnelManager(stateDir);
  const profiles = separateProfiles(stateDir, (dir, net) => { const { args, env } = profileNetLaunch(net); return launchAt(dir, [...userAgentArgs, ...args], env); }, undefined, {
    server: name => egressServer(stateDir, name, tunnels),
    timeZone: (name, server) => egressTimeZone(stateDir, name, server),
  });
  const egress = await startEgressService(stateDir, profile, tunnels, (name, through) => profiles.open(name, through)).catch(quiet('agent/computer/browser-host'));
  await writeHostStatus(stateDir, { pid: process.pid, state: 'running' });
  const record = JSON.stringify({ pid: process.pid, display: hostDisplay({ headless, virtualDisplay }), ...(egress ? { egressSocket: egress.socket } : {}) });
  try {
    await fs.writeFile(hostFile, record, { mode: 0o600 });
    // Closing a Chrome that is already gone never fires 'close', so a stop is bounded: the process ends either way.
    const stop = (): void => {
      void profiles.closeAll();
      void context.close().catch(quiet('agent/computer/browser-host'));
      setTimeout(() => { endScopeLeftovers(); process.exit(0); }, 10_000).unref();
    };
    // Chrome quits with its last window, and this process with it, taking every separate profile's tabs along: on 2026-11-27 a loop
    // command closing its last parked tab ended a 4 h host mid-checkout. The host holds one blank page of its own that no sweep closes.
    await holdAnchorPage(stateDir, context).catch(quiet('agent/computer/browser-host'));
    // Tabs a recycle saved come back, then the janitor closes tabs nobody holds and recycles an oversized browser.
    await restoreTabs(stateDir, await takeRecycle(stateDir), {
      async openPage(url, egressName) {
        // A tab that left through an egress comes back in that egress's context.
        if (egressName) {
          if (!egress) return undefined;
          return egress.contexts.openPage(egressName, url);
        }
        const page = await context.newPage();
        const session = await context.newCDPSession(page);
        try {
          await page.goto(url, { timeout: 15_000, waitUntil: 'domcontentloaded' }).catch(quiet('agent/computer/browser-host'));
          return ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId;
        } finally { await session.detach().catch(quiet('agent/computer/browser-host')); }
      },
    }).catch(quiet('agent/computer/browser-host'));
    const stopJanitor = startBrowserJanitor({
      stateDir, hostPid: process.pid, recycle: async () => { stop(); },
      // Still the host the workers use, and its Chrome still answers.
      current: async () => {
        const named = JSON.parse(await fs.readFile(hostFile, 'utf8').catch(() => '{}')) as { pid?: number };
        if (named.pid !== process.pid) return false;
        // Chrome's main process gone (or a zombie) is the plain signal: its 'close' event may never come while its leftover
        // children hold the pipe open, and workers wait on this host for as long as it looks alive.
        const chrome = await profileChromePid(stateDir);
        if (chrome !== undefined && !await processRunning(chrome)) return false;
        // A live page that no longer answers CDP says the same; the probe is bounded, since a dead pipe never answers at all.
        const page = context.pages()[0];
        if (!page) return chrome !== undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), CDP_PROBE_MS); timer.unref(); });
        const probe = context.newCDPSession(page).then(async session => { await session.detach().catch(quiet('agent/computer/browser-host')); return true; }, () => false);
        return Promise.race([probe, timedOut]).finally(() => clearTimeout(timer));
      },
      retire: () => stop(),
    });
    // The handoff desk lives here because this process outlives every worker: one address for every agent tab and what waits
    // on the user, on this computer always and on the tailnet (a phone) when there is one.
    const tailnet = await findTailnetAddress().catch(quiet('agent/computer/browser-host'));
    const desk = await startHandoffDesk({ stateDir, hosts: tailnet ? [tailnet, '127.0.0.1'] : ['127.0.0.1'], context }).catch(quiet('agent/computer/browser-host'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>(resolve => (context as unknown as { once(event: 'close', callback: () => void): void }).once('close', resolve));
    stopJanitor();
    await desk?.stop().catch(quiet('agent/computer/browser-host'));
    await egress?.stop().catch(quiet('agent/computer/browser-host'));
    await profiles.closeAll();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  } finally {
    try { if (await fs.readFile(hostFile, 'utf8') === record) await fs.unlink(hostFile); } catch { /* fail-open-ok: already gone */ }
    await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser-host'));
    await profiles.closeAll();
    await context.close().catch(quiet('agent/computer/browser-host'));
    endScopeLeftovers();
  }
}
