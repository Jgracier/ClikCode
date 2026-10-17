/** Detached owner of ClikCode's Chrome profile. Workers connect over local CDP. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

export function computerProfile(stateDir: string): string { return path.join(stateDir, 'computer', 'chrome'); }
export function computerHostFile(stateDir: string): string { return path.join(stateDir, 'computer', 'host.json'); }

export async function runComputerHost(stateDir: string): Promise<void> {
  const profile = computerProfile(stateDir);
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, viewport: null, acceptDownloads: false,
    // Playwright's default --enable-automation and Chrome's port-0 debugging
    // each advertise WebDriver to sites. Keep the private CDP connection, but
    // don't expose that signal to ordinary page JavaScript.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-blink-features=AutomationControlled'],
  });
  const hostFile = computerHostFile(stateDir);
  const record = JSON.stringify({ pid: process.pid });
  try {
    await fs.writeFile(hostFile, record, { mode: 0o600 });
    const stop = (): void => { void context.close().catch(() => undefined); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>(resolve => (context as unknown as { once(event: 'close', callback: () => void): void }).once('close', resolve));
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  } finally {
    try { if (await fs.readFile(hostFile, 'utf8') === record) await fs.unlink(hostFile); } catch { /* already gone */ }
    await context.close().catch(() => undefined);
  }
}
