/** One persistent Chrome profile shared by ClikCode's terminal and editor workers. */
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { computerHostFile, computerProfile, VIRTUAL_DISPLAY_ENV } from './browser-host.js';
import { desktopSession, hostStatusFile, installingMessage, liveHostStatus, readHostStatus } from './browser-launch.js';
import { BROWSER_HOST_UNIT, browserHostLaunch } from './browser-host-scope.js';
import { sharedState } from './shared-state.js';
import { pidIsAlive, tryLease } from '../../session/store/locks.js';
import { serveDownloads, watchDownloads } from './downloads.js';
import { watchDialogs } from './page-dialogs.js';
import { watchConsole } from './console-log.js';
import { allTabs, closeTabsByLabel, closeTabsOfOwner, readTabRecords, sweepTabs, writeTabRecord, type TabRecord } from './tab-registry.js';
import { sleep } from '../../runtime/sleep.js';
import { browserDisplay, browserProvider, type BrowserDisplay } from './settings.js';
import { browserUseConnection, stopBrowserUse } from './browser-use-cloud.js';
import { contextEgress, egressOfPage, egressServer, pageEgress } from './egress.js';
import { EgressNotServed, requestHostedContext, requestSeparateProfile } from './egress-host.js';
import { addDeskItem, deskHeldTargets, deskItemAddress, readDeskInfo, type DeskItem, type DeskKind } from './handoff-desk-store.js';

type Connected = { browser: Browser; context: BrowserContext };
const running = sharedState('browser-running', () => new Map<string, Promise<Connected>>());

async function connect(stateDir: string): Promise<Connected | undefined> {
  const file = path.join(computerProfile(stateDir), 'DevToolsActivePort');
  let port: number;
  try { port = Number((await fs.readFile(file, 'utf8')).split('\n')[0]); }
  catch { return undefined; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8_000 });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); return undefined; }
    // Downloads from this connection's tabs are found where Chrome reports them (downloads.ts); without it they are reported as failed, never lost.
    await serveDownloads(browser, stateDir).catch(quiet('agent/computer/browser'));
    return { browser, context };
  } catch { return undefined; }
}

/** The parent of a process, from /proc; 0 when it cannot be read. */
export async function parentPid(pid: number): Promise<number> {
  try { return Number((await fs.readFile(`/proc/${pid}/stat`, 'utf8')).replace(/^.*\)\s+\S+\s+/, '').split(' ')[0]) || 0; } catch { return 0; }
}

/** Whether the live process holding the profile lock is the child of the running ClikCode host (recorded in host.json): that Chrome is ours, only slow to answer. */
export async function chromeIsHostChild(stateDir: string, chromePid: number): Promise<boolean> {
  try {
    const host = Number((JSON.parse(await fs.readFile(computerHostFile(stateDir), 'utf8')) as { pid?: unknown }).pid);
    if (!Number.isInteger(host) || host < 2 || !pidIsAlive(host)) return false;
    return (await parentPid(chromePid)) === host;
  } catch { return false; }
}

/** The message for a browser that is running and ours but did not answer in time: retry later, it is not blocked. */
const BROWSER_BUSY = 'ClikCode browser is busy and did not answer in time (the machine is stalled). Retry shortly; nothing is blocking it.';

async function ownChromeAlive(stateDir: string): Promise<boolean> {
  try {
    const lock = await fs.readlink(path.join(computerProfile(stateDir), 'SingletonLock'));
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!pidIsAlive(pid)) return false;
    return await chromeIsHostChild(stateDir, pid);
  } catch { return false; }
}

/** Whether Chrome holding ClikCode's own profile was left behind by a host that died: its parent is init or the user's systemd manager, so no window or command still owns it. A Chrome a person opened has a live parent (their shell or ClikCode) and is never this. */
export async function chromeIsOrphan(chromePid: number): Promise<boolean> {
  const parent = await parentPid(chromePid);
  if (parent === 1) return true;
  if (parent < 2) return false;
  try { return (await fs.readFile(`/proc/${parent}/comm`, 'utf8')).trim() === 'systemd'; } catch { return false; }
}

