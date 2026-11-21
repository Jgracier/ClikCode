/** Real Chrome, the way the shared browser runs: one host that launched it, and workers attached over CDP that come and go.
 * Chrome's home is a temporary folder, so the "user's Downloads folder" it falls back to is never the real one. */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { bindDownloads, downloadNotes, downloadsDir, downloadsInbox, listDownloads, serveDownloads } from './downloads.js';
import { watchDownload } from './download-capture.js';
import { sleep } from '../../runtime/sleep.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';

async function fixture(): Promise<{ stateDir: string; home: string; base: string; host: BrowserContext; attach(): Promise<{ browser: Browser; context: BrowserContext }>; close(): Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-downloads-shared-'));
  const home = join(stateDir, 'home');
  await mkdir(home, { recursive: true });
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith('/file')) { response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' }); response.end('%PDF-1.4 hello'); return; }
    if (request.url?.startsWith('/key')) { response.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="key.json"' }); response.end('{"private_key":"abc"}'); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<a id=dl href="/file">get</a> <a id=key href="/key">key</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const profile = join(stateDir, 'computer', 'chrome');
  const inbox = downloadsInbox(stateDir);
  await mkdir(inbox, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') } as Record<string, string>;
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  // As browser-host.ts launches it.
  const host = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, acceptDownloads: true, downloadsPath: inbox, env, ignoreDefaultArgs: ['--enable-automation'], args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  return {
    stateDir, home, base, host,
    // As browser.ts connects a worker.
    attach: async () => { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); await serveDownloads(browser, stateDir); return { browser, context: browser.contexts()[0]! }; },
    close: async () => { await host.close().catch(() => undefined); server.close(); await rm(stateDir, { recursive: true, force: true }); },
  };
}

async function clickAndReport(page: Page, selector = '#dl'): Promise<string[]> {
  await page.click(selector);
  return downloadNotes(page, 15_000, true);
}

it.skipIf(!enabled)('saves a download into the chat folder whichever worker attached first or last, and after another worker left', async () => {
  const shared = await fixture();
  try {
    const first = await shared.attach();
    const page = await first.context.newPage();
    await page.goto(shared.base);
    const expectSaved = async (notes: string[], name: string): Promise<void> => {
      expect(notes).toEqual([`Downloaded ${name} (14 B) at ${join(downloadsDir(shared.stateDir, 'chat-a'), name)}.`]);
      expect(await readFile(join(downloadsDir(shared.stateDir, 'chat-a'), name), 'utf8')).toBe('%PDF-1.4 hello');
    };
    bindDownloads(page, shared.stateDir, 'chat-a');
    await expectSaved(await clickAndReport(page), 'report.pdf');

    // A second worker attaches: Chrome's download folder is now whatever that one named last.
    const second = await shared.attach();
    const other = await second.context.newPage();
    await other.goto(shared.base);
    bindDownloads(other, shared.stateDir, 'chat-b');
    bindDownloads(page, shared.stateDir, 'chat-a');
    await expectSaved(await clickAndReport(page), 'report (1).pdf');
    expect(await clickAndReport(other)).toEqual([`Downloaded report.pdf (14 B) at ${join(downloadsDir(shared.stateDir, 'chat-b'), 'report.pdf')}.`]);

    // The second worker leaves: Chrome puts the folder back to its default. The next call names the inbox again.
    await second.browser.close();
    bindDownloads(page, shared.stateDir, 'chat-a');
    await expectSaved(await clickAndReport(page), 'report (2).pdf');
    expect(await readdir(join(shared.home, 'Downloads')).catch(() => [])).toEqual([]);

    // A worker leaves in the middle of a call, after the inbox was named: Chrome writes to its default folder under the site's name,
    // says so, and the file is taken from there.
    const third = await shared.attach();
    bindDownloads(page, shared.stateDir, 'chat-a');
    await third.browser.close();
    await sleep(300);
    await expectSaved(await clickAndReport(page), 'report (3).pdf');
    expect(await readdir(join(shared.home, 'Downloads')).catch(() => [])).toEqual([]);

    expect(await readdir(downloadsInbox(shared.stateDir))).toEqual([]);
    expect((await listDownloads(shared.stateDir, 'chat-a')).map(file => file.name).sort()).toEqual(['report (1).pdf', 'report (2).pdf', 'report (3).pdf', 'report.pdf']);
    await first.browser.close();
  } finally { await shared.close(); }
}, 90_000);

it.skipIf(!enabled)('saves a download from a tab in a context the host owns', async () => {
  const shared = await fixture();
  try {
    const hostBrowser = shared.host.browser()!;
    await hostBrowser.newContext();
    const ids = await hostBrowser.newBrowserCDPSession();
    const { browserContextIds } = await ids.send('Target.getBrowserContexts');
    const worker = await shared.attach();
    const { pageInHostedContext } = await import('./browser.js');
    const page = await pageInHostedContext({ browser: worker.browser, context: worker.context }, browserContextIds.at(-1)!);
    await page.goto(shared.base);
    bindDownloads(page, shared.stateDir, 'chat-h');
    expect(await clickAndReport(page)).toEqual([`Downloaded report.pdf (14 B) at ${join(downloadsDir(shared.stateDir, 'chat-h'), 'report.pdf')}.`]);
    expect(await readdir(downloadsInbox(shared.stateDir))).toEqual([]);
    await worker.browser.close();
  } finally { await shared.close(); }
}, 60_000);

it.skipIf(!enabled)('reads a credential download where Chrome wrote it and leaves no file anywhere', async () => {
  const shared = await fixture();
  try {
    const first = await shared.attach();
    const page = await first.context.newPage();
    await page.goto(shared.base);
    bindDownloads(page, shared.stateDir, 'chat-k');
    // Another worker attached after this one: Playwright's own idea of the file's path is wrong from here on.
    const second = await shared.attach();
    const watch = watchDownload(page);
    await page.click('#key');
    let text: string | undefined;
    for (let waited = 0; waited < 10_000 && !text; waited += 100) { text = await watch.result(); if (!text) await sleep(100); }
    watch.stop();
    expect(text).toBe('{"private_key":"abc"}');
    expect(await downloadNotes(page, 1_000)).toEqual([]);
    expect(await listDownloads(shared.stateDir, 'chat-k')).toEqual([]);
    expect(await readdir(downloadsInbox(shared.stateDir))).toEqual([]);
    expect(await readdir(join(shared.home, 'Downloads')).catch(() => [])).toEqual([]);
    await second.browser.close();
    await first.browser.close();
  } finally { await shared.close(); }
}, 60_000);
