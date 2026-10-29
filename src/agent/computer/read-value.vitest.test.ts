import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chooseValue, judgeValue, labelledCandidates } from './read-value.js';
import { describeProblems, isThirdParty, whyBlank } from './why-blank.js';

describe('judgeValue', () => {
  it('accepts plain values and hides opaque ids', () => {
    expect(judgeValue('Subdomain', 'acme')).toEqual({ ok: true, hidden: false });
    expect(judgeValue('Application ID', '5f1c2d3e4a9b8c7d6e5f4a3b')).toEqual({ ok: true, hidden: true });
  });
  it('refuses secret labels and long opaque strings', () => {
    expect(judgeValue('API Key', 'abc')).toMatchObject({ ok: false });
    expect(judgeValue('Client secret', 'abc')).toMatchObject({ ok: false });
    expect(judgeValue('Workspace ID', 'Zx81hd92kQpLmn03Vb7Ywe4Zx81hd92kQpLmn03Vb7Ywe4abc')).toMatchObject({ ok: false });
    expect(judgeValue('Workspace ID', '')).toMatchObject({ ok: false });
  });
  it('skips a refused candidate for a good one', () => {
    expect(chooseValue('Account ID', ['Zx81hd92kQpLmn03Vb7Ywe4Zx81hd92kQpLmn03Vb7Ywe4abc', 'acct_42'])).toMatchObject({ kind: 'value', value: 'acct_42' });
  });
});

describe('describeProblems', () => {
  it('reports nothing-failed plainly and names a blocked third-party script', () => {
    expect(describeProblems('https://app.example.com/', [], '', 5000)).toContain('Nothing failed');
    const text = describeProblems('https://app.example.com/', [{ kind: 'blocked', url: 'https://accounts.google.com/gsi/client', thirdParty: true, detail: 'net::ERR_BLOCKED_BY_CLIENT', type: 'script' }], '', 5000);
    expect(text).toContain('Blocked requests');
    expect(text).toContain('accounts.google.com');
    expect(text).toContain('Likely cause');
  });
  it('is bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'failed' as const, url: `https://x.io/${i}`, thirdParty: false, detail: 'x', type: 'xhr' }));
    expect(describeProblems('https://x.io/', many, '', 1000).split('\n').length).toBeLessThan(20);
    expect(isThirdParty('https://a.example.com/', 'https://b.example.com/x')).toBe(false);
  });
});

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
describe.skipIf(!chrome)('in a real page', () => {
  let server: Server; let browser: Browser; let page: Page; let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', req.url === '/cfg' ? 'application/json' : 'text/html');
      if (req.url === '/cfg') { res.statusCode = 403; return void res.end('{}'); }
      res.end(`<title>t</title><body>
        <dl><dt>Application ID</dt><dd>5f1c2d3e4a9b8c7d6e5f4a3b</dd><dt>Subdomain</dt><dd>acme</dd><dt>API Key</dt><dd>hidden</dd></dl>
        <div class="row"><label>Workspace ID</label><input value="ws_123" readonly></div>
        <div id="signin">Loading...</div>
        <script src="http://localhost:9/gsi.js"></script>
        <script>fetch('/cfg'); console.error('google is not defined');</script></body>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    page = await browser.newPage();
    await page.goto(base, { waitUntil: 'load' }).catch(() => undefined);
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  it('reads labelled values from a definition list and an input row', async () => {
    expect(chooseValue('Application ID', await labelledCandidates(page, 'Application ID'))).toMatchObject({ kind: 'hidden', value: '5f1c2d3e4a9b8c7d6e5f4a3b' });
    expect(chooseValue('Subdomain', await labelledCandidates(page, 'Subdomain'))).toMatchObject({ kind: 'value', value: 'acme' });
    expect(chooseValue('Workspace ID', await labelledCandidates(page, 'Workspace ID'))).toMatchObject({ kind: 'value', value: 'ws_123' });
    expect(chooseValue('API Key', await labelledCandidates(page, 'API Key')).kind).toBe('refused');
  }, 30_000);

  it('why_blank reports the failed script, the 403 and the console error', async () => {
    const text = await whyBlank(page, { seconds: 5 });
    expect(text).toContain('/gsi.js');
    expect(text).toContain('/cfg');
    expect(text).toContain('403');
    expect(text).toContain('google is not defined');
  }, 60_000);
});