/** Ends an orphaned Chrome on ClikCode's profile and clears its lock, so a new host can start. True when the profile is free afterwards. */
async function reclaimOrphanChrome(stateDir: string): Promise<boolean> {
  const profile = computerProfile(stateDir);
  let pid = 0;
  try { pid = Number((await fs.readlink(path.join(profile, 'SingletonLock'))).match(/-(\d+)$/)?.[1]); } catch { return true; }
  if (!pid || !(await chromeIsOrphan(pid))) return false;
  lifecycle('browser.chrome.orphan_reclaimed', { pid });
  try { process.kill(pid, 'SIGTERM'); } catch { /* fail-open-ok: already gone */ }
  for (let wait = 0; wait < 20 && pidIsAlive(pid); wait++) await sleep(250);
  try { process.kill(pid, 'SIGKILL'); } catch { /* fail-open-ok: exited on SIGTERM */ }
  await Promise.all(['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map(name => fs.unlink(path.join(profile, name)).catch(quiet('agent/computer/browser'))));
  return true;
}

async function externalChromeRunning(stateDir: string): Promise<boolean> {
  try {
    const lock = await fs.readlink(path.join(computerProfile(stateDir), 'SingletonLock'));
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!pidIsAlive(pid)) return false;
    return !(await chromeIsHostChild(stateDir, pid));
  } catch { return false; }
}

async function startHost(stateDir: string): Promise<Connected> {
  const dir = path.join(stateDir, 'computer');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // One worker starts the host; the others wait below for it to answer. A lease (locks.ts), not a bare file: a starter that
  // dies mid-start loses it at once, and a live one keeps it however long Chromium takes to fetch.
  const lease = await tryLease(path.join(dir, 'host-start.lock'));
  if (lease) {
    try {
      const existing = await connect(stateDir);
      if (existing) return existing;
      // A host from an earlier call is still fetching Chromium: say how far it is instead of starting a second one.
      const working = await liveHostStatus(stateDir);
      if (working?.state === 'installing') throw new Error(installingMessage(working));
      // A busy machine can miss the 8 second connect: while Chrome is alive, ask a few more times before calling it foreign.
      for (let again = 0; again < 4 && await externalChromeRunning(stateDir); again++) {
        await sleep(1_500);
        const later = await connect(stateDir);
        if (later) return later;
      }
      // A host that died leaves its Chrome behind on our profile, reparented to init or systemd: that is ours, not a person's window, so end it and start fresh.
      if (await externalChromeRunning(stateDir) && !(await reclaimOrphanChrome(stateDir))) throw new Error('ClikCode Chrome is open outside ClikCode. Finish that browser step, close its window, and retry.');
      // Our own host's Chrome is alive but slow to answer (a stalled disk): wait for it, never start a second host over its profile.
      if (await ownChromeAlive(stateDir)) {
        for (let again = 0; again < 8; again++) {
          await sleep(5_000);
          const later = await connect(stateDir);
          if (later) return later;
        }
        throw new Error(BROWSER_BUSY);
      }
      const entry = process.env.CLIKCODE_BROWSER_HOST_ENTRY || process.argv[1];
      if (!entry) throw new Error('ClikCode could not start its browser host.');
      const hostArgs = [process.execPath, entry, 'computer-host', stateDir];
      const plain = hiddenDisplayCommand(hostArgs, process.env, process.platform, undefined, {
        display: await browserDisplay(stateDir),
        onFallback: () => lifecycle('browser.host.display', { wanted: 'visible', used: 'hidden', why: 'no desktop session' }),
      });
      // In a systemd unit of its own, with limits: it belongs to no worker, so it outlives this one and the next adopts it.
      const own = browserHostLaunch(plain, { platform: process.platform, env: process.env, cgroup: await fs.readFile('/proc/self/cgroup', 'utf8').catch(() => ''), uid: process.getuid?.() ?? 0, cwd: process.cwd(), busExists: existsSync });
      await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser'));
      const launch = (argv: readonly string[], env?: NodeJS.ProcessEnv): ChildProcess => {
        const [command, ...rest] = argv;
        const started = spawn(command!, rest, { detached: true, stdio: 'ignore', windowsHide: true, ...(env ? { env } : {}) });
        started.once('error', error => { startupError = error; });
        started.unref();
        return started;
      };
      let startupError: Error | undefined;
      let child = launch(own?.argv ?? plain, own?.env);
      let scoped = own !== undefined;
      lifecycle('browser.host.start', { scoped, unit: scoped ? BROWSER_HOST_UNIT : undefined });
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await connect(stateDir);
        if (result) return result;
        // The host says why it could not start (no browser installed and none could be fetched), or that it is fetching one.
        const status = await readHostStatus(stateDir);
        if (status?.state === 'installing') throw new Error(installingMessage(status));
        if (status?.state === 'failed' && status.text) throw new Error(status.text);
        // systemd-run could not make the unit (a name still in use, no user manager): start the host plainly, once.
        const exited = child.exitCode !== null && (child.exitCode !== 0 || !own?.detachesAtOnce);
        if (scoped && (startupError || exited) && !status) {
          lifecycle('browser.host.unscoped', { code: child.exitCode ?? undefined });
          scoped = false;
          startupError = undefined;
          child = launch(plain);
        } else if (startupError || (child.exitCode !== null && !(scoped && own?.detachesAtOnce && child.exitCode === 0))) break;
        await sleep(200);
      }
      const last = await readHostStatus(stateDir);
      if (last?.state === 'failed' && last.text) throw new Error(last.text);
      throw new Error('ClikCode could not start its browser. Check that Chrome or Edge is installed and the desktop is available.');
    } finally { await lease.release(); }
  }
  for (let attempt = 0; attempt < 110; attempt++) {
    const result = await connect(stateDir);
    if (result) return result;
    const status = await readHostStatus(stateDir);
    if (status?.state === 'installing') throw new Error(installingMessage(status));
    if (status?.state === 'failed' && status.text) throw new Error(status.text);
    await sleep(200);
  }
  throw new Error('ClikCode Chrome could not start.');
}

/** The managed cloud browser is a second, separate browser: its own connection, its own tabs, never the local profile. */
const cloudRunKey = (stateDir: string): string => `${stateDir}\u0000\u0000cloud`;

/** A separate persistent profile is another Chrome the host runs beside the shared one: its own connection and tabs too. */
const profileRunKey = (stateDir: string, name: string): string => `${stateDir}\u0000\u0000profile:${name}`;

/** Connect to the host's separate profile `name`, asking the host to start it (and starting the host) when needed. */
/** The debugging port each separate profile's connection reached: a profile started again on another egress has a new one. */
const profilePorts = sharedState('browser-profile-ports', () => new WeakMap<Browser, number>());

async function connectSeparateProfile(stateDir: string, name: string, start: boolean, egress?: string): Promise<Connected> {
  const host = await connect(stateDir);
  if (!host) {
    if (!start) throw new Error('ClikCode browser is closed. Open a URL with browser_use first.');
    await startHost(stateDir);
  } else await host.browser.close().catch(quiet('agent/computer/browser'));
  let port: number;
  try { port = await requestSeparateProfile(stateDir, name, undefined, undefined, egress); }
  catch (error) {
    // A host from before separate profiles reads the request as an egress with no name.
    if (error instanceof EgressNotServed || /^An egress name is/.test((error as Error).message)) throw new Error('The running ClikCode browser is older than separate profiles. They work once it restarts, which it does on its own when it is recycled or next started.');
    throw error;
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8_000 });
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new Error(`The separate profile "${name}" opened no window.`); }
  profilePorts.set(browser, port);
  await serveDownloads(browser, stateDir).catch(quiet('agent/computer/browser'));
  return { browser, context };
}

async function browserFor(stateDir: string, start: boolean, cloud = false, profile?: string, egress?: string): Promise<Connected> {
  const runKey = cloud ? cloudRunKey(stateDir) : profile ? profileRunKey(stateDir, profile) : stateDir;
  let opening = running.get(runKey);
  if (!opening) {
    opening = (async () => {
      if (profile && !cloud) return connectSeparateProfile(stateDir, profile, start, egress);
      if (cloud) {
        const remote = await browserUseConnection(stateDir, start);
        if (remote) return remote;
        throw new Error('The managed cloud browser is closed. Open a URL with browser_use first.');
      }
      const current = await connect(stateDir);
      if (current) return current;
      if (!start) throw new Error('ClikCode browser is closed. Open a URL with browser_use first.');
      return startHost(stateDir);
    })();
    running.set(runKey, opening);
    void opening.then(({ browser }) => {
      browser.on('disconnected', () => { if (running.get(runKey) === opening) running.delete(runKey); });
      if (cloud) watchCloudIdle(stateDir);
    }).catch(quiet('agent/computer/browser'));
    opening.catch(() => { if (running.get(runKey) === opening) running.delete(runKey); });
  }
  return opening;
}

/** This process is one chat's worker, so the tab it holds is that chat's own: another chat
 * in the same Chrome never has its page read, clicked or followed by this one. One process can also
 * serve several agents at once (an MCP server shared by sub-agents), which is why a call may name its
 * own `tab`: calls with different names never share, read or navigate each other's page. */
