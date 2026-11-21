/** Files the browser downloads for the agent. Each chat has a folder of its own under the ClikCode state
 * directory (never deleted by ClikCode), every download is moved there from the inbox Chrome writes to, and the agent
 * is told the name, size and path once the file is really there. A download that starts while a key is being captured is not saved: download-capture.ts reads it
 * and deletes it, so a credential file never stays on disk. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Download, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';
import { sleep } from '../../runtime/sleep.js';

type SavedDownload = { name: string; path: string; size: number };

type Tab = { stateDir: string; chat: string; inflight: Set<Promise<void>>; fresh: SavedDownload[]; failed: string[] };
const tabs = sharedState('page-downloads', () => new WeakMap<Page, Tab>());
/** Pages where a credential capture is reading downloads itself: nothing is saved there. */
const capturing = sharedState('page-download-capture', () => new WeakMap<Page, number>());

export function holdDownloads(page: Page, on: boolean): void { capturing.set(page, Math.max(0, (capturing.get(page) ?? 0) + (on ? 1 : -1))); }

const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const MAX_NAME = 120;

/** A file name that is safe on Linux, macOS and Windows: no folders, no control or reserved characters, no leading dot. */
export function safeFileName(suggested: string): string {
  let name = suggested.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '').trim();
  if (!name) name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

const chatFolder = (chat: string): string => chat.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'chat';
function downloadsRoot(stateDir: string): string { return path.join(stateDir, 'computer', 'downloads'); }
export function downloadsDir(stateDir: string, chat: string | undefined): string { return path.join(downloadsRoot(stateDir), chatFolder(chat || 'chat')); }

export async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

// ── where Chrome really writes a download ──
// Chrome keeps one download folder per browser context, set over CDP, and the last client to set it wins. Every worker's Playwright sets
// a temporary folder of its own when it attaches, and Chrome puts the setting back to its default (the user's Downloads folder, under
// the site's file name) when any client that set it disconnects. So a worker cannot know the folder from what it asked for itself
// (reproduced 2026-11-21 on Chrome 149: two clients on one Chrome, the second attaches, and the first one's download lands in the
// second's folder; the second leaves, and it lands in ~/Downloads). What is certain is what Chrome reports: each finished download's
// id and the path it was written to. Every client and the host name the same inbox, and the finished file is moved from where Chrome
// says it is into the chat's folder.

/** The one folder every ClikCode client of the shared Chrome names for downloads. A chat's folder never starts with a dot, so none is this one. */
export function downloadsInbox(stateDir: string): string { return path.join(downloadsRoot(stateDir), '.incoming'); }

/** What Chrome said about a download that ended. */
type Finished = { state: 'completed' | 'canceled'; filePath?: string; receivedBytes?: number };
type Desk = { inbox: string; finished: Map<string, Finished>; assert(): Promise<void> };
const desks = sharedState('browser-download-desks', () => new WeakMap<Browser, Desk>());
const MAX_REMEMBERED = 300;
const INBOX_KEEP_MS = 24 * 60 * 60_000;

/** Files left in the inbox by a worker that ended before it moved them: removed after a day. */
async function sweepInbox(inbox: string, now = Date.now()): Promise<void> {
  for (const name of await fs.readdir(inbox).catch(() => [] as string[])) {
    const file = path.join(inbox, name);
    const info = await fs.stat(file).catch(quiet('agent/computer/downloads'));
    if (info?.isFile() && now - info.mtimeMs > INBOX_KEEP_MS) await fs.unlink(file).catch(quiet('agent/computer/downloads'));
  }
}

/** For a connection to the shared local Chrome: names the inbox as its download folder and listens for what Chrome reports about every
 * download. A browser on another machine (the cloud browser) is not served: a local folder means nothing to it. */
