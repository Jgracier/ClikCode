/** Detached owner of ClikCode's Chrome profile. Workers connect over local CDP. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { leaveDialogsToWorkers } from './page-dialogs.js';
import { hostStatusFile, launchComputerBrowser, shouldRunHeadless, writeHostStatus } from './browser-launch.js';
import { headlessSetting } from './settings.js';

export function computerProfile(stateDir: string): string { return path.join(stateDir, 'computer', 'chrome'); }
export function computerHostFile(stateDir: string): string { return path.join(stateDir, 'computer', 'host.json'); }

export { BROWSER_CHANNELS, launchFirst } from './browser-launch.js';

export async function runComputerHost(stateDir: string): Promise<void> {
  const profile = computerProfile(stateDir);
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser-host'));
  await writeHostStatus(stateDir, { pid: process.pid, state: 'starting' });
  const { chromium } = await import('playwright-core');
  const headless = shouldRunHeadless({ setting: await headlessSetting(stateDir) });
  let context;
  try {
    context = await launchComputerBrowser(chromium, profile, {
      headless, viewport: null, acceptDownloads: true,
      // FedCm: Google's sign-in button then uses its popup, not a browser-drawn dialog that no page tool can see or press.
      // Playwright's default --enable-automation and Chrome's port-0 debugging
      // each advertise WebDriver to sites. Keep the private CDP connection, but
      // don't expose that signal to ordinary page JavaScript.
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-blink-features=AutomationControlled', '--disable-features=FedCm', ...(headless ? ['--window-size=1440,900'] : [])],
    }, stateDir);
  } catch (error) {
    // The worker that started this process cannot see its output: leave the reason where it will look.
    await writeHostStatus(stateDir, { pid: process.pid, state: 'failed', text: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  leaveDialogsToWorkers(context);
  const hostFile = computerHostFile(stateDir);
  await writeHostStatus(stateDir, { pid: process.pid, state: 'running' });
  const record = JSON.stringify({ pid: process.pid });
  try {
    await fs.writeFile(hostFile, record, { mode: 0o600 });
    const stop = (): void => { void context.close().catch(quiet('agent/computer/browser-host')); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>(resolve => (context as unknown as { once(event: 'close', callback: () => void): void }).once('close', resolve));
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  } finally {
    try { if (await fs.readFile(hostFile, 'utf8') === record) await fs.unlink(hostFile); } catch { /* already gone */ }
    await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser-host'));
    await context.close().catch(quiet('agent/computer/browser-host'));
  }
}