const owned = sharedState('browser-owned', () => new Map<string, Page[]>());
const ownerKey = (stateDir: string, tab?: string): string => (tab ? `${stateDir}\u0000${tab}` : stateDir);

// ── which of this process's tabs live in the managed cloud browser ──

/** Tabs moved to the cloud in `auto` mode (with `browser-use` selected every tab is there). */
const cloudOwners = sharedState('browser-cloud-owners', () => new Set<string>());
const cloudPages = sharedState('browser-cloud-pages', () => new WeakSet<Page>());
const cloudUsedAt = sharedState('browser-cloud-used', () => new Map<string, number>());
const cloudTimers = sharedState('browser-cloud-timers', () => new Map<string, ReturnType<typeof setInterval>>());

// ── which of this process's tabs live in a separate persistent profile (and which one) ──
const profileOwners = sharedState('browser-profile-owners', () => new Map<string, string>());
const profilePages = sharedState('browser-profile-pages', () => new WeakMap<Page, string>());

/** The separate profile this chat's tab lives in, if any. */
export function tabProfile(stateDir: string, tab?: string): string | undefined { return profileOwners.get(ownerKey(stateDir, tab)); }

/** How long the cloud browser may sit unused before its billed session is stopped. */
export function cloudIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.CLIKCODE_CLOUD_BROWSER_IDLE_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, 55) : 10) * 60_000;
}

async function onCloud(stateDir: string, tab?: string): Promise<boolean> {
  const provider = await browserProvider(stateDir);
  return provider === 'browser-use' || (provider === 'auto' && cloudOwners.has(ownerKey(stateDir, tab)));
}

/** True when this chat's tab is in the managed cloud browser. */
export function tabIsInCloud(stateDir: string, tab?: string): boolean {
  const page = mine(stateDir, tab);
  return Boolean(page && cloudPages.has(page));
}

/** A page of the cloud browser that holds something: a fresh session's blank tab does not count. */
const inUse = (page: Page): boolean => !page.isClosed() && !/^(?:about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?)?$/.test(page.url());

/** Stop the billed session once no tab in it is in use (this process's or another worker's). Returns true when it stopped. */
async function settleCloud(stateDir: string, force = false): Promise<boolean> {
  const runKey = cloudRunKey(stateDir);
  const opening = running.get(runKey);
  const connected = await opening?.catch(quiet('agent/computer/browser'));
  if (connected && !force && connected.context.pages().some(inUse)) return false;
  if (!connected && !force) return false;
  running.delete(runKey);
  const timer = cloudTimers.get(stateDir);
  if (timer) { clearInterval(timer); cloudTimers.delete(stateDir); }
  cloudUsedAt.delete(stateDir);
  await connected?.browser.close().catch(quiet('agent/computer/browser'));
  await stopBrowserUse(stateDir);
  return true;
}

/** The session is billed by the minute: close this process's cloud tabs and stop it once nothing has used it for a while. */
function watchCloudIdle(stateDir: string): void {
  cloudUsedAt.set(stateDir, Date.now());
  if (cloudTimers.has(stateDir)) return;
  const timer = setInterval(() => {
    if (Date.now() - (cloudUsedAt.get(stateDir) ?? 0) < cloudIdleMs()) return;
    void closeCloudTabs(stateDir).then(() => settleCloud(stateDir)).catch(quiet('agent/computer/browser'));
  }, 30_000);
  timer.unref();
  cloudTimers.set(stateDir, timer);
}

/** Close every cloud tab this process holds; their chats go back to the local browser. */
async function closeCloudTabs(stateDir: string): Promise<void> {
  const all = owned as Map<string, Page[]>;
  for (const key of [...all.keys()]) {
    if (key !== stateDir && !key.startsWith(`${stateDir}\u0000`)) continue;
    const pages = all.get(key) ?? [];
    const cloud = pages.filter(page => cloudPages.has(page));
    if (!cloud.length) continue;
    all.set(key, pages.filter(page => !cloudPages.has(page)));
    cloudOwners.delete(key);
    for (const page of cloud) await page.close().catch(quiet('agent/computer/browser'));
  }
}

