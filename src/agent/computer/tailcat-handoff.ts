/** One-use browser handoff over Tailcat. The remote page only gets this browser. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { computerPage } from './browser.js';
import { sniffImage } from '../images.js';
import { tailcatBinary } from './tailcat-binary.js';

const TEN_MINUTES = 10 * 60_000;
const PAGE_URL = 'https://jgracier.github.io/ClikCode/handoff/';
type Action = { type: string; token?: string; x?: number; y?: number; text?: string; key?: string; direction?: string };

function startTailcat(binary: string, port: number): Promise<{ child: ChildProcess; address: string }> {
  const child = spawn(binary, ['serve', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Tailcat did not start.')); }, 30_000);
    const scan = (data: Buffer) => {
      output = `${output}${data.toString('utf8')}`.slice(-4000);
      const address = output.match(/\btc[A-Za-z0-9_-]{20,}/)?.[0];
      if (address) { clearTimeout(timer); resolve({ child, address }); }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Tailcat could not start.')); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Tailcat exited before the handoff was ready (${code}).`)); });
  });
}

function validToken(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export async function runTailcatHandoff(input: {
  stateDir: string;
  signal?: AbortSignal;
  onLink(link: string): void;
  pageUrl?: string;
}): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  let active: Socket | undefined;
  let authenticated = false;
  let frameSize = { width: 0, height: 0 };
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(socket => {
    if (active) { socket.destroy(); return; }
    active = socket;
    authenticated = false;
    socket.setNoDelay(true);
    const authDeadline = setTimeout(() => { if (!authenticated) socket.destroy(); }, 10_000);
    let pending = '';
    let actions: Promise<unknown> = Promise.resolve();
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 5_000) { socket.destroy(); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        actions = actions.then(async () => {
          let action: Action;
          try { action = JSON.parse(line) as Action; } catch { socket.destroy(); return; }
          if (!validToken(action.token, token)) { socket.destroy(); return; }
          if (!authenticated) {
            if (action.type !== 'hello') { socket.destroy(); return; }
            authenticated = true;
            clearTimeout(authDeadline);
            return;
          }
          if (action.type === 'done') { finish(); return; }
          const page = await computerPage(input.stateDir);
          if (action.type === 'click' && Number.isFinite(action.x) && Number.isFinite(action.y)
            && action.x! >= 0 && action.y! >= 0 && action.x! < frameSize.width && action.y! < frameSize.height)
            await page.mouse.click(action.x!, action.y!);
          else if (action.type === 'type' && typeof action.text === 'string' && action.text.length <= 1000)
            await page.keyboard.insertText(action.text);
          else if (action.type === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape'].includes(action.key ?? ''))
            await page.keyboard.press(action.key!);
          else if (action.type === 'scroll' && ['up', 'down'].includes(action.direction ?? ''))
            await page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
          else socket.destroy();
        }).catch(() => socket.destroy());
      }
    });
    socket.on('close', () => {
      clearTimeout(authDeadline);
      if (active === socket) { active = undefined; authenticated = false; }
    });
    socket.on('error', () => undefined);
  });
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stopped = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('Handoff stopped.'));
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    const binary = await tailcatBinary(input.stateDir);
    const started = await startTailcat(binary, port);
    child = started.child;
    const fragment = new URLSearchParams({ addr: started.address, token, port: String(port) });
    input.onLink(`${input.pageUrl ?? PAGE_URL}#${fragment}`);
    const frames = (async () => {
      while (!stopped.signal.aborted) {
        if (input.signal?.aborted) throw new Error('Handoff stopped.');
        const socket = active;
        if (socket && authenticated && socket.writableLength < 1_000_000) {
          const page = await computerPage(input.stateDir);
          let image = await page.screenshot({ type: 'jpeg', quality: 45, scale: 'css', timeout: 10_000 });
          if (image.length > 750_000) image = await page.screenshot({ type: 'jpeg', quality: 25, scale: 'css', timeout: 10_000 });
          if (image.length > 750_000) throw new Error('Browser view is too large for phone handoff.');
          const size = sniffImage(image);
          if (!size?.width || !size.height) throw new Error('Could not size browser view.');
          frameSize = { width: size.width, height: size.height };
          socket.write(`${JSON.stringify({ type: 'frame', data: image.toString('base64'), width: size.width, height: size.height })}\n`);
        }
        await pause(1100, undefined, { signal: stopped.signal });
      }
    })();
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The phone handoff expired after 10 minutes.')), TEN_MINUTES); });
    const exited = new Promise<never>((_, reject) => child!.once('exit', () => reject(new Error('Tailcat disconnected.'))));
    await Promise.race([finished, frames, timeout, abort, exited]);
    if (active && !active.destroyed) active.write('{"type":"done"}\n');
  } finally {
    stopped.abort();
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    child?.kill();
    active?.destroy();
    server.close();
  }
}
