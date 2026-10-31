/** One persistent Chrome profile shared by ClikCode's terminal and editor workers. */
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { computerHostFile, computerProfile } from './browser-host.js';
import { hostStatusFile, installingMessage, liveHostStatus, readHostStatus } from './browser-launch.js';
import { BROWSER_HOST_UNIT, browserHostLaunch } from './browser-host-scope.js';
import { sharedState } from './shared-state.js';
import { watchDownloads } from './downloads.js';
import { watchDialogs } from './page-dialogs.js';
import { watchConsole } from './console-log.js';
import { allTabs, closeTabsByLabel, closeTabsOfOwner, readTabRecords, sweepTabs, writeTabRecord, type TabRecord } from './tab-registry.js';

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
    return { browser, context };
  } catch { return undefined; }
}

async function externalChromeRunning(stateDir: string): Promise<boolean> {
  try {
    const lock = await fs.readlink(path.join(computerProfile(stateDir), 'SingletonLock'));
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function startHost(stateDir: string): Promise<Connected> {
  const dir = path.join(stateDir, 'computer');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'host-start.lock');
  let owned = false;
  try {
    const handle = await fs.open(lock, 'wx', 0o600);
    await handle.close();
    owned = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - (await fs.stat(lock)).mtimeMs > 30_000) {
        await fs.unlink(lock);
        return startHost(stateDir);
      }
    } catch { /* another worker already cleared the stale lock */ }
  }
  if (owned) {
    try {
      const existing = await connect(stateDir);
      if (existing) return existing;
      // A host from an earlier call is still fetching Chromium: say how far it is instead of starting a second one.
      const working = await liveHostStatus(stateDir);
      if (working?.state === 'installing') throw new Error(installingMessage(working));
      // A busy machine can miss the 8 second connect: while Chrome is alive, ask a few more times before calling it foreign.
      for (let again = 0; again < 4 && await externalChromeRunning(stateDir); again++) {
        await pause(1_500);
        const later = await connect(stateDir);
        if (later) return later;
      }
      if (await externalChromeRunning(stateDir)) throw new Error('ClikCode Chrome is open outside ClikCode. Finish that browser step, close its window, and retry.');
      const entry = process.env.CLIKCODE_BROWSER_HOST_ENTRY || process.argv[1];
      if (!entry) throw new Error('ClikCode could not start its browser host.');
      const hostArgs = [process.execPath, entry, 'computer-host', stateDir];
      const plain = hiddenDisplayCommand(hostArgs);
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
        await pause(200);
      }
      const last = await readHostStatus(stateDir);
      if (last?.state === 'failed' && last.text) throw new Error(last.text);
      throw new Error('ClikCode could not start its browser. Check that Chrome or Edge is installed and the desktop is available.');
    } finally { await fs.unlink(lock).catch(quiet('agent/computer/browser')); }
  }
  for (let attempt = 0; attempt < 110; attempt++) {
    const result = await connect(stateDir);
    if (result) return result;
    const status = await readHostStatus(stateDir);
    if (status?.state === 'installing') throw new Error(installingMessage(status));
    if (status?.state === 'failed' && status.text) throw new Error(status.text);
    await pause(200);
  }
  throw new Error('ClikCode Chrome could not start.');
}

async function browserFor(stateDir: string, start: boolean): Promise<Connected> {
  let opening = running.get(stateDir);
  if (!opening) {
    opening = (async () => {
      const current = await connect(stateDir);
      if (current) return current;
      if (!start) throw new Error('ClikCode browser is closed. Open a URL with browser_use first.');
      return startHost(stateDir);
    })();
    running.set(stateDir, opening);
    void opening.then(({ browser }) => {
      browser.on('disconnected', () => { if (running.get(stateDir) === opening) running.delete(stateDir); });
    }).catch(quiet('agent/computer/browser'));
    opening.catch(() => { if (running.get(stateDir) === opening) running.delete(stateDir); });
  }
  return opening;
}

/** This process is one chat's worker, so the tab it holds is that chat's own: another chat
 * in the same Chrome never has its page read, clicked or followed by this one. One process can also
 * serve several agents at once (an MCP server shared by sub-agents), which is why a call may name its
 * own `tab`: calls with different names never share, read or navigate each other's page. */
const owned = sharedState('browser-owned', () => new Map<string, Page[]>());
const ownerKey = (stateDir: string, tab?: string): string => (tab ? `${stateDir}\u0000${tab}` : stateDir);

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

/** Make `page` this chat's tab (a popup the chat's own page opened). */
export function adoptPage(stateDir: string, page: Page, tab?: string): void {
  watchDownloads(page, stateDir);
  watchDialogs(page);
  const key = ownerKey(stateDir, tab);
  owned.set(key, [...(owned.get(key) ?? []).filter(old => old !== page), page]);
  chosen.delete(key);
  watchConsole(page);
  holdTab(stateDir, page, tab);
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
  })().catch(() => undefined);
}