/** An address only this computer or its private network can reach: never sent to a remote browser. */
export function privateAddress(address: string): boolean {
  let host: string;
  try { host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.ts.net') || !host.includes('.') && !host.includes(':')) return true;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}

/** Move this chat's tab to the managed cloud browser at the same address (a page the local browser cannot get past).
 * Local cookies and sign-ins are not copied. The local tab is closed only once the cloud one is open. */
export async function moveTabToCloud(stateDir: string, tab?: string): Promise<{ page: Page; moved: boolean }> {
  const provider = await browserProvider(stateDir);
  if (provider === 'local') throw new Error('The managed cloud browser is off. The user turns it on with `clikcode computer browser-use auto` (local first, cloud when asked) after saving its key as the secret `browser-use/api-key`.');
  const key = ownerKey(stateDir, tab);
  const current = mine(stateDir, tab);
  if (current && cloudPages.has(current)) return { page: current, moved: false };
  const address = current && /^https?:/i.test(current.url()) ? current.url() : undefined;
  if (address && privateAddress(address)) throw new Error('This page is on this computer or its private network, which a cloud browser cannot reach. It stays in the local browser.');
  const { context } = await browserFor(stateDir, true, true);
  // Always a page of its own: a blank page in the session may be another chat's tab that has not navigated yet.
  const page = await context.newPage();
  cloudPages.add(page);
  const local = owned.get(key) ?? [];
  owned.set(key, []);
  cloudOwners.add(key);
  adoptPage(stateDir, page, tab);
  for (const old of local) await old.close().catch(quiet('agent/computer/browser'));
  if (address) await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(quiet('agent/computer/browser'));
  lifecycle('browser.cloud.tab', { moved: 'to-cloud' });
  return { page, moved: true };
}

/** Bring this chat's tab back to the local browser at the same address, and stop the cloud session if nothing else uses it. */
export async function moveTabToLocal(stateDir: string, tab?: string): Promise<{ page: Page | undefined; moved: boolean; stopped: boolean }> {
  if (await browserProvider(stateDir) === 'browser-use') throw new Error('Browser Use Cloud is selected for every tab. The user switches back with `clikcode computer browser-use off` or `auto`.');
  const key = ownerKey(stateDir, tab);
  const pages = owned.get(key) ?? [];
  const cloud = pages.filter(page => cloudPages.has(page));
  if (!cloudOwners.has(key) && !cloud.length) return { page: mine(stateDir, tab), moved: false, stopped: false };
  const front = mine(stateDir, tab);
  const address = front && /^https?:/i.test(front.url()) ? front.url() : undefined;
  owned.set(key, pages.filter(page => !cloudPages.has(page)));
  chosen.delete(key);
  cloudOwners.delete(key);
  for (const page of cloud) await page.close().catch(quiet('agent/computer/browser'));
  const stopped = await settleCloud(stateDir).catch(() => false);
  const page = await openComputerPage(stateDir, tab);
  if (address) await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(quiet('agent/computer/browser'));
  lifecycle('browser.cloud.tab', { moved: 'to-local', stopped });
  return { page, moved: true, stopped };
}

/** Move this chat's tab into the separate persistent profile `name` at the same address: a Chrome profile of its own (cookies,
 * history, sign-ins), kept on disk across sessions, which never sees the shared profile's sign-ins. The old tab closes once the new
 * one is open. `egress` sends the whole profile through that way out from now on (`home`: back to this computer's own connection);
 * the host starts the profile's Chrome again when its way out changes, so its pages reopen. */
export async function moveTabToProfile(stateDir: string, name: string, tab?: string, egress?: string): Promise<{ page: Page; moved: boolean }> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error('A profile name is lower-case letters, digits and dashes (up to 32).');
  if (egress !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(egress)) throw new Error('An egress name is lower-case letters, digits and dashes (up to 32).');
  const key = ownerKey(stateDir, tab);
  if (cloudOwners.has(key) || await browserProvider(stateDir) === 'browser-use') throw new Error('This tab is in the managed cloud browser. Bring it back with cloud clear: true first.');
  const runKey = profileRunKey(stateDir, name);
  const held = egress !== undefined ? await running.get(runKey)?.catch(() => undefined) : undefined;
  if (held) {
    // Tell the host first: on a new way out it starts the profile's Chrome again, and this connection is to the old one.
    const port = await requestSeparateProfile(stateDir, name, undefined, undefined, egress);
    if (port !== profilePorts.get(held.browser)) { running.delete(runKey); await held.browser.close().catch(quiet('agent/computer/browser')); }
  }
  const current = mine(stateDir, tab);
  if (current && !current.isClosed() && profilePages.get(current) === name) return { page: current, moved: false };
  const address = current && /^https?:/i.test(current.url()) ? current.url() : undefined;
  const connected = await browserFor(stateDir, true, false, name, egress);
  const page = await pageInHostedContext(connected);
  profilePages.set(page, name);
  const before = owned.get(key) ?? [];
  owned.set(key, []);
  chosen.delete(key);
  profileOwners.set(key, name);
  adoptPage(stateDir, page, tab);
  for (const old of before) await old.close().catch(quiet('agent/computer/browser'));
  if (address) await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(quiet('agent/computer/browser'));
  lifecycle('browser.profile.tab', { moved: 'to-profile' });
  return { page, moved: true };
}

/** Bring this chat's tab back from its separate profile to the shared one at the same address. The profile stays on disk. */
export async function moveTabFromProfile(stateDir: string, tab?: string): Promise<{ page: Page | undefined; moved: boolean; from?: string }> {
  const key = ownerKey(stateDir, tab);
  const from = profileOwners.get(key);
  const pages = owned.get(key) ?? [];
  const inProfile = pages.filter(page => profilePages.has(page));
  if (!from && !inProfile.length) return { page: mine(stateDir, tab), moved: false };
  const front = mine(stateDir, tab);
  const address = front && /^https?:/i.test(front.url()) ? front.url() : undefined;
  owned.set(key, pages.filter(page => !profilePages.has(page)));
  chosen.delete(key);
  profileOwners.delete(key);
  for (const page of inProfile) await page.close().catch(quiet('agent/computer/browser'));
  const page = await openComputerPage(stateDir, tab);
  if (address) await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(quiet('agent/computer/browser'));
  lifecycle('browser.profile.tab', { moved: 'to-shared' });
  return { page, moved: true, ...(from ? { from } : {}) };
}

/** Stop the cloud session now, whatever is open in it (the user turned the cloud browser off). */
export async function stopCloudBrowser(stateDir: string): Promise<void> {
  await closeCloudTabs(stateDir);
  cloudOwners.clear();
  await settleCloud(stateDir, true);
}

// ── which of this process's tabs leave through another egress (egress.ts) ──

/** Tab owners bound to a way out other than home, by egress name. Unbound owners use the shared profile's own context, as always. */
const egressOwners = sharedState('browser-egress-owners', () => new Map<string, string>());
/** Contexts this worker made itself, only when no browser host of this build serves egress (egress-host.ts): one per egress per
 * connection, closed with that connection. The host's own contexts are the rule: they outlive workers, so the loop and its agent share
 * one sign-in per egress. Neither carries the shared profile's cookies (a vendor signs in again with its saved password). */
const egressContexts = sharedState('browser-egress-contexts', () => new WeakMap<Browser, Map<string, Promise<{ context: BrowserContext; server: string }>>>());

/** Send this tab owner's pages through `egress` (undefined or `home`: this computer's own connection). Pages it already holds in another
 * way out are closed, so its next page opens in the right one. */
export async function bindTabEgress(stateDir: string, tab: string | undefined, egress: string | undefined): Promise<void> {
  const key = ownerKey(stateDir, tab);
  const wanted = egress && egress !== 'home' ? egress : undefined;
  if (egressOwners.get(key) === wanted) return;
  if (wanted) egressOwners.set(key, wanted); else egressOwners.delete(key);
  const stale = (owned.get(key) ?? []).filter(page => !cloudPages.has(page) && egressOfPage(page) !== wanted);
  if (!stale.length) return;
  owned.set(key, (owned.get(key) ?? []).filter(page => !stale.includes(page)));
  chosen.delete(key);
  for (const page of stale) await page.close().catch(quiet('agent/computer/browser'));
}

/** The egress this tab owner is bound to; undefined for home. */
export function tabEgress(stateDir: string, tab?: string): string | undefined { return egressOwners.get(ownerKey(stateDir, tab)); }

export { egressOfPage };

/** The worker's own context for `name` on this connection (no host serves egress): reused while its proxy is the egress's current one (an ssh tunnel that died and was
 * started again listens on a new port, and pages on the old one could reach nothing). */
async function egressContext(stateDir: string, connected: Connected, name: string): Promise<BrowserContext> {
  const server = await egressServer(stateDir, name);
  if (!server) return connected.context;
  let byName = egressContexts.get(connected.browser);
  if (!byName) { byName = new Map(); egressContexts.set(connected.browser, byName); }
  const current = byName.get(name);
  if (current) {
    const held = await current.catch(quiet('agent/computer/browser'));
    if (held && held.server === server) return held.context;
    // Another call replaced it while this one waited: use that one.
    if (byName.get(name) !== current) return egressContext(stateDir, connected, name);
    if (held) void held.context.close().catch(quiet('agent/computer/browser'));
  }
  const map = byName;
  const opening = connected.browser.newContext({ proxy: { server } }).then(context => {
    contextEgress.set(context, name);
    context.on('close', () => { if (map.get(name) === opening) map.delete(name); });
    lifecycle('browser.egress.context', { egress: name });
    return { context, server };
  });
  map.set(name, opening);
  opening.catch(() => { if (map.get(name) === opening) map.delete(name); });
  return (await opening).context;
}

/** Opens a page in a window of its own, in a context the browser host owns (the default one when none is given): Chrome makes the
 * target, and this connection's Playwright files the page under its default context, where it is picked up by its target id.
 * A window of its own keeps every chat's tab the one in front of its window: a tab behind another in a shared window has no
 * window around it (outerHeight equals innerHeight), which bot checks read as a virtual machine. */
export async function pageInHostedContext(connected: Connected, browserContextId?: string, ms = 15_000): Promise<Page> {
  const session = await connected.browser.newBrowserCDPSession();
  const fresh: Page[] = [];
  const onPage = (page: Page): void => { fresh.push(page); };
  connected.context.on('page', onPage);
  try {
    const before = new Set(connected.context.pages());
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true, ...(browserContextId ? { browserContextId } : {}) }) as { targetId: string };
    const ids = new Map<Page, Promise<string | undefined>>();
    for (const until = Date.now() + ms; Date.now() < until; await sleep(50)) {
      for (const page of new Set([...fresh, ...connected.context.pages().filter(page => !before.has(page))])) {
        if (!ids.has(page)) ids.set(page, targetIdOf(page));
        if (await ids.get(page) === targetId) return page;
      }
    }
    await session.send('Target.closeTarget', { targetId }).catch(quiet('agent/computer/browser'));
    throw new Error('The new tab did not open in time.');
  } finally {
    connected.context.off('page', onPage);
    await session.detach().catch(quiet('agent/computer/browser'));
  }
}

