/** Files and environment actions of browser_use in real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { useSourceBrowserHost } from './test-host-build.js';
import { closeComputerBrowser } from './browser.js';
import { computerWebTool } from '../tools/computer-web.js';
import { setComputerEnabled } from './settings.js';
import type { ToolContext } from '../tool-contract.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
// The browser host is a child process: run it from source.
beforeAll(async () => { if (enabled) await useSourceBrowserHost(); }, 60_000);

type Site = { run: (args: Record<string, unknown>) => ReturnType<typeof computerWebTool.run>; base: string; stateDir: string; cwd: string };
async function withSite<T>(handler: Parameters<typeof createServer>[1], use: (site: Site) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-files-env-'));
  const cwd = await mkdtemp(join(tmpdir(), 'clikcode-files-env-cwd-'));
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ctx = { stateDir, cwd, sessionId: 'chat-1', acceptsImages: false } as ToolContext;
    return await use({ run: args => computerWebTool.run(args, ctx), base, stateDir, cwd });
  } finally {
    server.close();
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

it.skipIf(!enabled)('saves a download to the chat folder, reports it, and lists it', async () => {
  await withSite((request, response) => {
    if (request.url === '/report.csv') { response.setHeader('Content-Type', 'text/csv'); response.setHeader('Content-Disposition', 'attachment; filename="report.csv"'); response.end('a,b\n1,2\n'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<a id="d" href="/report.csv">Get report</a>');
  }, async ({ run, base, stateDir }) => {
    const opened = (await run({ action: 'open', url: `${base}/` })).output;
    const ref = /link "Get report" \[ref=(\w+)\]/.exec(opened)![1]!;
    const clicked = await run({ action: 'click', target: ref });
    expect(clicked.output).toMatch(/Downloaded report\.csv \(8 B\) at .*report\.csv/);
    const file = /at (.*report\.csv)/.exec(clicked.output)![1]!;
    expect(file.startsWith(join(stateDir, 'computer', 'downloads'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('a,b\n1,2\n');
    expect((await run({ action: 'downloads' })).output).toContain('report.csv');
    // Opening the file's address directly saves it too, under a new name.
    const direct = await run({ action: 'open', url: `${base}/report.csv` });
    expect(direct.output).toContain('report (1).csv');
    await access(file);
  });
}, 60_000);

it.skipIf(!enabled)('does not keep a download that a key capture reads', async () => {
  const { captureSecret } = await import('./secret-capture.js');
  const { lockCredentialVault } = await import('./credential-vault.js');
  const { openComputerPage } = await import('./browser.js');
  const { listDownloads } = await import('./downloads.js');
  const FILE = JSON.stringify({ type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n' });
  await withSite((request, response) => {
    if (request.url === '/key.json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('Content-Disposition', 'attachment; filename="key.json"'); response.end(FILE); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<button style="width:200px;height:50px" onclick="location.href=\'/key.json\'">Create key</button>');
  }, async ({ base, stateDir }) => {
    const page = await openComputerPage(stateDir);
    await page.goto(`${base}/`);
    const result = await captureSecret({ stateDir, page, name: 'gcp/service-account-json', check: async () => ({ verdict: 'untested', detail: 'not tested' }),
      trigger: () => page.getByRole('button', { name: 'Create key' }).click(), ask: async () => { throw new Error('should not ask'); } });
    expect(result).toMatchObject({ found: true });
    expect(await listDownloads(stateDir, 'chat-1')).toEqual([]);
    expect(await listDownloads(stateDir, undefined)).toEqual([]);
    lockCredentialVault(stateDir);
  });
}, 60_000);
