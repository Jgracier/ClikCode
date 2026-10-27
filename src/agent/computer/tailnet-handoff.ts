/** Handoff over the user's own Tailscale network, for a phone that is on it: a live view of this chat's tab on the computer's Tailscale
 * address (and nowhere else). The page is laid out for the phone and drawn as Chrome paints it; touch and the phone's own keyboard reach it
 * as real input (handoff-live.ts). No relay, no WebAssembly, no third-party host; a random path is the one-use secret, and the link stops
 * working after ten idle minutes or once the user says they are done. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { computerPage } from './browser.js';
import { LiveView } from './handoff-live.js';
import { handoffPage } from './handoff-page.js';
import { acceptWebSocket, type LiteSocket } from './ws-lite.js';

const IDLE_LIMIT = 10 * 60_000;

/** This computer's Tailscale IPv4 address (100.64.0.0/10), if it is on a tailnet. */
export function tailnetAddress(interfaces = networkInterfaces()): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [a, b] = entry.address.split('.').map(Number);
      if (a === 100 && b! >= 64 && b! <= 127) return entry.address;
    }
  }
  return undefined;
}

function sameToken(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The origin a page of this server sends from, or nothing at all (a script, a test): never another site's page opening the socket. */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

export async function runTailnetHandoff(input: {
  stateDir: string; host: string; tab?: string; signal?: AbortSignal; onLink(link: string): void;
}): Promise<void> {
  const token = randomBytes(24).toString('base64url');
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let over = false;
  let current: { socket: LiteSocket; view: LiveView } | undefined;
  let idle: NodeJS.Timeout | undefined;
  let expire!: (error: Error) => void;
  const expired = new Promise<never>((_, reject) => { expire = reject; });
  expired.catch(() => undefined);
  const keepAlive = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => expire(new Error('The phone handoff expired after 10 idle minutes.')), IDLE_LIMIT);
  };

  const pathOf = (request: IncomingMessage): { first?: string; rest?: string } => {
    const [, first, rest] = /^\/([^/?]+)(\/[^?]*)?/.exec(request.url ?? '/') ?? [];
    return { ...(first ? { first } : {}), ...(rest ? { rest } : {}) };
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const { first, rest } = pathOf(request);
    if (!first || !sameToken(first, token)) { response.writeHead(404).end(); return; }
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
      }).end(handoffPage());
      keepAlive();
      return;
    }
    response.writeHead(404).end();
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { first, rest } = pathOf(request);
    if (!first || !sameToken(first, token) || rest !== '/live') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if (over) { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return; }
    const accepted = acceptWebSocket(request, socket, head, { allowOrigin: origin => sameOrigin(origin, request.headers.host) });
    if (!accepted) return;
    void (async () => {
      // One phone at a time: a reconnect (or a second tab) takes over from the one before.
      const before = current;
      current = undefined;
      before?.socket.close(1000);
      await before?.view.stop();
      const view = new LiveView(await computerPage(input.stateDir, input.tab), accepted, () => {
        over = true;
        if (!accepted.closed) accepted.send(JSON.stringify({ t: 'done' }));
        finish();
      }, keepAlive);
      current = { socket: accepted, view };
      keepAlive();
      await view.start();
    })().catch(error => { quiet('agent/computer/tailnet-handoff')(error); accepted.close(1011); });
  });

  const stopped = new Promise<never>((_, reject) => { input.signal?.addEventListener('abort', () => reject(new Error('Handoff stopped.')), { once: true }); });
  stopped.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, input.host, () => { server.off('error', reject); resolve(); }); });
    const port = (server.address() as AddressInfo).port;
    input.onLink(`http://${input.host}:${port}/${token}/`);
    keepAlive();
    await Promise.race([finished, expired, stopped]);
  } finally {
    clearTimeout(idle);
    const last = current;
    current = undefined;
    // Give the "done" message a moment to leave before the socket goes.
    await new Promise(resolve => setTimeout(resolve, 60));
    last?.socket.close(1000);
    await last?.view.stop();
    server.close();
    server.closeAllConnections();
  }
}