/** A new page for a tab: in the cloud browser, in its egress's context (the host's; this worker's own only when no host serves
 * egress), or in the shared profile. */
async function newTabPage(stateDir: string, connected: Connected, egress: string | undefined, cloud = false): Promise<Page> {
  if (cloud) return connected.context.newPage();
  if (!egress) return pageInHostedContext(connected);
  try {
    const hosted = await requestHostedContext(stateDir, egress);
    const page = await pageInHostedContext(connected, hosted.id);
    pageEgress.set(page, egress);
    return page;
  } catch (error) {
    if (!(error instanceof EgressNotServed)) throw error;
    lifecycle('browser.egress.unserved', { egress });
    return (await egressContext(stateDir, connected, egress)).newPage();
  }
}

/** The tab a chat chose with `switch`, until a new popup is followed or it closes. */
const chosen = sharedState('browser-chosen', () => new Map<string, Page>());

/** The tab in front for this chat: the one it switched to, else the newest still open. A popup that closed itself
 * (a sign-in window) hands back to the page that opened it. */
function mine(stateDir: string, tab?: string): Page | undefined {
  const key = ownerKey(stateDir, tab);
  const stack = (owned.get(key) ?? []).filter(page => !page.isClosed());
  owned.set(key, stack);
  const picked = chosen.get(key);
  if (picked && stack.includes(picked)) return picked;
  chosen.delete(key);
  return stack.at(-1);
}

/** Who holds each page, so a tab that page opens goes to the same chat whenever it opens. */
const holders = sharedState('browser-holders', () => new WeakMap<Page, { stateDir: string; tab?: string }>());
/** Tabs a chat's own pages opened that the chat has not been told about yet. */
const arrived = sharedState('browser-arrived', () => new Map<string, Page[]>());

/** A tab one of this chat's pages opened is this chat's from the moment it opens: a window that opens a moment after the click that
 * asked for it (the button fetches first) used to belong to no one, so no chat could read it, switch to it or close it. */
function followOpenedTabs(page: Page): void {
  page.on('popup', popup => {
    const holder = holders.get(page);
    if (!holder) return;
    const key = ownerKey(holder.stateDir, holder.tab);
    // A tab the chat has let go of (closed, parked) no longer speaks for it.
    if (!(owned.get(key) ?? []).includes(page)) return;
    adoptPage(holder.stateDir, popup, holder.tab);
    arrived.set(key, [...(arrived.get(key) ?? []), popup]);
  });
}

/** The tabs this chat's pages opened since it last asked, still open, oldest first. `take` (the default) marks them as told. */
export function arrivedPages(stateDir: string, tab?: string, take = true): Page[] {
  const key = ownerKey(stateDir, tab);
  const pages = (arrived.get(key) ?? []).filter(page => !page.isClosed());
  if (take) arrived.delete(key);
  return pages;
}

/** Make `page` this chat's tab (a popup the chat's own page opened). */
export function adoptPage(stateDir: string, page: Page, tab?: string): void {
  if (!holders.has(page)) followOpenedTabs(page);
  holders.set(page, { stateDir, ...(tab ? { tab } : {}) });
  // A popup opened by a cloud tab lives in the cloud browser too.
  if (!cloudPages.has(page) && (owned.get(ownerKey(stateDir, tab)) ?? []).some(other => cloudPages.has(other) && other.context() === page.context())) cloudPages.add(page);
  // And one opened by a separate-profile tab lives in that profile.
  if (!profilePages.has(page)) {
    const opener = (owned.get(ownerKey(stateDir, tab)) ?? []).find(other => profilePages.has(other) && other.context() === page.context());
    if (opener) profilePages.set(page, profilePages.get(opener)!);
  }
  // A page an egress-bound tab adopts (its popup, its restored or parked tab) is in that egress's context: Chrome opens a popup where its
  // opener is, and only same-egress restored tabs are claimed.
  const bound = egressOwners.get(ownerKey(stateDir, tab));
  if (bound && !cloudPages.has(page) && !profilePages.has(page) && !egressOfPage(page)) pageEgress.set(page, bound);
  watchDownloads(page, stateDir);
  watchDialogs(page);
  const key = ownerKey(stateDir, tab);
  owned.set(key, [...(owned.get(key) ?? []).filter(old => old !== page), page]);
  chosen.delete(key);
  watchConsole(page);
  // The tab registry lists the local Chrome's tabs; a cloud tab is tracked by its session instead.
  // A separate profile's tabs are in another Chrome, which that registry does not list.
  if (cloudPages.has(page)) cloudUsedAt.set(stateDir, Date.now()); else if (!profilePages.has(page)) holdTab(stateDir, page, tab);
}