export async function serveDownloads(browser: Browser, stateDir: string): Promise<void> {
  if (desks.has(browser)) return;
  const inbox = downloadsInbox(stateDir);
  await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
  const session = await browser.newBrowserCDPSession();
  const finished = new Map<string, Finished>();
  session.on('Browser.downloadProgress', event => {
    if (event.state === 'inProgress') return;
    const { filePath } = event as { filePath?: string };
    finished.set(event.guid, { state: event.state, ...(filePath ? { filePath } : {}), receivedBytes: event.receivedBytes });
    // Chrome reports every tab's downloads, other workers' too: only this worker's own are ever taken out again.
    while (finished.size > MAX_REMEMBERED) finished.delete(finished.keys().next().value!);
  });
  const desk: Desk = { inbox, finished, assert: async () => { await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: inbox, eventsEnabled: true }); } };
  desks.set(browser, desk);
  await desk.assert();
  void sweepInbox(inbox).catch(quiet('agent/computer/downloads'));
}

const deskOf = (page: Page): Desk | undefined => { const browser = page.context().browser(); return browser ? desks.get(browser) : undefined; };

/** Where a finished download is: the path Chrome reported for its id, else the inbox under that id (an older Chrome reports no path). */
export function downloadSource(inbox: string, guid: string, reported?: string): string { return reported || path.join(inbox, guid); }

const plainReason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/^download\.\w+:\s*/, '');

/** Waits for a download to end and says where its file is. Throws with the reason when the browser did not finish it. */
export async function arrivedDownload(page: Page, download: Download): Promise<{ file: string; bytes?: number }> {
  let named: string;
  // Playwright names the file it expects after the browser's own id for the download, in a folder of its own: the id is what is used.
  try { named = await download.path(); } catch (error) { throw new Error(`the browser did not finish it (${plainReason(error)})`); }
  const desk = deskOf(page);
  if (!desk) return { file: named };
  const guid = path.basename(named);
  // The same event from Chrome ends Playwright's wait and fills this record; they arrive within a moment of each other.
  for (let waited = 0; waited < 3_000 && !desk.finished.has(guid); waited += 50) await sleep(50);
  const report = desk.finished.get(guid);
  desk.finished.delete(guid);
  return { file: downloadSource(desk.inbox, guid, report?.filePath), ...(report?.receivedBytes ? { bytes: report.receivedBytes } : {}) };
}

