/** Starting ClikCode's browser on whatever machine this is: Chrome, else Edge, else Playwright's own Chromium (fetched
 * once when it is not there), visible or headless. The host process writes what it is doing to a small status file,
 * because it runs detached and the worker that asked for it cannot see its output. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';

/** Chrome first; Edge (same engine, preinstalled on Windows) when Chrome is not installed. */
export const BROWSER_CHANNELS = ['chrome', 'msedge'] as const;

export class NoBrowserError extends Error {}

const NOT_INSTALLED = /executable doesn't exist|is not found at|distribution .* is not found/i;
export const isNotInstalled = (error: unknown): boolean => NOT_INSTALLED.test(error instanceof Error ? error.message : String(error));

export async function launchFirst<T>(launch: (channel: string) => Promise<T>, channels: readonly string[] = BROWSER_CHANNELS): Promise<T> {
  let first: unknown;
  for (const channel of channels) {
    try { return await launch(channel); }
    catch (error) {
      first ??= error;
      // Only "not installed" moves on; a profile in use or a crash is reported as it is.
      if (!isNotInstalled(error)) throw error;
    }
  }
  throw new NoBrowserError('ClikCode needs Google Chrome or Microsoft Edge installed to open web pages.', { cause: first });
}

// ── visible or headless ─────────────────────────────────────────────────────

const truthy = (value: string | undefined): boolean => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
const falsy = (value: string | undefined): boolean => /^(?:0|false|no|off)$/i.test(value?.trim() ?? '');

/** CLIKCODE_BROWSER_HEADLESS=1 forces headless and =0 forces a window; so does the account setting (`headless` in
 * computer/settings.json). Otherwise a Linux computer with no display (no DISPLAY, no WAYLAND_DISPLAY: a server, a
 * container, an ssh session) runs headless instead of failing to open a window. macOS and Windows always have a display. */
export function shouldRunHeadless(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; setting?: boolean } = {}): boolean {
  const env = options.env ?? process.env;
  if (truthy(env.CLIKCODE_BROWSER_HEADLESS)) return true;
  if (falsy(env.CLIKCODE_BROWSER_HEADLESS)) return false;
  if (options.setting === true) return true;
  return (options.platform ?? process.platform) === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

// ── what the detached host is doing ─────────────────────────────────────────

export type HostStatus = { pid: number; state: 'starting' | 'installing' | 'running' | 'failed'; text?: string };
export const installMarkerFile = (stateDir: string): string => path.join(stateDir, 'computer', 'chromium-install.json');
export const hostStatusFile = (stateDir: string): string => path.join(stateDir, 'computer', 'host-status.json');

export async function writeHostStatus(stateDir: string, status: HostStatus): Promise<void> {
  const file = hostStatusFile(stateDir);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(status), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch { /* the status is a courtesy; starting the browser does not depend on it */ }
}

export async function readHostStatus(stateDir: string): Promise<HostStatus | undefined> {
  try {
    const status = JSON.parse(await fs.readFile(hostStatusFile(stateDir), 'utf8')) as HostStatus;
    return Number.isSafeInteger(status.pid) && typeof status.state === 'string' ? status : undefined;
  } catch { return undefined; }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The status of a host that is still working, or undefined. */
export async function liveHostStatus(stateDir: string): Promise<HostStatus | undefined> {
  const status = await readHostStatus(stateDir);
  return status && processAlive(status.pid) ? status : undefined;
}

// ── fetching Chromium ───────────────────────────────────────────────────────

/** Where Playwright's command line lives (its `exports` do not list it, but package.json is). */
export function playwrightCli(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
}

/** The newest progress line of `playwright-core install`: "Downloading Chromium 141.0.7390.37 ... 100%". */
export function progressLine(chunk: string): string | undefined {
  const lines = chunk.split(/[\r\n]+/).map(line => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[|■□█▒░#]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.at(-1);
}

/** `playwright-core install chromium`, with the newest progress line passed on as it comes. */
export async function installChromium(onProgress: (line: string) => void, cli = playwrightCli()): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } });
    let tail = '';
    const take = (data: Buffer): void => { const text = data.toString('utf8'); tail = (tail + text).slice(-600); const line = progressLine(text); if (line) onProgress(line); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`the download failed (exit ${code}): ${progressLine(tail) ?? 'no details'}`)));
  });
}

type LaunchOptions = Parameters<BrowserType['launchPersistentContext']>[1];

/** Chrome, else Edge, else Playwright's Chromium, fetched once when it is not there. */
export async function launchComputerBrowser(chromium: BrowserType, profile: string, options: NonNullable<LaunchOptions>, stateDir: string, install: (onProgress: (line: string) => void) => Promise<void> = installChromium): Promise<BrowserContext> {
  const launch = (channel?: string): Promise<BrowserContext> => chromium.launchPersistentContext(profile, { ...options, ...(channel ? { channel } : {}) });
  try { return await launchFirst(launch); }
  catch (error) { if (!(error instanceof NoBrowserError)) throw error; }
  try { return await launch(); }
  catch (error) { if (!isNotInstalled(error)) throw error; }
  const marker = installMarkerFile(stateDir);
  const earlier = await fs.readFile(marker, 'utf8').then(text => JSON.parse(text) as { at: number; ok: boolean }, () => undefined);
  // Once: a download that worked but gave no browser is not repeated, and a failed one (offline) waits an hour.
  if (earlier && (earlier.ok || Date.now() - earlier.at < 60 * 60_000)) throw new Error(noBrowserMessage(earlier.ok ? 'the Chromium that was downloaded earlier does not start' : 'the download failed a short while ago'));
  let lastWrite = 0;
  await writeHostStatus(stateDir, { pid: process.pid, state: 'installing', text: 'starting the download' });
  try {
    await install(line => { if (Date.now() - lastWrite > 700) { lastWrite = Date.now(); void writeHostStatus(stateDir, { pid: process.pid, state: 'installing', text: line }); } });
  } catch (error) {
    await fs.writeFile(marker, JSON.stringify({ at: Date.now(), ok: false }), { mode: 0o600 }).catch(() => undefined);
    throw new Error(noBrowserMessage(error instanceof Error ? error.message : String(error)));
  }
  await fs.writeFile(marker, JSON.stringify({ at: Date.now(), ok: true }), { mode: 0o600 }).catch(() => undefined);
  await writeHostStatus(stateDir, { pid: process.pid, state: 'starting' });
  try { return await launch(); }
  catch (error) { throw new Error(noBrowserMessage(error instanceof Error ? error.message.split('\n')[0]! : String(error))); }
}

export function noBrowserMessage(why: string): string {
  const where = process.platform === 'win32' ? 'Microsoft Edge comes with Windows; Chrome is at https://www.google.com/chrome/' : process.platform === 'darwin' ? 'Install Google Chrome from https://www.google.com/chrome/' : 'Install Google Chrome (https://www.google.com/chrome/) or Chromium from your package manager';
  return `ClikCode needs Google Chrome or Microsoft Edge to open web pages, and neither is installed. It tried to fetch its own Chromium and could not (${why}). ${where}, or run: npx playwright-core install chromium${process.platform === 'linux' ? ' (add --with-deps as root if libraries are missing)' : ''}. Then open the page again.`;
}

/** What the worker tells the agent while the host is fetching Chromium. */
export function installingMessage(status: HostStatus): string {
  return `Neither Chrome nor Edge is installed, so ClikCode is downloading its own Chromium (a few hundred MB, once). Progress: ${status.text ?? 'starting'}. This takes a few minutes: wait, then open the page again.`;
}