// ── who holds each tab: written down so any chat can list it and the sweep can close what no one holds (tab-registry.ts) ──

interface Held { id: Promise<string | undefined>; tab?: string; openedAt: number; lastUsedAt: number; written: number; parked: boolean }
const held = sharedState('browser-held', () => new WeakMap<Page, Held>());
const WRITE_EVERY_MS = 5_000;
const SWEEP_EVERY_MS = 60_000;
const lastSweep = sharedState('browser-last-sweep', () => new Map<string, number>());

const ownerLabel = (): string => `worker ${process.pid}${process.env.CLIKCODE_SESSION_ID ? ` (session ${process.env.CLIKCODE_SESSION_ID.slice(0, 8)})` : ''}`;

/** The browser's own id for a page, or undefined when it cannot say. */
export function targetIdOf(page: Page): Promise<string | undefined> {
  return (async () => {
    const session = await page.context().newCDPSession(page);
    try { return ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId; }
    finally { await session.detach().catch(quiet('agent/computer/browser')); }
  })().catch(quiet('agent/computer/browser'));
}

async function flushHeld(stateDir: string, page: Page, entry: Held, force: boolean): Promise<void> {
  const now = Date.now();
  if (!force && now - entry.written < WRITE_EVERY_MS) return;
  entry.written = now;
  const id = await entry.id;
  if (!id) return;
  const record: TabRecord = {
    id, ...(entry.tab ? { tab: entry.tab } : {}), ownerPid: entry.parked ? 0 : process.pid, owner: entry.parked ? `parked by ${ownerLabel()}` : ownerLabel(),
    openedAt: entry.openedAt, lastUsedAt: entry.lastUsedAt, ...(page.isClosed() ? {} : { url: page.url() }), ...(entry.parked ? { parked: true } : {}), ...(egressOfPage(page) ? { egress: egressOfPage(page)! } : {}),
  };
  await writeTabRecord(stateDir, record);
}

function holdTab(stateDir: string, page: Page, tab?: string): void {
  const now = Date.now();
  const entry = held.get(page) ?? { id: targetIdOf(page), openedAt: now, lastUsedAt: now, written: 0, parked: false };
  entry.lastUsedAt = now;
  entry.parked = false;
  if (tab) entry.tab = tab; else delete entry.tab;
  held.set(page, entry);
  void flushHeld(stateDir, page, entry, true).catch(quiet('agent/computer/browser'));
}

/** This chat used `page` just now. Also closes tabs no one holds, at most once a minute. */
function touchTab(stateDir: string, page: Page): void {
  if (cloudPages.has(page)) { cloudUsedAt.set(stateDir, Date.now()); return; }
  if (profilePages.has(page)) return;
  const entry = held.get(page);
  if (entry) { entry.lastUsedAt = Date.now(); void flushHeld(stateDir, page, entry, false).catch(quiet('agent/computer/browser')); }
  const now = Date.now();
  if (now - (lastSweep.get(stateDir) ?? 0) < SWEEP_EVERY_MS) return;
  lastSweep.set(stateDir, now);
  void sweepTabs(stateDir).catch(quiet('agent/computer/browser'));
}

/** A tab the host reopened after a recycle for this label, taken over by the worker that names it. */
async function claimRestored(stateDir: string, context: BrowserContext, tab: string | undefined, egress?: string): Promise<Page | undefined> {
  if (!tab) return undefined;
  // A restored tab goes back to a worker on the same way out (the host restores an egress tab into that egress's context).
  const record = (await readTabRecords(stateDir)).find(item => item.restoreFor === tab && item.ownerPid === 0 && item.egress === egress);
  if (!record) return undefined;
  for (const page of context.pages()) {
    if (page.isClosed() || await targetIdOf(page) !== record.id) continue;
    adoptPage(stateDir, page, tab);
    return page;
  }
  return undefined;
}

/** Every tab this chat holds, in the order they were opened, and the one in front. Never another chat's tab. */
export function ownedPages(stateDir: string, tab?: string): { pages: Page[]; current: Page | undefined } {
  const current = mine(stateDir, tab);
  return { pages: [...(owned.get(ownerKey(stateDir, tab)) ?? [])], current };
}

/** Bring one of this chat's own tabs to the front: later actions act on it. */
export async function focusOwnedPage(stateDir: string, page: Page, tab?: string): Promise<void> {
  const key = ownerKey(stateDir, tab);
  if (!(owned.get(key) ?? []).includes(page) || page.isClosed()) throw new Error('That tab is not one of this chat\'s open tabs.');
  chosen.set(key, page);
  await page.bringToFront().catch(quiet('agent/computer/browser'));
}

/** Close one of this chat's own tabs; the rest stay. */
export async function closeOwnedPage(stateDir: string, page: Page, tab?: string): Promise<void> {
  const key = ownerKey(stateDir, tab);
  if (!(owned.get(key) ?? []).includes(page)) throw new Error('That tab is not one of this chat\'s open tabs.');
  owned.set(key, (owned.get(key) ?? []).filter(old => old !== page));
  await page.close().catch(quiet('agent/computer/browser'));
  if (cloudPages.has(page)) await settleCloud(stateDir).catch(quiet('agent/computer/browser'));
}

/** A second tab for this chat (a page to keep while another is read); it becomes the one in front. */
export async function openNewComputerPage(stateDir: string, tab?: string): Promise<Page> {
  const cloud = await onCloud(stateDir, tab);
  const profile = cloud ? undefined : profileOwners.get(ownerKey(stateDir, tab));
  const connected = await browserFor(stateDir, true, cloud, profile);
  const page = profile ? await pageInHostedContext(connected) : await newTabPage(stateDir, connected, cloud ? undefined : egressOwners.get(ownerKey(stateDir, tab)), cloud);
  if (cloud) cloudPages.add(page);
  if (profile) profilePages.set(page, profile);
  adoptPage(stateDir, page, tab);
  touchTab(stateDir, page);
  return page;
}

/** After abandoning a stuck page call: reload the tab. A tab that will not reload in time is replaced by a
 * fresh one at the same address (the old one is closed) and takes its place as this chat's tab. Returns the page to use. */
