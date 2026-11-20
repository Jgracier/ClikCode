/** The network ways out ("egress") a browser tab can leave through: home (this computer's own connection), an `ssh -D` SOCKS tunnel
 * ClikCode keeps up to a host the user names, or a proxy used as is. Google's reCAPTCHA judges the connection, not the browser, and the
 * home connection is a shared carrier address it often refuses; a vendor stopped there is tried again through the next way out
 *
 * A tunnel is an ordinary ssh client in a process of its own, started the first time an egress is needed, reused while it lives,
 * started again when it has died, and ended (that one process, never a group) when the process that owns it exits. */
import { spawn as spawnChild } from 'node:child_process';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import fs from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { quiet } from '../../runtime/lifecycle-log.js';
import { pidIsAlive } from '../../session/store/locks.js';
import { sleep as sleepFor } from '../../runtime/sleep.js';
import { sharedState } from './shared-state.js';
import { egressList, HOME_EGRESS, type EgressEntry } from './settings.js';

/** Which egress each browser context made for one leaves through (browser.ts sets it when it makes the context). */
export const contextEgress = sharedState('browser-context-egress', () => new WeakMap<object, string>());

/** Pages a worker opened in a context the browser host owns (egress-host.ts): over a worker's CDP connection Playwright files them under
 * the default context, so the page itself carries its egress. */
export const pageEgress = sharedState('browser-page-egress', () => new WeakMap<object, string>());

/** The egress a page's traffic leaves through; undefined for home (and for the cloud browser). */
export function egressOfPage(page: { context(): object }): string | undefined {
  const own = pageEgress.get(page);
  if (own) return own;
  try { return contextEgress.get(page.context()); } catch { return undefined; }
}

/** What the tunnel manager needs of a child process. */
export interface TunnelChild {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
}

