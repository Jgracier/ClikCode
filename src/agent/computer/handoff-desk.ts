/** The handoff desk: one address on the user's Tailscale network, served by the browser host for as long as the browser runs.
 * It lists the tabs that wait on the user (a CAPTCHA, a code, a sign-in) and opens the live view of any of them. The address
 * never changes, a link to one tab works until the user taps Done (reloads and reconnects included), and the tab itself is
 * held open meanwhile (handoff-desk-store.ts). Nothing here answers a challenge: it only brings the user to it quickly. */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserContext, Page } from 'playwright-core';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { LiveView } from './handoff-live.js';
import { handoffPage } from './handoff-page.js';
import { clearDeskInfo, deskToken, finishDeskItem, listDeskItems, tidyDesk, writeDeskInfo, type DeskItem } from './handoff-desk-store.js';
import { acceptWebSocket, type LiteSocket } from './ws-lite.js';

/** The port the desk asks for first, so the address survives a restart; the next ones are tried when it is taken. */
const DESK_PORT = 47_811;
const TIDY_EVERY_MS = 60_000;

function sameToken(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

async function targetId(context: BrowserContext, page: Page): Promise<string | undefined> {
  const session = await context.newCDPSession(page);
  try { return ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId; }
  catch { return undefined; }
  finally { await session.detach().catch(quiet('agent/computer/handoff-desk')); }
}
async function pagesById(context: BrowserContext): Promise<Map<string, Page>> {
  const map = new Map<string, Page>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const id = await targetId(context, page);
    if (id) map.set(id, page);
  }
  return map;
}

const KIND_SAYS: Record<DeskItem['kind'], string> = { captcha: 'Human check', code: 'Code', 'sign-in': 'Sign-in', other: 'Browser step' };

/** What the list page is told about each item: no tab ids, no addresses beyond the host. */
export function deskListing(items: readonly DeskItem[], now: number): Array<{ id: string; label: string; kind: string; note?: string; host?: string; minutes: number }> {
  return items.filter(item => item.status === 'waiting').map(item => ({
    id: item.id, label: item.label, kind: KIND_SAYS[item.kind], ...(item.note ? { note: item.note } : {}), ...(item.host ? { host: item.host } : {}),
    minutes: Math.max(0, Math.round((now - item.createdAt) / 60_000)),
  }));
}

