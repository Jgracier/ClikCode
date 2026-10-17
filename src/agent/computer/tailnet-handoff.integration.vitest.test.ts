import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeComputerBrowser, openComputerPage } from './browser.js';
import { runTailnetHandoff, tailnetAddress } from './tailnet-handoff.js';

it('finds the Tailscale address among the interfaces, and none without one', () => {
  const entry = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
  expect(tailnetAddress({ lo: [entry('127.0.0.1', true)], eth0: [entry('192.168.1.5')], tailscale0: [entry('100.70.212.126')] })).toBe('100.70.212.126');
  expect(tailnetAddress({ eth0: [entry('100.20.1.1'), entry('10.0.0.2')] })).toBeUndefined();
});

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('serves this chat\'s tab to a phone over a one-use path and ends when the user is done', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-tailnet-'));
  try {
    const page = await openComputerPage(stateDir);
    await page.goto('data:text/html,<title>handoff</title><input id=a><p>captcha here</p>');
    let link = '';
    const run = runTailnetHandoff({ stateDir, host: '127.0.0.1', onLink: value => { link = value; } });
    for (let i = 0; i < 50 && !link; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/);
    const wrong = await fetch(link.replace(/\/[\w-]{32}\/$/, '/wrongwrongwrongwrongwrongwrongwr/'));
    expect(wrong.status).toBe(404);
    expect((await fetch(link)).headers.get('content-type')).toContain('text/html');
    const frame = await fetch(`${link}frame.jpg`);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect((await frame.arrayBuffer()).byteLength).toBeGreaterThan(500);
    await fetch(`${link}act`, { method: 'POST', body: JSON.stringify({ type: 'click', x: 20, y: 20 }) });
    await fetch(`${link}act`, { method: 'POST', body: JSON.stringify({ type: 'type', text: 'solved' }) });
    expect(await page.locator('#a').inputValue()).toBe('solved');
    expect((await fetch(`${link}act`, { method: 'POST', body: JSON.stringify({ type: 'done' }) })).status).toBe(204);
    await run;
    await expect(fetch(link)).rejects.toThrow();
  } finally {
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);