export async function recoverComputerPage(stateDir: string, page: Page, tab?: string): Promise<Page> {
  const address = page.url();
  const within = <T>(work: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('recover timed out')), ms); work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
  try {
    await within(page.reload({ timeout: 8_000, waitUntil: 'domcontentloaded' }), 10_000);
    return page;
  } catch {
    const fresh = await openNewComputerPage(stateDir, tab);
    if (/^https?:/i.test(address)) await within(fresh.goto(address, { timeout: 8_000, waitUntil: 'domcontentloaded' }), 10_000).catch(quiet('agent/computer/browser'));
    void page.close({ runBeforeUnload: false }).catch(quiet('agent/computer/browser'));
    return fresh;
  }
}

/** This chat's tab, opened in the shared Chrome the first time it is needed. */
export async function openComputerPage(stateDir: string, tab?: string): Promise<Page> {
  const cloud = await onCloud(stateDir, tab);
  const profile = cloud ? undefined : profileOwners.get(ownerKey(stateDir, tab));
  const connected = await browserFor(stateDir, true, cloud, profile);
  const egress = cloud || profile ? undefined : egressOwners.get(ownerKey(stateDir, tab));
  const existing = mine(stateDir, tab) ?? (cloud || profile ? undefined : await claimRestored(stateDir, connected.context, tab, egress));
  if (existing) { touchTab(stateDir, existing); return existing; }
  const page = profile ? await pageInHostedContext(connected) : await newTabPage(stateDir, connected, egress, cloud);
  if (cloud) cloudPages.add(page);
  if (profile) profilePages.set(page, profile);
  adoptPage(stateDir, page, tab);
  touchTab(stateDir, page);
  return page;
}

export async function computerPage(stateDir: string, tab?: string): Promise<Page> {
  const cloud = await onCloud(stateDir, tab);
  const profile = cloud ? undefined : profileOwners.get(ownerKey(stateDir, tab));
  const { context } = await browserFor(stateDir, false, cloud, profile);
  const page = mine(stateDir, tab) ?? (cloud || profile ? undefined : await claimRestored(stateDir, context, tab, egressOwners.get(ownerKey(stateDir, tab))));
  if (page) touchTab(stateDir, page);
  if (!page) throw new Error('This chat has no open tab. Open a URL with browser_use first.');
  return page;
}

/** For a command run outside any chat (`clikcode computer inspect`): the tab in front. */
export async function frontComputerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir, false, await browserProvider(stateDir) === 'browser-use');
  const open = context.pages().filter(page => !page.isClosed());
  for (const page of open.reverse()) {
    try { if (await page.evaluate(() => (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState === 'visible')) return page; }
    catch { /* fail-open-ok: a browser-internal tab cannot be inspected */ }
  }
  const page = open[0];
  if (!page) throw new Error('ClikCode browser has no open tab.');
  return page;
}

/** The process ids of the shared Chrome (browser, renderers, GPU), so a desktop window can be told apart from it.
 * Undefined when Chrome cannot say. */
export async function computerBrowserPids(stateDir: string): Promise<number[] | undefined> {
  try {
    const { browser } = await browserFor(stateDir, false);
    const session = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ id: number }> };
      return processInfo.map(info => info.id).filter(id => Number.isSafeInteger(id) && id > 0);
    } finally { await session.detach().catch(quiet('agent/computer/browser')); }
  } catch { return undefined; }
}

/** Every tab in the shared Chrome, whichever chat holds it (for the rule that keeps a sign-in out of view). */
export async function allComputerPages(stateDir: string): Promise<Page[]> {
  const { context } = await browserFor(stateDir, false, await browserProvider(stateDir) === 'browser-use');
  return context.pages().filter(page => !page.isClosed());
}

/** The pages the handoff desk is not holding for the user. A held tab is let go of (no longer this chat's) but stays open. */
async function notDeskHeld(stateDir: string, pages: readonly Page[]): Promise<Page[]> {
  const heldIds = await deskHeldTargets(stateDir).catch(() => new Set<string>());
  if (!heldIds.size) return [...pages];
  const free: Page[] = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    const id = await targetIdOf(page).catch(quiet('agent/computer/browser'));
    if (!id || !heldIds.has(id)) free.push(page);
  }
  return free;
}

/** Put this chat's tab on the handoff desk: it stays open, whoever ends, until the user taps Done there (or twelve hours pass).
 * Returns the item and its address, or undefined when the desk is not being served (no browser host of this build, no tailnet)
 * or the tab is in the cloud browser. */
export async function putTabOnDesk(stateDir: string, tab: string | undefined, input: { label: string; kind?: DeskKind; note?: string; resume?: string }): Promise<{ item: DeskItem; address: string } | undefined> {
  const info = await readDeskInfo(stateDir);
  const page = mine(stateDir, tab);
  if (!info || !page || page.isClosed() || cloudPages.has(page)) return undefined;
  const targetId = await targetIdOf(page).catch(quiet('agent/computer/browser'));
  if (!targetId) return undefined;
  const item = await addDeskItem(stateDir, { targetId, url: page.url(), ...input });
  return { item, address: deskItemAddress(info, item.id) };
}

/** Close this chat's tab only: the Chrome and every other chat's tab stay as they are. A named tab is closed whoever
 * holds it (another worker's, one left by a worker that ended): the name is how an agent says which. */
export async function closeComputerPage(stateDir: string, tab?: string): Promise<void> {
  const key = ownerKey(stateDir, tab);
  const pages = owned.get(key) ?? [];
  owned.delete(key);
  chosen.delete(key);
  for (const page of await notDeskHeld(stateDir, pages)) await page.close().catch(quiet('agent/computer/browser'));
  // A closed cloud tab hands its chat back to the local browser, and the billed session stops with its last tab.
  cloudOwners.delete(key);
  if (pages.some(page => cloudPages.has(page))) await settleCloud(stateDir).catch(quiet('agent/computer/browser'));
  if (tab) await closeTabsByLabel(stateDir, tab).catch(quiet('agent/computer/browser'));
}

/** Every tab this process holds, default and named (its worker is stopping). */
export async function closeAllOwnedPages(stateDir: string): Promise<void> {
  const all = owned as Map<string, Page[]>;
  for (const key of [...all.keys()]) {
    if (key !== stateDir && !key.startsWith(`${stateDir}\u0000`)) continue;
    const pages = all.get(key) ?? [];
    all.delete(key);
    chosen.delete(key);
    for (const page of await notDeskHeld(stateDir, pages)) await page.close().catch(quiet('agent/computer/browser'));
    cloudOwners.delete(key);
  }
  await settleCloud(stateDir).catch(quiet('agent/computer/browser'));
  await closeTabsOfOwner(stateDir, process.pid).catch(quiet('agent/computer/browser'));
}

