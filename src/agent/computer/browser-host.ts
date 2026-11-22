/** Detached owner of ClikCode's Chrome profile. Workers connect over local CDP. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { leaveDialogsToWorkers } from './page-dialogs.js';
import { hostStatusFile, launchComputerBrowser, shouldRunHeadless, VIRTUAL_DISPLAY_ENV, writeHostStatus } from './browser-launch.js';
import { headlessSetting } from './settings.js';
import { restoreTabs, startBrowserJanitor, takeRecycle } from './browser-janitor.js';
import { startHandoffDesk } from './handoff-desk.js';
import { findTailnetAddress } from './tailnet-handoff.js';
import { startEgressService } from './egress-host.js';
import { pidIsAlive } from '../../session/store/locks.js';
import { downloadsInbox } from './downloads.js';

export function computerProfile(stateDir: string): string { return path.join(stateDir, 'computer', 'chrome'); }
export function computerHostFile(stateDir: string): string { return path.join(stateDir, 'computer', 'host.json'); }

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

/** Chrome's own arguments for the host. FedCm off: Google's sign-in button then uses its popup, not a browser-drawn dialog that no page tool
 * can see or press. Playwright's default --enable-automation (left out by the caller) and Chrome's port-0 debugging each advertise WebDriver
 * to sites; the private CDP connection stays, the signal to page JavaScript goes. On a virtual display Chrome is told to use X11 (else it
 * finds the user's Wayland compositor) and to draw WebGL through EGL on the machine's GPU: on Xvfb it otherwise reports the software
 * "SwiftShader" renderer, the classic headless-server tell, where EGL reports the real card (measured 2026-11-20: "AMD Radeon 780M"). */
export function hostChromeArgs(options: { headless: boolean; virtualDisplay: boolean }): string[] {
  return ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-blink-features=AutomationControlled', '--disable-features=FedCm',
    ...(options.headless ? ['--window-size=1440,900'] : []),
    ...(options.virtualDisplay && !options.headless ? ['--ozone-platform=x11', '--use-gl=angle', '--use-angle=gl-egl'] : [])];
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
  try {
    context = await launchComputerBrowser(chromium, profile, {
      headless, viewport: null, acceptDownloads: true, downloadsPath: inbox,
      ignoreDefaultArgs: ['--enable-automation'],
      args: hostChromeArgs({ headless, virtualDisplay }),
    }, stateDir);
  } catch (error) {
    // The worker that started this process cannot see its output: leave the reason where it will look.
    await writeHostStatus(stateDir, { pid: process.pid, state: 'failed', text: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  leaveDialogsToWorkers(context);
  const hostFile = computerHostFile(stateDir);
  // The egress contexts and their tunnels live here, for this Chrome's whole life (egress-host.ts); workers find the socket in host.json.
  const egress = await startEgressService(stateDir, profile).catch(quiet('agent/computer/browser-host'));
  await writeHostStatus(stateDir, { pid: process.pid, state: 'running' });
  const record = JSON.stringify({ pid: process.pid, display: hostDisplay({ headless, virtualDisplay }), ...(egress ? { egressSocket: egress.socket } : {}) });
  try {
    await fs.writeFile(hostFile, record, { mode: 0o600 });
    // Closing a Chrome that is already gone never fires 'close', so a stop is bounded: the process ends either way.
    const stop = (): void => {
      void context.close().catch(quiet('agent/computer/browser-host'));
      setTimeout(() => process.exit(0), 10_000).unref();
    };
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
        // A dead Chrome makes the next worker start a new host, which renames host.json: that is the signal. A live page that no
        // longer answers CDP says the same sooner.
        const page = context.pages()[0];
        if (!page) return true;
        return context.newCDPSession(page).then(async session => { await session.detach().catch(quiet('agent/computer/browser-host')); return true; }, () => false);
      },
      retire: () => stop(),
    });
    // The handoff desk lives here because this process outlives every worker: one address for what waits on the user.
    const tailnet = await findTailnetAddress().catch(quiet('agent/computer/browser-host'));
    const desk = tailnet ? await startHandoffDesk({ stateDir, host: tailnet, context }).catch(quiet('agent/computer/browser-host')) : undefined;
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>(resolve => (context as unknown as { once(event: 'close', callback: () => void): void }).once('close', resolve));
    stopJanitor();
    await desk?.stop().catch(quiet('agent/computer/browser-host'));
    await egress?.stop().catch(quiet('agent/computer/browser-host'));
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  } finally {
    try { if (await fs.readFile(hostFile, 'utf8') === record) await fs.unlink(hostFile); } catch { /* fail-open-ok: already gone */ }
    await fs.unlink(hostStatusFile(stateDir)).catch(quiet('agent/computer/browser-host'));
    await context.close().catch(quiet('agent/computer/browser-host'));
  }
}