export interface TunnelDeps {
  spawn(command: string, args: string[]): TunnelChild;
  freePort(): Promise<number>;
  portOpen(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Registers what runs when the owning process exits. */
  onExit(run: () => void): void;
  /** How long a new tunnel may take to start listening. */
  readyMs?: number;
  /** A tunnel's record on disk (so one left by a process that was killed can be ended later), and its removal. */
  record?(child: TunnelChild, port: number, target: string): void;
  forget?(child: TunnelChild): void;
}

/** The ssh command line for a SOCKS tunnel on 127.0.0.1:port. The destination was checked (settings.ts egressProblem) and comes after `--`. */
export function sshTunnelArgs(port: number, target: string): string[] {
  return ['-N', '-D', `127.0.0.1:${port}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '--', target];
}

const alive = (child: TunnelChild): boolean => child.exitCode === null && !child.signalCode;

interface Tunnel { ready: Promise<number>; child?: TunnelChild }

/** One SOCKS tunnel per ssh destination, for this process. */
export class TunnelManager {
  private readonly tunnels = new Map<string, Tunnel>();
  private exitHooked = false;
  constructor(private readonly deps: TunnelDeps) {}

  /** The local SOCKS port of a live tunnel to `target`, starting one when there is none or it died. */
  ensure(target: string): Promise<number> {
    const existing = this.tunnels.get(target);
    if (existing && (!existing.child || alive(existing.child))) return existing.ready;
    if (existing?.child) this.deps.forget?.(existing.child);
    if (!this.exitHooked) { this.exitHooked = true; this.deps.onExit(() => this.closeAll()); }
    const tunnel: Tunnel = { ready: Promise.resolve(0) };
    tunnel.ready = this.start(target, tunnel);
    this.tunnels.set(target, tunnel);
    tunnel.ready.catch(() => { if (this.tunnels.get(target) === tunnel) this.tunnels.delete(target); });
    return tunnel.ready;
  }

  private async start(target: string, tunnel: Tunnel): Promise<number> {
    const port = await this.deps.freePort();
    const child = this.deps.spawn('ssh', sshTunnelArgs(port, target));
    tunnel.child = child;
    let said = '';
    child.stderr?.on('data', chunk => { said = (said + String(chunk)).slice(-400); });
    child.once('exit', () => { this.deps.forget?.(child); if (this.tunnels.get(target) === tunnel) this.tunnels.delete(target); });
    this.deps.record?.(child, port, target);
    const until = Date.now() + (this.deps.readyMs ?? 20_000);
    for (;;) {
      if (!alive(child)) throw new Error(`The ssh tunnel to ${target} ended before it was ready${said.trim() ? `: ${said.trim().split('\n').slice(-2).join(' ').slice(0, 240)}` : ''}.`);
      if (await this.deps.portOpen(port)) return port;
      if (Date.now() >= until) {
        child.kill('SIGTERM');
        throw new Error(`The ssh tunnel to ${target} did not start listening within ${Math.round((this.deps.readyMs ?? 20_000) / 1000)}s.`);
      }
      await this.deps.sleep(200);
    }
  }

  /** Ends every tunnel this process started (each ssh process alone). */
  closeAll(): void {
    for (const [target, tunnel] of this.tunnels) {
      this.tunnels.delete(target);
      if (tunnel.child && alive(tunnel.child)) { try { tunnel.child.kill('SIGTERM'); } catch { /* fail-open-ok: it is already gone */ } }
      if (tunnel.child) this.deps.forget?.(tunnel.child);
    }
  }
}

// ── the live tunnel manager ──

const tunnelDir = (stateDir: string): string => path.join(stateDir, 'computer', 'egress-tunnels');

/** Free a TCP port on 127.0.0.1 by asking the system for one. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('No free port.'))));
    });
  });
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect({ host, port });
    const done = (open: boolean): void => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

/** A tunnel left behind by a process that was killed before it could end it: its ssh process is ended when it is still that tunnel. */
async function sweepStaleTunnels(stateDir: string): Promise<void> {
  const dir = tunnelDir(stateDir);
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name);
    const record = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw) as { pid?: number; owner?: number; port?: number }).catch(quiet('agent/computer/egress'));
    if (!record || !Number.isSafeInteger(record.pid) || (record.owner && pidIsAlive(record.owner))) { if (!record) await fs.unlink(file).catch(quiet('agent/computer/egress')); continue; }
    let command = '';
    try { command = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { command = ''; }
    if (record.pid! > 1 && pidIsAlive(record.pid!) && /\bssh\b/.test(command) && command.includes(`-D 127.0.0.1:${record.port}`)) {
      try { process.kill(record.pid!, 'SIGTERM'); } catch { /* fail-open-ok: it ended in between */ }
    }
    await fs.unlink(file).catch(quiet('agent/computer/egress'));
  }
}

function liveTunnelDeps(stateDir: string): TunnelDeps {
  const dir = tunnelDir(stateDir);
  return {
    spawn: (command, args) => spawnChild(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
    freePort, portOpen: port => portOpen(port), sleep: sleepFor,
    onExit: run => { process.once('exit', run); },
    record: (child, port, target) => {
      if (!child.pid) return;
      void fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => fs.writeFile(path.join(dir, `${child.pid}.json`), `${JSON.stringify({ pid: child.pid, owner: process.pid, port, target, at: new Date().toISOString() })}\n`, { mode: 0o600 })).catch(quiet('agent/computer/egress'));
    },
    // Synchronous: it also runs from the exit hook.
    forget: child => { if (child.pid) { try { unlinkSync(path.join(dir, `${child.pid}.json`)); } catch { /* fail-open-ok: never written, or already removed */ } } },
  };
}

const managers = sharedState('egress-tunnel-managers', () => new Map<string, TunnelManager>());
export function tunnelManager(stateDir: string): TunnelManager {
  let manager = managers.get(stateDir);
  if (!manager) {
    manager = new TunnelManager(liveTunnelDeps(stateDir));
    managers.set(stateDir, manager);
    void sweepStaleTunnels(stateDir).catch(quiet('agent/computer/egress'));
  }
  return manager;
}

/** The proxy server a browser context uses for this egress (`socks5://127.0.0.1:<port>` for an ssh one); undefined for home. */
export async function egressServer(stateDir: string, name: string, tunnels: Pick<TunnelManager, 'ensure'> = tunnelManager(stateDir)): Promise<string | undefined> {
  if (name === HOME_EGRESS) return undefined;
  const entry = (await egressList(stateDir)).find(item => item.name === name);
  if (!entry) throw new Error(`No egress is named "${name}". \`clikcode computer egress list\` shows them.`);
  return serverFor(entry, tunnels);
}

export async function serverFor(entry: EgressEntry, tunnels: Pick<TunnelManager, 'ensure'>): Promise<string | undefined> {
  if (entry.proxy) return entry.proxy;
  if (entry.ssh) return `socks5://127.0.0.1:${await tunnels.ensure(entry.ssh)}`;
  return undefined;
}

// ── reading a page through an egress, for `clikcode computer egress check` ──

/** Reads exactly what the other end sends until `enough` says the buffer is complete. */
function readUntil(socket: Socket, enough: (buffer: Buffer) => boolean, ms: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('The proxy did not answer in time.')), ms);
    const onData = (chunk: Buffer): void => { buffer = Buffer.concat([buffer, chunk]); if (enough(buffer)) finish(); };
    const onEnd = (): void => finish(enough(buffer) ? undefined : new Error('The proxy closed the connection.'));
    const onError = (error: Error): void => finish(error);
    function finish(error?: Error): void {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError);
      // Whatever comes next waits for the next reader (the TLS layer, or readAll) instead of being dropped.
      socket.pause();
      if (error) reject(error); else resolve(buffer);
    }
    socket.on('data', onData); socket.once('end', onEnd); socket.once('error', onError);
    socket.resume();
  });
}