/** Every tab in the shared Chrome with its owner, age and idle time (not only this chat's), for `browser_use tabs`. */
export { allTabs };

/** Keep a tab open for a later command (a keygrab that could not finish): mark it, and stop owning it so closing this process's connection or opening the next vendor leaves it alone. */
export async function parkComputerPage(stateDir: string, tab: string, marker: string): Promise<boolean> {
  const page = mine(stateDir, tab);
  if (!page) return false;
  const marked = await page.evaluate(name => { (globalThis as unknown as { name: string }).name = name; return true; }, marker).catch(() => false);
  owned.delete(ownerKey(stateDir, tab));
  const entry = held.get(page);
  if (entry) { entry.parked = true; entry.lastUsedAt = Date.now(); await flushHeld(stateDir, page, entry, true).catch(quiet('agent/computer/browser')); }
  return marked;
}

/** The parked tab with this marker, found among the shared Chrome's tabs and made this process's `tab`; undefined when Chrome or the tab is gone. */
export async function reattachParkedPage(stateDir: string, tab: string, marker: string): Promise<Page | undefined> {
  const connected = await browserFor(stateDir, false, await browserProvider(stateDir) === 'browser-use').catch(quiet('agent/computer/browser'));
  if (!connected) return undefined;
  // The shared profile's tabs first, then those of the egress contexts this connection made (a vendor parked while on another way out).
  const egressPages = [...(egressContexts.get(connected.browser)?.values() ?? [])];
  const others = (await Promise.all(egressPages.map(opening => opening.then(held => held.context.pages(), () => [] as Page[])))).flat();
  for (const page of [...connected.context.pages(), ...others]) {
    if (page.isClosed()) continue;
    const name = await page.evaluate(() => (globalThis as unknown as { name: string }).name).catch(quiet('agent/computer/browser'));
    if (name === marker) { adoptPage(stateDir, page, tab); return page; }
  }
  return undefined;
}

/** Close a parked tab (the keygrab finished, or a newer one replaced it). */
export async function closeParkedPage(stateDir: string, marker: string): Promise<void> {
  const page = await reattachParkedPage(stateDir, `parked-close-${marker}`, marker);
  if (page) await page.close().catch(quiet('agent/computer/browser'));
  owned.delete(ownerKey(stateDir, `parked-close-${marker}`));
}

/** Lets go of this process's connection to the shared Chrome (a command line that is finished with the browser can then exit); the browser keeps running. */
export async function releaseComputerBrowser(stateDir: string): Promise<void> {
  // A finished command must not leave a billed session behind: its cloud tabs close, and the session stops with its last tab.
  await closeCloudTabs(stateDir);
  await settleCloud(stateDir).catch(quiet('agent/computer/browser'));
  const cloud = running.get(cloudRunKey(stateDir));
  running.delete(cloudRunKey(stateDir));
  await (await cloud?.catch(quiet('agent/computer/browser')))?.browser.close().catch(quiet('agent/computer/browser'));
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  await (await opening?.catch(quiet('agent/computer/browser')))?.browser.close().catch(quiet('agent/computer/browser'));
}

export async function closeComputerBrowser(stateDir: string): Promise<void> {
  // A stop that fails keeps its record on disk, so `clikcode computer browser-use` still shows the session and `off` retries it.
  await stopCloudBrowser(stateDir).catch(quiet('agent/computer/browser'));
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  const connected = await opening?.catch(quiet('agent/computer/browser'));
  await connected?.browser.close().catch(quiet('agent/computer/browser'));
  try {
    const record = JSON.parse(await fs.readFile(computerHostFile(stateDir), 'utf8')) as { pid?: number };
    if (Number.isSafeInteger(record.pid) && record.pid! > 1) {
      process.kill(record.pid!, 'SIGTERM');
      // Return once it has really exited: a caller that removes the profile next would race its last writes.
      for (let waited = 0; waited < 5_000 && pidIsAlive(record.pid!); waited += 100) await sleep(100);
    }
  } catch { /* fail-open-ok: no ClikCode-owned browser */ }
}

/** A tab for one check, not owned by any chat: the caller closes it. Starts the shared Chrome when it is not running. */
export async function throwawayComputerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir, true, await browserProvider(stateDir) === 'browser-use');
  return context.newPage();
}

/** On Linux the browser runs on its own virtual display so its windows never take focus from the user's screen; the live views (show,
 * handoff) and screenshots go over CDP and are unaffected. `display: 'visible'` (the account setting, `clikcode computer display visible`)
 * or CLIKCODE_BROWSER_VISIBLE=1 starts it on the desktop the user is sitting at instead; with no desktop to be found it stays hidden and
 * `onFallback` is told.
 * Chrome on Linux picks Wayland whenever it can reach a compositor -- through WAYLAND_DISPLAY, or the default `wayland-0` socket when that
 * is unset -- so xvfb-run alone left its window on the user's GNOME desktop (seen 2026-11-20: the host's Chrome connected to wayland-0
 * with DISPLAY=:99 set). WAYLAND_DISPLAY is removed and the host is told it is on a virtual display (it then asks Chrome for X11). */
export function hiddenDisplayCommand(command: string[], env = process.env, platform = process.platform, hasXvfb = () => whichSync('xvfb-run'), options: { display?: BrowserDisplay; socketExists?: (file: string) => boolean; onFallback?: () => void } = {}): string[] {
  // Headless needs no display, virtual or real.
  if (platform !== 'linux' || /^(?:1|true|yes|on)$/i.test(env.CLIKCODE_BROWSER_HEADLESS ?? '')) return command;
  if (env.CLIKCODE_BROWSER_VISIBLE === '1' || options.display === 'visible') {
    const session = desktopSession({ env, platform, ...(options.socketExists ? { socketExists: options.socketExists } : {}) });
    // A desktop found by its socket is named for the host, which otherwise sees no display and runs headless. A host started from inside
    // another host's virtual display must not be told it is on one.
    if (session) return Object.keys(session).length ? ['env', '-u', VIRTUAL_DISPLAY_ENV, ...Object.entries(session).map(([name, value]) => `${name}=${value}`), ...command] : command;
    options.onFallback?.();
  }
  if (!hasXvfb()) return command;
  return ['env', '-u', 'WAYLAND_DISPLAY', `${VIRTUAL_DISPLAY_ENV}=1`, 'xvfb-run', '-a', '-s', '-screen 0 1440x900x24', ...command];
}

function whichSync(name: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => { try { accessSync(path.join(dir, name), fsConstants.X_OK); return true; } catch { return false; } });
}
