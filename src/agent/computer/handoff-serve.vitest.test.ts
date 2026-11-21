import { request } from 'node:http';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { serveLiveView, type LiveServer } from './handoff-serve.js';

const servers: LiveServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });
const noPage = async (): Promise<Page> => { throw new Error('no tab'); };
const serve = async (input: Partial<Parameters<typeof serveLiveView>[0]> = {}): Promise<LiveServer> => { const server = await serveLiveView({ host: '127.0.0.1', page: noPage, ...input }); servers.push(server); return server; };

/** A request with a Host header of the caller's choosing, which fetch does not allow. */
const withHost = (address: string, host: string): Promise<number> => new Promise((resolve, reject) => {
  const url = new URL(address);
  request({ host: url.hostname, port: url.port, path: url.pathname, headers: { host } }, response => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
});

describe('the live view server', () => {
  it('answers only at its random path, with a page that can talk to nothing but this server', async () => {
    const server = await serve();
    expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/);
    expect((await fetch(server.address.replace(/\/[\w-]{32}\/$/, '/wrongwrongwrongwrongwrongwrongwr/'))).status).toBe(404);
    expect((await fetch(new URL('/', server.address))).status).toBe(404);
    const page = await fetch(server.address);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://${new URL(server.address).host}`);
    expect(await page.text()).toContain('id="done"');
    expect((await fetch(`${server.address}ping`)).status).toBe(204);
    expect((await fetch(`${server.address}other`)).status).toBe(404);
  });

  it('makes two different addresses for two views', async () => {
    expect((await serve()).address.split('/')[3]).not.toBe((await serve()).address.split('/')[3]);
  });

  it('serves the watching page, with no Done, to a watching view', async () => {
    const server = await serve({ watch: true });
    const html = await (await fetch(server.address)).text();
    expect(html).toContain('<title>Watching ClikCode</title>');
    expect(html).not.toContain('id="done"');
  });

  it('refuses a request that names another host when told to answer only as itself', async () => {
    const server = await serve({ ownHostOnly: true });
    const own = new URL(server.address).host;
    expect(await withHost(server.address, own)).toBe(200);
    expect(await withHost(server.address, `evil.example:${new URL(server.address).port}`)).toBe(404);
    expect(await withHost(server.address, 'localhost')).toBe(404);
    // Without the option (a tailnet handoff reached by a name of the user's own) the path alone decides.
    expect(await withHost((await serve()).address, 'my-laptop.tailnet.ts.net')).toBe(200);
  });

  it('says it has ended once ended, and counts the fetch of the page as activity', async () => {
    let activity = 0;
    const server = await serve({ onActivity: () => { activity++; } });
    await fetch(server.address);
    expect(activity).toBe(1);
    expect(server.viewing()).toBeUndefined();
    server.end();
    expect((await fetch(server.address)).status).toBe(410);
    expect((await fetch(`${server.address}ping`)).status).toBe(410);
  });

  it('turns away a socket from another site\'s page, and one at the wrong path', async () => {
    const server = await serve();
    const upgrade = (path: string, origin?: string): Promise<number> => new Promise((resolve, reject) => {
      const url = new URL(server.address);
      const call = request({ host: url.hostname, port: url.port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { origin } : {}) } });
      call.on('upgrade', (_response, socket) => { socket.destroy(); resolve(101); });
      call.on('response', response => { response.resume(); resolve(response.statusCode ?? 0); });
      call.on('error', reject);
      call.end();
    });
    const path = new URL(server.address).pathname;
    expect(await upgrade(`${path}live`, 'https://evil.example')).not.toBe(101);
    expect(await upgrade('/wrongwrongwrongwrongwrongwrongwr/live')).toBe(404);
    expect(await upgrade(`${path}live`, `http://${new URL(server.address).host}`)).toBe(101);
  });
});