function connected(socket: Socket, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Could not reach the proxy in time.')); }, ms);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** A TCP connection to host:port through the proxy server (socks5, socks4 or an http CONNECT proxy). */
export async function tunnelThrough(server: string, host: string, port: number, ms = 15_000): Promise<Socket> {
  const proxy = new URL(server);
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : proxy.protocol === 'http:' ? 80 : 1080);
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
  const socket = proxy.protocol === 'https:' ? tlsConnect({ host: proxyHost, port: proxyPort, servername: proxyHost }) : netConnect({ host: proxyHost, port: proxyPort });
  try {
    await connected(socket, ms);
    if (proxy.protocol === 'socks5:') {
      socket.write(Buffer.from([5, 1, 0]));
      const hello = await readUntil(socket, b => b.length >= 2, ms);
      if (hello[0] !== 5 || hello[1] !== 0) throw new Error('The SOCKS proxy wants a sign-in ClikCode does not have.');
      const name = Buffer.from(host);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
      const reply = await readUntil(socket, b => b.length >= 5 && b.length >= (b[3] === 1 ? 10 : b[3] === 4 ? 22 : 7 + b[4]!), ms);
      if (reply[1] !== 0) throw new Error(`The SOCKS proxy could not connect to ${host} (code ${reply[1]}).`);
    } else if (proxy.protocol === 'socks4:') {
      socket.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, 0, 0, 0, 1, 0]), Buffer.from(host), Buffer.from([0])]));
      const reply = await readUntil(socket, b => b.length >= 8, ms);
      if (reply[1] !== 0x5a) throw new Error(`The SOCKS proxy could not connect to ${host}.`);
    } else {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      const head = (await readUntil(socket, b => b.includes('\r\n\r\n'), ms)).toString('latin1');
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) throw new Error(`The proxy refused to connect to ${host}: ${head.split('\r\n')[0]?.slice(0, 80)}`);
    }
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

/** The body of a GET, through `server` (undefined: direct). Small pages only (an address check). */
export async function fetchVia(server: string | undefined, url: string, ms = 15_000): Promise<string> {
  if (!server) {
    const reply = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!reply.ok) throw new Error(`${new URL(url).host} answered ${reply.status}.`);
    return (await reply.text()).trim();
  }
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const raw = await tunnelThrough(server, target.hostname, port, ms);
  const socket: Socket = secure ? tlsConnect({ socket: raw, servername: target.hostname }) : raw;
  try {
    if (secure) await connected(socket, ms);
    socket.write(`GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\nUser-Agent: clikcode-egress-check\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
    return parseHttp((await readAll(socket, ms)).toString('utf8'), target.host);
  } finally { socket.destroy(); raw.destroy(); }
}

/** Everything the other end sends until it closes the connection (an HTTP/1.0 answer ends so). */
function readAll(socket: Socket, ms: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('The page did not finish in time.')); }, ms);
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.resume();
  });
}

function parseHttp(text: string, host: string): string {
  const split = text.indexOf('\r\n\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1];
  if (!status || split < 0) throw new Error(`${host} sent no HTTP answer.`);
  if (status !== '200') throw new Error(`${host} answered ${status}.`);
  return text.slice(split + 4).trim();
}

export interface EgressCheck { name: string; via: string; ok: boolean; ip?: string; error?: string; ms: number }

/** Opens each way out and reads the public address the internet sees through it. */
export async function checkEgress(stateDir: string, options: { url?: string; tunnels?: Pick<TunnelManager, 'ensure'>; fetch?: typeof fetchVia } = {}): Promise<EgressCheck[]> {
  const url = options.url ?? 'https://api.ipify.org';
  const tunnels = options.tunnels ?? tunnelManager(stateDir);
  const read = options.fetch ?? fetchVia;
  const out: EgressCheck[] = [];
  for (const entry of await egressList(stateDir)) {
    const began = Date.now();
    const via = entry.ssh ? `ssh ${entry.ssh}` : entry.proxy ? `proxy ${entry.proxy}` : 'this computer\'s own connection';
    try {
      const server = await serverFor(entry, tunnels);
      const body = await read(server, url);
      const ip = body.split(/\s+/)[0]?.slice(0, 64) ?? '';
      const looksLikeIp = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(ip);
      out.push({ name: entry.name, via, ok: looksLikeIp, ...(looksLikeIp ? { ip } : { error: `unexpected answer: ${body.slice(0, 60)}` }), ms: Date.now() - began });
    } catch (error) {
      out.push({ name: entry.name, via, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 240), ms: Date.now() - began });
    }
  }
  return out;
}