async function flushHeld(stateDir: string, page: Page, entry: Held, force: boolean): Promise<void> {
  const now = Date.now();
  if (!force && now - entry.written < WRITE_EVERY_MS) return;
  entry.written = now;
  const id = await entry.id;
  if (!id) return;
  const record: TabRecord = {
    id, ...(entry.tab ? { tab: entry.tab } : {}), ownerPid: entry.parked ? 0 : process.pid, owner: entry.parked ? `parked by ${ownerLabel()}` : ownerLabel(),
    openedAt: entry.openedAt, lastUsedAt: entry.lastUsedAt, ...(page.isClosed() ? {} : { url: page.url() }), ...(entry.parked ? { parked: true } : {}),
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
  const entry = held.get(page);
  if (entry) { entry.lastUsedAt = Date.now(); void flushHeld(stateDir, page, entry, false).catch(quiet('agent/computer/browser')); }
  const now = Date.now();
  if (now - (lastSweep.get(stateDir) ?? 0) < SWEEP_EVERY_MS) return;
  lastSweep.set(stateDir, now);
  void sweepTabs(stateDir).catch(quiet('agent/computer/browser'));
}

/** A tab the host reopened after a recycle for this label, taken over by the worker that names it. */
async function claimRestored(stateDir: string, context: BrowserContext, tab: string | undefined): Promise<Page | undefined> {
  if (!tab) return undefined;
  const record = (await readTabRecords(stateDir)).find(item => item.restoreFor === tab && item.ownerPid === 0);
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
}

/** A second tab for this chat (a page to keep while another is read); it becomes the one in front. */
export async function openNewComputerPage(stateDir: string, tab?: string): Promise<Page> {
  const { context } = await browserFor(stateDir, true);
  const page = await context.newPage();
  adoptPage(stateDir, page, tab);
  touchTab(stateDir, page);
  return page;
}

/** Tabs whose pending page calls were abandoned (a fill that did not finish) and that are being reloaded. */
const recovering = sharedState('browser-recovering', () => new Set<Page>());
export const isRecovering = (page: Page): boolean => recovering.has(page);

/** After abandoning a stuck page call: mark the tab 'recovering' and reload it. A tab that will not reload in time is replaced by a
 * fresh one at the same address (the old one is closed) and takes its place as this chat's tab. Returns the page to use. */
export async function recoverComputerPage(stateDir: string, page: Page, tab?: string): Promise<Page> {
  recovering.add(page);
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
  } finally { recovering.delete(page); }
}

/** This chat's tab, opened in the shared Chrome the first time it is needed. */
export async function openComputerPage(stateDir: string, tab?: string): Promise<Page> {
  const { context } = await browserFor(stateDir, true);
  const existing = mine(stateDir, tab) ?? await claimRestored(stateDir, context, tab);
  if (existing) { touchTab(stateDir, existing); return existing; }
  const page = await context.newPage();
  adoptPage(stateDir, page, tab);
  touchTab(stateDir, page);
  return page;
}

export async function computerPage(stateDir: string, tab?: string): Promise<Page> {
  const { context } = await browserFor(stateDir, false);
  const page = mine(stateDir, tab) ?? await claimRestored(stateDir, context, tab);
  if (page) touchTab(stateDir, page);
  if (!page) throw new Error('This chat has no open tab. Open a URL with browser_use first.');
  return page;
}

/** For a command run outside any chat (`clikcode computer inspect`): the tab in front. */
export async function frontComputerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir, false);
  const open = context.pages().filter(page => !page.isClosed());
  for (const page of open.reverse()) {
    try { if (await page.evaluate(() => (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState === 'visible')) return page; }
    catch { /* a browser-internal tab cannot be inspected */ }
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
  const { context } = await browserFor(stateDir, false);
  return context.pages().filter(page => !page.isClosed());
}

/** Close this chat's tab only: the Chrome and every other chat's tab stay as they are. A named tab is closed whoever
 * holds it (another worker's, one left by a worker that ended): the name is how an agent says which. */
export async function closeComputerPage(stateDir: string, tab?: string): Promise<void> {
  const key = ownerKey(stateDir, tab);
  const pages = owned.get(key) ?? [];
  owned.delete(key);
  chosen.delete(key);
  for (const page of pages) await page.close().catch(quiet('agent/computer/browser'));
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
    for (const page of pages) await page.close().catch(quiet('agent/computer/browser'));
  }
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
  const { context } = await browserFor(stateDir, false).catch(() => ({ context: undefined }));
  if (!context) return undefined;
  for (const page of context.pages()) {
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
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  await (await opening?.catch(quiet('agent/computer/browser')))?.browser.close().catch(quiet('agent/computer/browser'));
}

export async function closeComputerBrowser(stateDir: string): Promise<void> {
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
      for (let waited = 0; waited < 5_000 && processAlive(record.pid!); waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch { /* no ClikCode-owned browser */ }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A tab for one check, not owned by any chat: the caller closes it. Starts the shared Chrome when it is not running. */
export async function throwawayComputerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir, true);
  return context.newPage();
}

/** On Linux the browser runs on its own virtual display so its windows never take focus from the user's
 * screen. Handoff and screenshots go over CDP and are unaffected. CLIKCODE_BROWSER_VISIBLE=1 shows it. */
export function hiddenDisplayCommand(command: string[], env = process.env, platform = process.platform, hasXvfb = () => whichSync('xvfb-run')): string[] {
  // Headless needs no display, virtual or real.
  if (platform !== 'linux' || env.CLIKCODE_BROWSER_VISIBLE === '1' || /^(?:1|true|yes|on)$/i.test(env.CLIKCODE_BROWSER_HEADLESS ?? '') || !hasXvfb()) return command;
  return ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24', ...command];
}

function whichSync(name: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => { try { accessSync(path.join(dir, name), fsConstants.X_OK); return true; } catch { return false; } });
}
