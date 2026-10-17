/** Private login collection over Tailcat; only an opaque vault id returns to the model. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { tailcatBinary } from './tailcat-binary.js';
import { saveCredential } from './credential-vault.js';

const PAGE_URL = 'https://jgracier.github.io/ClikCode/handoff/';
const TEN_MINUTES = 10 * 60_000;

export async function requestTailcatCredential(input: {
  stateDir: string; site: string; signal?: AbortSignal; onLink(link: string): void; pageUrl?: string;
}): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  let active: Socket | undefined;
  let authorized = false;
  let complete!: (id: string) => void;
  let fail!: (error: Error) => void;
  const finished = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
  void finished.catch(() => undefined);
  const server = createServer(socket => {
    if (active) { socket.destroy(); return; }
    active = socket;
    let pending = '';
    let saving = false;
    const authDeadline = setTimeout(() => { if (!authorized) socket.destroy(); }, 10_000);
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 10_000) { socket.destroy(); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        void (async () => {
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; }
          catch { socket.destroy(); return; }
          const actual = message.token;
          if (typeof actual !== 'string' || actual.length !== token.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(token))) { socket.destroy(); return; }
          if (!authorized) {
            if (message.type !== 'hello') { socket.destroy(); return; }
            authorized = true;
            clearTimeout(authDeadline);
            return;
          }
          if (saving) return;
          if (message.type !== 'credential') { socket.destroy(); return; }
          const { accountId, email, password } = message;
          if (typeof accountId !== 'string' || accountId.length > 500 || typeof email !== 'string' || email.length > 500
            || typeof password !== 'string' || password.length > 2_000 || (!email && !accountId) || !password) { socket.destroy(); return; }
          saving = true;
          try {
            const id = await saveCredential(input.stateDir, input.site, { accountId, email, password });
            socket.write('{"type":"saved"}\n');
            await pause(300);
            complete(id);
          } catch { socket.destroy(); fail(new Error('Could not save the login securely.')); }
        })();
      }
    });
    socket.on('close', () => {
      clearTimeout(authDeadline);
      if (active === socket) {
        if (authorized && !saving) fail(new Error('The private login connection closed. Ask ClikCode for a new link.'));
        active = undefined;
        authorized = false;
      }
    });
    socket.on('error', () => undefined);
  });
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
  void abort.catch(() => undefined);
  const onAbort = () => { child?.kill(); rejectAbort(new Error('Private login request stopped.')); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    const binary = await Promise.race([tailcatBinary(input.stateDir), abort]);
    const started = new Promise<string>((resolve, reject) => {
      child = spawn(binary, ['serve', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      const startup = setTimeout(() => { child?.kill(); reject(new Error('Tailcat did not start.')); }, 30_000);
      const scan = (data: Buffer) => {
        output = `${output}${data.toString('utf8')}`.slice(-4000);
        const address = output.match(/\btc[A-Za-z0-9_-]{20,}/)?.[0];
        if (address) { clearTimeout(startup); resolve(address); }
      };
      child.stdout?.on('data', scan);
      child.stderr?.on('data', scan);
      child.once('error', () => { clearTimeout(startup); reject(new Error('Tailcat could not start.')); });
      child.once('exit', () => { clearTimeout(startup); reject(new Error('Tailcat disconnected.')); });
    });
    const address = await Promise.race([started, abort]);
    const fragment = new URLSearchParams({ addr: address, token, port: String(port), mode: 'credential', site: input.site });
    input.onLink(`${input.pageUrl ?? PAGE_URL}#${fragment}`);
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Private login request expired.')), TEN_MINUTES); });
    const exited = new Promise<never>((_, reject) => child!.once('exit', () => reject(new Error('Tailcat disconnected.'))));
    return await Promise.race([finished, timeout, abort, exited]);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    child?.kill();
    active?.destroy();
    server.close();
  }
}
