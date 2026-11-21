import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { Browser, Download, Page } from 'playwright-core';
import { bindDownloads, claimDownload, describeDownloads, downloadNotes, downloadSource, downloadsDir, downloadsInbox, freeName, listDownloads, safeFileName, serveDownloads } from './downloads.js';
import { watchDownload } from './download-capture.js';

it('makes a file name safe on every operating system', () => {
  expect(safeFileName('report.pdf')).toBe('report.pdf');
  expect(safeFileName('../../etc/passwd')).not.toMatch(/[\\/]/);
  expect(safeFileName('..\\..\\x.txt')).not.toMatch(/[\\/]/);
  expect(safeFileName('.bashrc')).toBe('_bashrc');
  expect(safeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
  expect(safeFileName('con.txt')).toBe('_con.txt');
  expect(safeFileName('')).toBe('download');
  expect(safeFileName('x'.repeat(300) + '.csv').length).toBeLessThanOrEqual(120);
  expect(safeFileName('x'.repeat(300) + '.csv').endsWith('.csv')).toBe(true);
});

it('keeps a chat\'s folder inside the downloads folder', () => {
  const dir = downloadsDir('/state', '../../evil');
  expect(dir.startsWith(join('/state', 'computer', 'downloads'))).toBe(true);
  expect(dirname(dir)).toBe(join('/state', 'computer', 'downloads'));
});

it('does not overwrite an earlier download of the same name', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-downloads-'));
  try {
    const dir = downloadsDir(stateDir, 'c1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'one');
    expect(await freeName(dir, 'a.txt')).toBe(join(dir, 'a (1).txt'));
    expect(await listDownloads(stateDir, 'c1')).toMatchObject([{ name: 'a.txt', size: 3 }]);
    expect(await describeDownloads(stateDir, 'c1')).toContain('a.txt (3 B');
    expect(await describeDownloads(stateDir, 'other')).toContain('No downloads yet');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

// ── where a finished download is, and when it counts as saved ──

async function scratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'clikcode-downloads-'));
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

it('keeps the inbox out of every chat folder', () => {
  expect(dirname(downloadsInbox('/state'))).toBe(join('/state', 'computer', 'downloads'));
  for (const chat of ['.incoming', '..incoming', 'chat', undefined]) expect(downloadsDir('/state', chat)).not.toBe(downloadsInbox('/state'));
});

it('looks for a finished download where the browser said it wrote it, else in the inbox under its id', () => {
  expect(downloadSource('/inbox', 'guid-1', '/home/u/Downloads/report.pdf')).toBe('/home/u/Downloads/report.pdf');
  expect(downloadSource('/inbox', 'guid-1')).toBe(join('/inbox', 'guid-1'));
});

it('moves a finished download into the chat folder and reports its real path and size', () => scratch(async root => {
  const source = join(root, 'inbox-guid');
  await writeFile(source, 'hello');
  const dir = join(root, 'chat');
  const saved = await claimDownload(source, dir, 'report.pdf', 5);
  expect(saved).toEqual({ name: 'report.pdf', path: join(dir, 'report.pdf'), size: 5 });
  expect(await readFile(saved.path, 'utf8')).toBe('hello');
  await expect(access(source)).rejects.toThrow();
  // A second file of the same name never replaces the first.
  await writeFile(source, 'second!');
  const again = await claimDownload(source, dir, 'report.pdf');
  expect(again).toEqual({ name: 'report (1).pdf', path: join(dir, 'report (1).pdf'), size: 7 });
  expect(await readFile(join(dir, 'report.pdf'), 'utf8')).toBe('hello');
}));

it('does not call a download saved when no file, an empty file or a short file is on disk', () => scratch(async root => {
  const dir = join(root, 'chat');
  const missing = join(root, 'nowhere', 'guid');
  await expect(claimDownload(missing, dir, 'a.pdf')).rejects.toThrow(`the browser reported it finished, but no file is at ${missing}`);
  const empty = join(root, 'empty');
  await writeFile(empty, '');
  await expect(claimDownload(empty, dir, 'a.pdf')).rejects.toThrow('the file arrived empty (0 bytes)');
  const short = join(root, 'short');
  await writeFile(short, 'abc');
  await expect(claimDownload(short, dir, 'a.pdf', 10)).rejects.toThrow('the file is incomplete (3 of 10 bytes on disk)');
  expect(await listDownloads(root, 'chat')).toEqual([]);
  await expect(readdir(dir)).rejects.toThrow();
}));

/** A page of a browser whose CDP session and download events the test drives. */
function fakeBrowser() {
  const sent: Array<{ method: string; params: unknown }> = [];
  let onProgress: ((event: Record<string, unknown>) => void) | undefined;
  const session = {
    on: (name: string, handler: (event: Record<string, unknown>) => void) => { if (name === 'Browser.downloadProgress') onProgress = handler; },
    send: async (method: string, params: unknown) => { sent.push({ method, params }); return {}; },
  };
  const browser = { newBrowserCDPSession: async () => session } as unknown as Browser;
  let onDownload: ((download: Download) => void) | undefined;
  const page = { context: () => ({ browser: () => browser }), on: (name: string, handler: (download: Download) => void) => { if (name === 'download') onDownload = handler; }, off: () => undefined } as unknown as Page;
  const download = (name: string, path: () => Promise<string>): void => onDownload!({ suggestedFilename: () => name, path } as unknown as Download);
  return { browser, page, sent, download, progress: (event: Record<string, unknown>) => onProgress!(event) };
}

it('names the same inbox on every call and takes the file from where Chrome reported it, not from where Playwright expects it', () => scratch(async root => {
  const fake = fakeBrowser();
  await serveDownloads(fake.browser, root);
  const behavior = { method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName', downloadPath: downloadsInbox(root), eventsEnabled: true } };
  expect(fake.sent).toEqual([behavior]);
  bindDownloads(fake.page, root, 'chat-1');
  bindDownloads(fake.page, root, 'chat-1');
  expect(fake.sent).toEqual([behavior, behavior, behavior]);

  // Another worker left: Chrome wrote to its default folder under the site's name, and says so for this download's id.
  const elsewhere = join(root, 'home', 'Downloads');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, 'report.pdf'), 'PDF!');
  fake.download('report.pdf', async () => join(root, 'playwright-artifacts-x', 'guid-1'));
  fake.progress({ guid: 'guid-1', state: 'inProgress', receivedBytes: 1, totalBytes: 4 });
  fake.progress({ guid: 'guid-1', state: 'completed', receivedBytes: 4, totalBytes: 4, filePath: join(elsewhere, 'report.pdf') });
  expect(await downloadNotes(fake.page)).toEqual([`Downloaded report.pdf (4 B) at ${join(downloadsDir(root, 'chat-1'), 'report.pdf')}.`]);
  expect(await readdir(elsewhere)).toEqual([]);

  // No path reported (an older Chrome): the inbox, under the download's id.
  await writeFile(join(downloadsInbox(root), 'guid-2'), 'again');
  fake.download('report.pdf', async () => join(root, 'playwright-artifacts-x', 'guid-2'));
  fake.progress({ guid: 'guid-2', state: 'completed', receivedBytes: 5, totalBytes: 5 });
  expect(await downloadNotes(fake.page)).toEqual([`Downloaded report (1).pdf (5 B) at ${join(downloadsDir(root, 'chat-1'), 'report (1).pdf')}.`]);
  expect(await readdir(downloadsInbox(root))).toEqual([]);
}));

it('reports a failed download with the real reason and saves nothing', () => scratch(async root => {
  const fake = fakeBrowser();
  await serveDownloads(fake.browser, root);
  bindDownloads(fake.page, root, 'chat-1');
  fake.download('big.zip', async () => { throw new Error('download.path: canceled'); });
  fake.progress({ guid: 'guid-3', state: 'canceled', receivedBytes: 10, totalBytes: 100 });
  expect(await downloadNotes(fake.page)).toEqual(['A download failed: big.zip: the browser did not finish it (canceled).']);

  // Chrome says it finished and names a path, but nothing is there: never "Downloaded".
  const gone = join(root, 'gone', 'guid-4');
  fake.download('lost.pdf', async () => join(root, 'playwright-artifacts-x', 'guid-4'));
  fake.progress({ guid: 'guid-4', state: 'completed', receivedBytes: 9, totalBytes: 9, filePath: gone });
  expect(await downloadNotes(fake.page)).toEqual([`A download failed: lost.pdf: the browser reported it finished, but no file is at ${gone}.`]);
  expect(await listDownloads(root, 'chat-1')).toEqual([]);
}));

it('lets a key capture read a download where Chrome wrote it, then removes it', () => scratch(async root => {
  const fake = fakeBrowser();
  await serveDownloads(fake.browser, root);
  bindDownloads(fake.page, root, 'chat-1');
  const watch = watchDownload(fake.page);
  await writeFile(join(downloadsInbox(root), 'guid-5'), ' {"private_key":"abc"}\n');
  fake.download('key.json', async () => join(root, 'playwright-artifacts-x', 'guid-5'));
  fake.progress({ guid: 'guid-5', state: 'completed', receivedBytes: 23, totalBytes: 23, filePath: join(downloadsInbox(root), 'guid-5') });
  expect(await watch.result()).toBe('{"private_key":"abc"}');
  watch.stop();
  expect(await readdir(downloadsInbox(root))).toEqual([]);
  expect(await downloadNotes(fake.page)).toEqual([]);
  expect(await listDownloads(root, 'chat-1')).toEqual([]);
}));
