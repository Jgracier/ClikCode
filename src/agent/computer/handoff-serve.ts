/** The small web server behind a live view of one tab: the page (handoff-page.ts) at a random path, and the socket that page opens, which
 * carries Chrome's frames out and the viewer's input in (handoff-live.ts). The handoff link (tailnet-handoff.ts) and the desktop view
 * (handoff-show.ts) are both this, on different addresses and with different endings. The random path is the only secret: anything else
 * answers 404, another site's page cannot open the socket, and nothing is cached. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Page } from 'playwright-core';
import { quiet } from '../../runtime/lifecycle-log.js';
import { sleep } from '../../runtime/sleep.js';
import { LiveView } from './handoff-live.js';
import { handoffPage } from './handoff-page.js';
import { acceptWebSocket, type LiteSocket } from './ws-lite.js';

function sameToken(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The origin a page of this server sends from, or nothing at all (a script, a test): never another site's page opening the socket. */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

export interface LiveServer {
  /** `http://host:port/<random path>/`. */
  readonly address: string;
  /** The tab the connected viewer is looking at; undefined when nobody is connected. */
  viewing(): Page | undefined;
  /** Drops the viewer. Its page connects again by itself and is given `page()` afresh (the chat moved to another tab). */
  reconnect(): void;
  /** From now on every request answers 410, which the page reads as "this has ended". */
  end(): void;
  stop(): Promise<void>;
}

export async function serveLiveView(input: {
  /** The address to listen on: nothing else can reach the view. */
  host: string;
  /** The tab to show, asked each time a viewer connects. */
  page(): Promise<Page>;
  /** A view for watching (handoff-show.ts): the tab keeps its own size, there is no Done, and a viewer whose tab closes is reconnected. */
  watch?: boolean;
  /** The Host header must be this server's own address. For loopback, where a hostile page could otherwise point a name of its own here. */
  ownHostOnly?: boolean;
  /** The user tapped Done (never in a watching view). The server has already ended. */
  onDone?(): void;
  /** The page was fetched, a viewer connected or sent input. */
  onActivity?(): void;
}): Promise<LiveServer> {
  const token = randomBytes(24).toString('base64url');
  const watch = input.watch === true;
  const active = (): void => { input.onActivity?.(); };
  let over = false;
  let current: { socket: LiteSocket; view: LiveView; page: Page } | undefined;
  let own = '';

  const pathOf = (request: IncomingMessage): { first?: string; rest?: string } => {
    const [, first, rest] = /^\/([^/?]+)(\/[^?]*)?/.exec(request.url ?? '/') ?? [];
    return { ...(first ? { first } : {}), ...(rest ? { rest } : {}) };
  };
  const allowed = (request: IncomingMessage): boolean => {
    const { first } = pathOf(request);
    return Boolean(first) && sameToken(first!, token) && (!input.ownHostOnly || request.headers.host === own);
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const { rest } = pathOf(request);
    if (!allowed(request)) { response.writeHead(404).end(); return; }
    if (over) { response.writeHead(410).end(); return; }
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && rest === '/ping') { response.writeHead(204).end(); return; }
    if (request.method === 'GET' && (!rest || rest === '/')) {
      const host = request.headers.host ?? '';
      // The page may talk to this server and draw its own pictures; nothing else.
      const origin = /^[\w.:[\]-]{1,80}$/.test(host) ? ` ws://${host}` : '';
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'${origin}`,
      }).end(handoffPage({ watch }));
      active();
      return;
    }
    response.writeHead(404).end();
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!allowed(request) || pathOf(request).rest !== '/live') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if (over) { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return; }
    const accepted = acceptWebSocket(request, socket, head, { allowOrigin: origin => sameOrigin(origin, request.headers.host) });
    if (!accepted) return;
    void (async () => {
      // One viewer at a time: a reconnect (or a second tab) takes over from the one before.
      const before = current;
      current = undefined;
      before?.socket.close(1000);
      await before?.view.stop();
      const page = await input.page();
      const view = new LiveView(page, accepted, () => {
        if (watch) return;
        over = true;
        if (!accepted.closed) accepted.send(JSON.stringify({ t: 'done' }));
        input.onDone?.();
      }, active, { watch });
      current = { socket: accepted, view, page };
      accepted.onClose(() => { if (current?.socket === accepted) current = undefined; });
      // A closed tab leaves a still picture; someone watching is better served by the chat's next tab.
      if (watch) page.once('close', () => accepted.close(1001));
      active();
      await view.start();
    })().catch(error => { quiet('agent/computer/handoff-serve')(error); accepted.close(1011); });
  });

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, input.host, () => { server.off('error', reject); resolve(); }); });
  // Nothing waits on a watching view, so it must not keep a finished command from exiting; a handoff is awaited by its caller.
  if (watch) server.unref();
  own = `${input.host}:${(server.address() as AddressInfo).port}`;
  return {
    address: `http://${own}/${token}/`,
    viewing: () => (current && !current.socket.closed ? current.page : undefined),
    reconnect: () => { current?.socket.close(1001); },
    end: () => { over = true; },
    async stop() {
      over = true;
      const last = current;
      current = undefined;
      // Give the "done" message a moment to leave before the socket goes.
      await sleep(60);
      last?.socket.close(1000);
      await last?.view.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}
