/** Handoff over the user's own Tailscale network, for a phone that is on it: a tiny web page on the
 * computer's Tailscale address (and nowhere else) shows this chat's tab and takes taps and typing.
 * No relay, no WebAssembly, no third-party host; a random path is the one-use secret and the
 * link stops working after ten minutes or once the user says they are done. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { computerPage } from './browser.js';

const TEN_MINUTES = 10 * 60_000;
type Action = { type?: string; x?: number; y?: number; text?: string; key?: string; direction?: string };

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

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Finish in ClikCode</title>
<style>body{font:16px system-ui,sans-serif;margin:0;background:#10151c;color:#f2f5f8}main{max-width:900px;margin:auto;padding:12px}img{width:100%;border:1px solid #505c68;border-radius:8px;touch-action:manipulation}
button,input{font:inherit;min-height:44px;box-sizing:border-box}button{background:#263443;color:#fff;border:1px solid #65788b;border-radius:8px;padding:0 14px}input{flex:1;min-width:0;background:#1a222c;color:#fff;border:1px solid #65788b;border-radius:8px;padding:0 10px}
#controls{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}</style>
<main><h1>Finish in ClikCode</h1><p id="status">Loading…</p><img id="screen" alt="ClikCode browser">
<div id="controls"><input id="entry" autocomplete="off" autocapitalize="off"><button id="type">Type</button><button id="enter">Enter</button><button id="tab">Tab</button><button id="up">Up</button><button id="down">Down</button><button id="done">Done</button></div></main>
<script>
const $=id=>document.getElementById(id);const base=location.pathname.replace(/\\/$/,'');
const act=a=>fetch(base+'/act',{method:'POST',body:JSON.stringify(a)}).catch(()=>$('status').textContent='The connection was lost. Ask ClikCode for a new link.');
let busy=false;async function frame(){if(busy)return;busy=true;try{const r=await fetch(base+'/frame.jpg?'+Date.now());if(r.status===410){$('status').textContent='Done. ClikCode will continue.';return}
if(r.ok){const u=URL.createObjectURL(await r.blob());const old=$('screen').src;$('screen').src=u;if(old.startsWith('blob:'))URL.revokeObjectURL(old);$('status').textContent='Tap the browser, type, or press Done when finished.'}}catch{}busy=false;setTimeout(frame,900)}
$('screen').onclick=e=>{const i=$('screen'),b=i.getBoundingClientRect();act({type:'click',x:Math.round((e.clientX-b.left)*i.naturalWidth/b.width),y:Math.round((e.clientY-b.top)*i.naturalHeight/b.height)})};
$('type').onclick=()=>{act({type:'type',text:$('entry').value});$('entry').value=''};
$('enter').onclick=()=>act({type:'key',key:'Enter'});$('tab').onclick=()=>act({type:'key',key:'Tab'});
$('up').onclick=()=>act({type:'scroll',direction:'up'});$('down').onclick=()=>act({type:'scroll',direction:'down'});
$('done').onclick=()=>{act({type:'done'});$('status').textContent='Finishing…'};
frame();
</script></html>`;

function sameToken(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function runTailnetHandoff(input: {
  stateDir: string; host: string; tab?: string; signal?: AbortSignal; onLink(link: string): void;
}): Promise<void> {
  const token = randomBytes(24).toString('base64url');
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let over = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://x');
      const [, first, rest] = /^\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
      if (!first || !sameToken(first, token)) { response.writeHead(404).end(); return; }
      if (over) { response.writeHead(410).end(); return; }
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET' && (!rest || rest === '/')) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
      const page = await computerPage(input.stateDir, input.tab);
      if (request.method === 'GET' && rest === '/frame.jpg') {
        let image = await page.screenshot({ type: 'jpeg', quality: 50, scale: 'css', timeout: 10_000 });
        if (image.length > 900_000) image = await page.screenshot({ type: 'jpeg', quality: 28, scale: 'css', timeout: 10_000 });
        response.writeHead(200, { 'content-type': 'image/jpeg' }).end(image);
        return;
      }
      if (request.method === 'POST' && rest === '/act') {
        let body = '';
        for await (const chunk of request) { body += String(chunk); if (body.length > 5_000) { response.writeHead(413).end(); return; } }
        const action = JSON.parse(body) as Action;
        if (action.type === 'done') { over = true; response.writeHead(204).end(); finish(); return; }
        if (action.type === 'click' && Number.isFinite(action.x) && Number.isFinite(action.y) && action.x! >= 0 && action.y! >= 0) await page.mouse.click(action.x!, action.y!);
        else if (action.type === 'type' && typeof action.text === 'string' && action.text.length <= 1000) await page.keyboard.insertText(action.text);
        else if (action.type === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape'].includes(action.key ?? '')) await page.keyboard.press(action.key!);
        else if (action.type === 'scroll' && ['up', 'down'].includes(action.direction ?? '')) await page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
        else { response.writeHead(400).end(); return; }
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => { input.signal?.addEventListener('abort', () => reject(new Error('Handoff stopped.')), { once: true }); });
  stopped.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, input.host, () => { server.off('error', reject); resolve(); }); });
    const port = (server.address() as AddressInfo).port;
    input.onLink(`http://${input.host}:${port}/${token}/`);
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The phone handoff expired after 10 minutes.')), TEN_MINUTES); });
    await Promise.race([finished, expired, stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