/** Moves `source` into `dir` under a name no other file has, never over an existing one. */
async function placeFile(source: string, dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const target = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try { await fs.link(source, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      // Another disk, or a file system without hard links: copy, still refusing to overwrite.
      try { await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL); }
      catch (copyError) { if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue; throw copyError; }
    }
    await fs.unlink(source).catch(quiet('agent/computer/downloads'));
    return target;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

/** Takes a finished download from where the browser wrote it into the chat's folder, and returns it only once it is there, whole.
 * Throws with what was found otherwise: nothing is reported as downloaded that is not on disk. */
export async function claimDownload(source: string, dir: string, name: string, expectedBytes?: number): Promise<SavedDownload> {
  const arrived = await fs.stat(source).catch(() => undefined); /* fail-open-ok: no file there is what the next line reports */
  if (!arrived?.isFile()) throw new Error(`the browser reported it finished, but no file is at ${source}`);
  if (arrived.size === 0) {
    await fs.unlink(source).catch(quiet('agent/computer/downloads'));
    throw new Error('the file arrived empty (0 bytes)');
  }
  if (expectedBytes !== undefined && arrived.size !== expectedBytes) {
    await fs.unlink(source).catch(quiet('agent/computer/downloads'));
    throw new Error(`the file is incomplete (${arrived.size} of ${expectedBytes} bytes on disk)`);
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = await placeFile(source, dir, name);
  const saved = await fs.stat(target).catch(() => undefined); /* fail-open-ok: no file there is what the next line reports */
  if (!saved?.isFile() || saved.size !== arrived.size) throw new Error(`moving it to ${target} failed (${saved ? `${saved.size} of ${arrived.size} bytes` : 'no file'} there)`);
  return { name: path.basename(target), path: target, size: saved.size };
}

async function save(tab: Tab, page: Page, download: Download): Promise<void> {
  const name = safeFileName(download.suggestedFilename());
  try {
    const arrived = await arrivedDownload(page, download);
    tab.fresh.push(await claimDownload(arrived.file, downloadsDir(tab.stateDir, tab.chat), name, arrived.bytes));
  } catch (error) {
    tab.failed.push(`${name}: ${plainReason(error)}`);
  }
}

/** Starts saving this tab's downloads for its whole life. Safe to call again for the same page. */
export function watchDownloads(page: Page, stateDir: string): void {
  if (tabs.has(page)) return;
  const tab: Tab = { stateDir, chat: 'chat', inflight: new Set(), fresh: [], failed: [] };
  tabs.set(page, tab);
  page.on('download', download => {
    if (capturing.get(page)) return;
    const job: Promise<void> = save(tab, page, download).finally(() => { tab.inflight.delete(job); });
    tab.inflight.add(job);
  });
}

/** Which chat's folder this tab's downloads go to (set on every call, because one process may serve several chats). */
export function bindDownloads(page: Page, stateDir: string, chat: string | undefined): void {
  watchDownloads(page, stateDir);
  const tab = tabs.get(page)!;
  tab.stateDir = stateDir;
  tab.chat = chat || 'chat';
  // Another worker that attached or left since the last call changed where Chrome writes: name the inbox again before this call acts.
  void deskOf(page)?.assert().catch(quiet('agent/computer/downloads'));
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const describeDownload = (file: SavedDownload): string => `${file.name} (${sizeText(file.size)}) at ${file.path}`;

/** Waits for downloads the page has started, and says which files arrived since the last report. Empty when none. */
export async function downloadNotes(page: Page, waitMs = 30_000, expectStart = false): Promise<string[]> {
  const tab = tabs.get(page);
  if (!tab) return [];
  // A navigation that turned out to be a download can fail a moment before the download is announced.
  for (let waited = 0; expectStart && waited < 3_000 && !tab.inflight.size && !tab.fresh.length && !tab.failed.length; waited += 100) await sleep(100);
  if (tab.inflight.size) await Promise.race([Promise.allSettled([...tab.inflight]), sleep(waitMs)]);
  const notes = [
    ...tab.fresh.splice(0).map(file => `Downloaded ${describeDownload(file)}.`),
    ...tab.failed.splice(0).map(why => `A download failed: ${why}.`),
  ];
  if (tab.inflight.size) notes.push(`${tab.inflight.size} download${tab.inflight.size === 1 ? ' is' : 's are'} still in progress; check with the downloads action.`);
  return notes;
}

/** Every file in the chat's downloads folder, newest first. */
export async function listDownloads(stateDir: string, chat: string | undefined): Promise<(SavedDownload & { modified: string })[]> {
  const dir = downloadsDir(stateDir, chat);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const files: (SavedDownload & { modified: string; at: number })[] = [];
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const info = await fs.stat(file);
      if (info.isFile()) files.push({ name, path: file, size: info.size, modified: info.mtime.toISOString(), at: info.mtimeMs });
    } catch { /* fail-open-ok: removed meanwhile */ }
  }
  return files.sort((a, b) => b.at - a.at).map(({ at: _at, ...file }) => file);
}

export async function describeDownloads(stateDir: string, chat: string | undefined): Promise<string> {
  const files = await listDownloads(stateDir, chat);
  const dir = downloadsDir(stateDir, chat);
  if (!files.length) return `No downloads yet. Files the browser downloads are saved in ${dir}.`;
  return `Downloads in ${dir}:\n${files.slice(0, 50).map(file => `- ${file.name} (${sizeText(file.size)}, ${file.modified.slice(0, 19)}Z) ${file.path}`).join('\n')}${files.length > 50 ? `\n(… ${files.length - 50} older files)` : ''}`;
}
