/** A persistent browser that ClikCode owns. The lock keeps two workers from
 * opening the same Chrome profile and silently corrupting its login state. */
import fs from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

interface RunningBrowser { context: BrowserContext; release(): void }
const running = new Map<string, Promise<RunningBrowser>>();

async function profileLock(dir: string): Promise<() => void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.owner');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await handle.close(); }
      const release = (): void => {
        try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); } catch { /* already released */ }
      };
      process.once('exit', release);
      return () => { process.off('exit', release); release(); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = JSON.parse(await fs.readFile(file, 'utf8')).pid; } catch { /* interrupted writer */ }
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error('ClikCode browser is in use by another session. Finish that session before using this browser.'); }
        catch (alive) { if (!(alive instanceof Error) || !('code' in alive) || (alive as NodeJS.ErrnoException).code !== 'ESRCH') throw alive; }
      }
      if (attempt === 0 && existsSync(file)) await fs.unlink(file).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire the ClikCode browser profile.');
}

async function browserFor(stateDir: string): Promise<RunningBrowser> {
  const dir = path.join(stateDir, 'computer', 'chrome');
  let opening = running.get(dir);
  if (!opening) {
    opening = (async () => {
      const release = await profileLock(dir);
      try {
        const context = await chromium.launchPersistentContext(dir, {
          channel: 'chrome', headless: false, viewport: null, acceptDownloads: false,
        });
        context.on('close', () => { release(); running.delete(dir); });
        return { context, release };
      } catch (error) { release(); throw error; }
    })();
    running.set(dir, opening);
    opening.catch(() => { if (running.get(dir) === opening) running.delete(dir); });
  }
  return opening;
}

export async function computerPage(stateDir: string): Promise<Page> {
  const { context } = await browserFor(stateDir);
  // OAuth and sign-in flows often open a new tab. Follow the newest live page
  // so the next observation sees the page the previous click opened.
  return context.pages().filter((page) => !page.isClosed()).at(-1) ?? context.newPage();
}

/** Close the browser when the user disables computer use. This also releases
 * the profile lock so another ClikCode session can take it over. */
export async function closeComputerBrowser(stateDir: string): Promise<void> {
  const dir = path.join(stateDir, 'computer', 'chrome');
  const opening = running.get(dir);
  if (!opening) return;
  const browser = await opening.catch(() => undefined);
  if (browser) await browser.context.close().catch(() => undefined);
}