export function deskListPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#161b22">
<title>ClikCode desk</title>
<style>
html,body{margin:0;background:#0d1117;color:#f2f5f8;font:16px system-ui,-apple-system,sans-serif}
main{max-width:560px;margin:0 auto;padding:18px 14px 40px}
h1{font-size:18px;margin:6px 0 2px}#sub{color:#8b949e;font-size:14px;margin-bottom:14px}
a.item{display:block;text-decoration:none;color:inherit;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px;margin:10px 0}
a.item:active{background:#21262d}
.top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.label{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kind{flex:none;font-size:12px;color:#0d1117;background:#d29922;border-radius:999px;padding:2px 9px}
.note{color:#c9d1d9;font-size:14px;margin-top:6px}.meta{color:#8b949e;font-size:13px;margin-top:6px}
#empty{color:#8b949e;padding:30px 0;text-align:center}
</style>
<main><h1>Waiting on you</h1><div id="sub">Checking…</div><div id="list"></div><div id="empty" hidden>Nothing is waiting. This page updates by itself.</div></main>
<script>
(() => {
const base = location.pathname.replace(/\\/$/, '');
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
let last = '';
const draw = (items) => {
  const key = JSON.stringify(items);
  document.title = items.length ? '(' + items.length + ') ClikCode desk' : 'ClikCode desk';
  document.getElementById('sub').textContent = items.length ? items.length + (items.length === 1 ? ' tab is' : ' tabs are') + ' waiting. Tap one, finish it, tap Done.' : 'All clear.';
  document.getElementById('empty').hidden = items.length > 0;
  if (key === last) return;
  last = key;
  const list = document.getElementById('list');
  list.textContent = '';
  for (const item of items) {
    const a = el('a', 'item'); a.href = base + '/t/' + encodeURIComponent(item.id) + '/';
    const top = el('div', 'top'); top.append(el('span', 'label', item.label), el('span', 'kind', item.kind)); a.append(top);
    if (item.note) a.append(el('div', 'note', item.note));
    a.append(el('div', 'meta', (item.host ? item.host + ' · ' : '') + (item.minutes < 1 ? 'just now' : item.minutes + ' min')));
    list.append(a);
  }
};
const load = async () => {
  try { const r = await fetch(base + '/items', { cache: 'no-store' }); if (r.ok) draw(await r.json()); }
  catch (error) { document.getElementById('sub').textContent = 'Cannot reach this computer. Retrying…'; }
};
load(); setInterval(load, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
</script></html>`;
}

interface DeskDeps { stateDir: string; host: string; context: BrowserContext; port?: number; now?: () => number }

/** Serve the desk until `stop()`. Resolves once it listens; undefined when no port could be taken. */
export async function startHandoffDesk(deps: DeskDeps): Promise<{ address: string; stop(): Promise<void> } | undefined> {
  const { stateDir, context } = deps;
  const now = deps.now ?? Date.now;
  const token = await deskToken(stateDir);
  const views = new Map<string, { socket: LiteSocket; view: LiveView }>();

  const route = (request: IncomingMessage): { ok: boolean; rest: string } => {
    const [, first, rest] = /^\/([^/?]+)(\/[^?]*)?/.exec(request.url ?? '/') ?? [];
    return { ok: Boolean(first) && sameToken(first!, token), rest: rest ?? '/' };
  };
  const waiting = async (id: string): Promise<DeskItem | undefined> => (await listDeskItems(stateDir)).find(item => item.id === id);

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const { ok, rest } = route(request);
      if (!ok || request.method !== 'GET') { response.writeHead(404).end(); return; }
      response.setHeader('cache-control', 'no-store');
      const host = request.headers.host ?? '';
      const socketOrigin = /^[\w.:[\]-]{1,80}$/.test(host) ? ` ws://${host}` : '';
      const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'${socketOrigin}`;
      if (rest === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }).end(deskListPage()); return; }
      if (rest === '/items') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(deskListing(await listDeskItems(stateDir), now()))); return; }
      const tab = /^\/t\/([A-Za-z0-9_-]{6,40})(\/ping|\/)?$/.exec(rest);
      if (tab) {
        const item = await waiting(tab[1]!);
        // A finished or unknown item answers 410, which the live page reads as "this link has ended".
        if (!item || item.status !== 'waiting') { response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('This step is finished.'); return; }
        if (tab[2] === '/ping') { response.writeHead(204).end(); return; }
        if (tab[2] === undefined) { response.writeHead(302, { location: `/${token}/t/${item.id}/` }).end(); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }).end(handoffPage({ back: `/${token}/` }));
        return;
      }
      response.writeHead(404).end();
    })().catch(error => { quiet('agent/computer/handoff-desk')(error); if (!response.headersSent) response.writeHead(500); response.end(); });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { ok, rest } = route(request);
    const tab = /^\/t\/([A-Za-z0-9_-]{6,40})\/live$/.exec(rest);
    if (!ok || !tab) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const id = tab[1]!;
    void (async () => {
      const item = await waiting(id);
      if (!item || item.status !== 'waiting') { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return; }
      const page = (await pagesById(context)).get(item.targetId);
      if (!page) { await finishDeskItem(stateDir, id, 'closed', now()); socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return; }
      const accepted = acceptWebSocket(request, socket, head, { allowOrigin: origin => sameOrigin(origin, request.headers.host) });
      if (!accepted) return;
      // One phone per tab: a reload or a second device takes over from the one before.
      const before = views.get(id);
      views.delete(id);
      before?.socket.close(1000);
      await before?.view.stop();
      const view = new LiveView(page, accepted, () => {
        void finishDeskItem(stateDir, id, 'done', now()).then(() => lifecycle('handoff.desk.done', { id, label: item.label, kind: item.kind, waitedMs: now() - item.createdAt })).catch(quiet('agent/computer/handoff-desk'));
        if (!accepted.closed) accepted.send(JSON.stringify({ t: 'done' }));
        const mine = views.get(id);
        views.delete(id);
        setTimeout(() => { accepted.close(1000); void mine?.view.stop(); }, 80);
      });
      views.set(id, { socket: accepted, view });
      accepted.onClose(() => { if (views.get(id)?.socket === accepted) views.delete(id); });
      await view.start();
    })().catch(error => { quiet('agent/computer/handoff-desk')(error); socket.destroy(); });
  });

  const listen = (port: number): Promise<boolean> => new Promise(resolve => {
    const failed = (): void => { resolve(false); };
    server.once('error', failed);
    server.listen(port, deps.host, () => { server.off('error', failed); resolve(true); });
  });
  let up = false;
  for (const port of deps.port !== undefined ? [deps.port] : [DESK_PORT, DESK_PORT + 1, DESK_PORT + 2, 0]) if (await listen(port)) { up = true; break; }
  if (!up) return undefined;
  const port = (server.address() as AddressInfo).port;
  await writeDeskInfo(stateDir, { pid: process.pid, host: deps.host, port, token });
  const tidy = async (): Promise<void> => { await tidyDesk(stateDir, new Set((await pagesById(context)).keys()), now()); };
  const timer = setInterval(() => { void tidy().catch(quiet('agent/computer/handoff-desk')); }, TIDY_EVERY_MS);
  timer.unref();
  lifecycle('handoff.desk.up', { host: deps.host, port });
  return {
    address: `http://${deps.host}:${port}/${token}/`,
    async stop() {
      clearInterval(timer);
      for (const { socket, view } of views.values()) { socket.close(1001); await view.stop().catch(quiet('agent/computer/handoff-desk')); }
      views.clear();
      await clearDeskInfo(stateDir, process.pid);
      server.close();
      server.closeAllConnections();
    },
  };
}
