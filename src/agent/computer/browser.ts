/** One persistent Chrome profile shared by ClikCode's terminal and editor workers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { computerHostFile, computerProfile } from './browser-host.js';

type Connected = { browser: Browser; context: BrowserContext };
const running = new Map<string, Promise<Connected>>();

async function connect(stateDir: string): Promise<Connected | undefined> {
  const file = path.join(computerProfile(stateDir), 'DevToolsActivePort');
  let port: number;
  try { port = Number((await fs.readFile(file, 'utf8')).split('\n')[0]); }
  catch { return undefined; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3_000 });
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
      if (await externalChromeRunning(stateDir)) throw new Error('ClikCode Chrome is open outside ClikCode. Finish that browser step, close its window, and retry.');
      const entry = process.env.CLIKCODE_BROWSER_HOST_ENTRY || process.argv[1];
      if (!entry) throw new Error('ClikCode could not start its browser host.');
      const child = spawn(process.execPath, [entry, 'computer-host', stateDir], { detached: true, stdio: 'ignore', windowsHide: true });
      let startupError: Error | undefined;
      child.once('error', error => { startupError = error; });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await connect(stateDir);
        if (result) return result;
        if (startupError || child.exitCode !== null) break;
        await pause(200);
      }
      throw new Error('ClikCode could not start its browser. Check that Chrome or Edge is installed and the desktop is available.');
    } finally { await fs.unlink(lock).catch(() => undefined); }
  }
  for (let attempt = 0; attempt < 110; attempt++) {
    const result = await connect(stateDir);
    if (result) return result;
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
      if (!start) throw new Error('ClikCode browser is closed. Open a URL with computer_web first.');
      return startHost(stateDir);
    })();
    running.set(stateDir, opening);
    void opening.then(({ browser }) => {
      browser.on('disconnected', () => { if (running.get(stateDir) === opening) running.delete(stateDir); });
    }).catch(() => undefined);
    opening.catch(() => { if (running.get(stateDir) === opening) running.delete(stateDir); });
  }
  return opening;
}

/** This process is one chat's worker, so the tab it holds is that chat's own: another chat
 * in the same Chrome never has its page read, clicked or followed by this one. */
const owned = new Map<string, Page[]>();

/** The newest tab still open; a popup that closed itself (a sign-in window) hands back to the page that opened it. */
function mine(stateDir: string): Page | undefined {
  const stack = (owned.get(stateDir) ?? []).filter(page => !page.isClosed());
  owned.set(stateDir, stack);
  return stack.at(-1);
}

/** Make `page` this chat's tab (a popup the chat's own page opened). */
export function adoptPage(stateDir: string, page: Page): void { owned.set(stateDir, [...(owned.get(stateDir) ?? []).filter(old => old !== page), page]); }

/** This chat's tab, opened in the shared Chrome the first time it is needed. */
export async function openComputerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir, true);
  const existing = mine(stateDir);
  if (existing) return existing;
  const page = await context.newPage();
  adoptPage(stateDir, page);
  return page;
}

export async function computerPage(stateDir: string): Promise<Page> {
  await browserFor(stateDir, false);
  const page = mine(stateDir);
  if (!page) throw new Error('This chat has no open tab. Open a URL with computer_web first.');
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

/** Every tab in the shared Chrome, whichever chat holds it (for the rule that keeps a sign-in out of view). */
export async function allComputerPages(stateDir: string): Promise<Page[]> {
  const { context } = await browserFor(stateDir, false);
  return context.pages().filter(page => !page.isClosed());
}

/** Close this chat's tab only: the Chrome and every other chat's tab stay as they are. */
export async function closeComputerPage(stateDir: string): Promise<void> {
  const pages = owned.get(stateDir) ?? [];
  owned.delete(stateDir);
  for (const page of pages) await page.close().catch(() => undefined);
}

export async function closeComputerBrowser(stateDir: string): Promise<void> {
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  const connected = await opening?.catch(() => undefined);
  await connected?.browser.close().catch(() => undefined);
  try {
    const record = JSON.parse(await fs.readFile(computerHostFile(stateDir), 'utf8')) as { pid?: number };
    if (Number.isSafeInteger(record.pid) && record.pid! > 1) process.kill(record.pid!, 'SIGTERM');
  } catch { /* no ClikCode-owned browser */ }
}
