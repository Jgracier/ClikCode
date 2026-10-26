/** Files the browser downloads for the agent. Each chat has a folder of its own under the ClikCode state
 * directory (never deleted by ClikCode), every download lands there, and the agent is told the name, size and
 * path. A download that starts while a key is being captured is not saved: download-capture.ts reads it
 * and deletes it, so a credential file never stays on disk. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Download, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';

export type SavedDownload = { name: string; path: string; size: number };

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
export function downloadsRoot(stateDir: string): string { return path.join(stateDir, 'computer', 'downloads'); }
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

async function save(tab: Tab, download: Download): Promise<void> {
  try {
    const dir = downloadsDir(tab.stateDir, tab.chat);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = await freeName(dir, safeFileName(download.suggestedFilename()));
    await download.saveAs(target);
    const size = (await fs.stat(target)).size;
    tab.fresh.push({ name: path.basename(target), path: target, size });
    await download.delete().catch(quiet('agent/computer/downloads'));
  } catch (error) {
    tab.failed.push(`${safeFileName(download.suggestedFilename())}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

/** Starts saving this tab's downloads for its whole life. Safe to call again for the same page. */
export function watchDownloads(page: Page, stateDir: string): void {
  if (tabs.has(page)) return;
  const tab: Tab = { stateDir, chat: 'chat', inflight: new Set(), fresh: [], failed: [] };
  tabs.set(page, tab);
  page.on('download', download => {
    if (capturing.get(page)) return;
    const job: Promise<void> = save(tab, download).finally(() => { tab.inflight.delete(job); });
    tab.inflight.add(job);
  });
}

/** Which chat's folder this tab's downloads go to (set on every call, because one process may serve several chats). */
export function bindDownloads(page: Page, stateDir: string, chat: string | undefined): void {
  watchDownloads(page, stateDir);
  const tab = tabs.get(page)!;
  tab.stateDir = stateDir;
  tab.chat = chat || 'chat';
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export const describeDownload = (file: SavedDownload): string => `${file.name} (${sizeText(file.size)}) at ${file.path}`;

/** Waits for downloads the page has started, and says which files arrived since the last report. Empty when none. */
export async function downloadNotes(page: Page, waitMs = 30_000, expectStart = false): Promise<string[]> {
  const tab = tabs.get(page);
  if (!tab) return [];
  // A navigation that turned out to be a download can fail a moment before the download is announced.
  for (let waited = 0; expectStart && waited < 3_000 && !tab.inflight.size && !tab.fresh.length && !tab.failed.length; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  if (tab.inflight.size) await Promise.race([Promise.allSettled([...tab.inflight]), new Promise(resolve => setTimeout(resolve, waitMs))]);
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
    } catch { /* removed meanwhile */ }
  }
  return files.sort((a, b) => b.at - a.at).map(({ at: _at, ...file }) => file);
}

export async function describeDownloads(stateDir: string, chat: string | undefined): Promise<string> {
  const files = await listDownloads(stateDir, chat);
  const dir = downloadsDir(stateDir, chat);
  if (!files.length) return `No downloads yet. Files the browser downloads are saved in ${dir}.`;
  return `Downloads in ${dir}:\n${files.slice(0, 50).map(file => `- ${file.name} (${sizeText(file.size)}, ${file.modified.slice(0, 19)}Z) ${file.path}`).join('\n')}${files.length > 50 ? `\n(… ${files.length - 50} older files)` : ''}`;
}
