/** Egress contexts owned by the browser host, the process that owns Chrome and outlives every worker. It keeps the ssh tunnels and one
 * browser context per egress for its whole life, so a vendor's sign-in on an egress survives the worker that made it: keygrab in the loop
 * and an agent's MCP server (another process) share one context and its cookies.
 *
 * Why the host, and why raw CDP: Playwright makes its own contexts with `disposeOnDetach: true` (Chrome drops them when the connection that
 * made them closes), so a context a worker made died with that worker. The host makes them with `Target.createBrowserContext` and
 * `disposeOnDetach: false` over its own browser-level CDP socket; they last until Chrome exits (a recycle starts a new host, which makes
 * them again on the first request). Workers ask over a local socket named in host.json, get the context's id, and open pages in it with
 * `Target.createTarget` (browser.ts). */
import { createServer, connect as netConnect, type Server } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { egressServer, tunnelManager, type TunnelManager } from './egress.js';

/** What the host needs of Chrome: browser-level CDP commands. */
export interface BrowserCdp { send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }

export interface HostedContext { id: string; server: string }

/** The host's egress contexts: made on first request, reused while their proxy is current and Chrome still has them. */
export class EgressContexts {
  private readonly held = new Map<string, Promise<HostedContext>>();
  constructor(private readonly cdp: () => Promise<BrowserCdp>, private readonly server: (name: string) => Promise<string | undefined>) {}

  ensure(name: string): Promise<HostedContext> {
    const previous = this.held.get(name);
    const next = (async (): Promise<HostedContext> => {
      const old = await previous?.catch(quiet('agent/computer/egress-host'));
      const server = await this.server(name);
      if (!server) throw new Error(`"${name}" is this computer's own connection: it needs no context.`);
      const cdp = await this.cdp();
      if (old && old.server === server && await this.exists(cdp, old.id)) return old;
      // A tunnel started again listens on a new port: pages on the old context could reach nothing, so it goes.
      if (old) await cdp.send('Target.disposeBrowserContext', { browserContextId: old.id }).catch(quiet('agent/computer/egress-host'));
      const made = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false, proxyServer: server });
      const id = typeof made.browserContextId === 'string' ? made.browserContextId : '';
      if (!id) throw new Error('Chrome did not make the egress context.');
      lifecycle('browser.egress.context', { egress: name, host: true });
      return { id, server };
    })();
    // One request at a time per egress: a second waits for the first and reuses what it made.
    this.held.set(name, next);
    next.catch(() => { if (this.held.get(name) === next) this.held.delete(name); });
    return next;
  }

  /** Opens a page at `url` in the egress's context; its target id. */
  async openPage(name: string, url: string): Promise<string | undefined> {
    const { id } = await this.ensure(name);
    const made = await (await this.cdp()).send('Target.createTarget', { url, browserContextId: id });
    return typeof made.targetId === 'string' ? made.targetId : undefined;
  }

  private async exists(cdp: BrowserCdp, id: string): Promise<boolean> {
    const listed = await cdp.send('Target.getBrowserContexts').catch(quiet('agent/computer/egress-host'));
    return Array.isArray(listed?.browserContextIds) ? (listed.browserContextIds as unknown[]).includes(id) : true;
  }
}

/** A browser-level CDP connection over Chrome's own debugging socket (DevToolsActivePort), with no page attached: the host's
 * Playwright context is a persistent one, which has no Browser to open a browser session on. Reconnects when it closed. */
export function rawBrowserCdp(profile: string): () => Promise<BrowserCdp> {
  let open: Promise<BrowserCdp> | undefined;
  return () => {
    open ??= (async () => {
      const [port, route] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      const socket = new WebSocket(`ws://127.0.0.1:${Number(port)}${route?.trim()}`);
      await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Could not reach Chrome\'s debugging socket.')), { once: true }); });
      let next = 0;
      const waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
      socket.addEventListener('message', event => {
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
        const pending = message.id !== undefined ? waiting.get(message.id) : undefined;
        if (!pending) return;
        waiting.delete(message.id!);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP error')); else pending.resolve(message.result ?? {});
      });
      socket.addEventListener('close', () => { open = undefined; for (const pending of waiting.values()) pending.reject(new Error('Chrome\'s debugging socket closed.')); waiting.clear(); });
      return {
        send: (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++next;
          waiting.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { if (waiting.delete(id)) reject(new Error(`Chrome did not answer ${method} in time.`)); }, 20_000).unref?.();
        }),
      };
    })();
    open.catch(() => { open = undefined; });
    return open;
  };
}

/** The socket the host serves egress requests on (one per host process, named in host.json). */
export function egressSocketPath(stateDir: string, pid = process.pid): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\clikcode-egress-${pid}` : path.join(stateDir, 'computer', `egress-${pid}.sock`);
}

/** Opens (or finds) the separate persistent profile `name` and answers with its Chrome's local debugging port. */
export type SeparateProfileOpener = (name: string) => Promise<{ port: number }>;

/** Serves `{"egress":"<name>"}` lines with `{"id":"<browserContextId>","server":"..."}`, and `{"profile":"<name>"}` lines with
 * `{"port":<n>}`; either may be `{"error":"..."}`. */
export async function serveEgress(socketPath: string, contexts: Pick<EgressContexts, 'ensure'>, openProfile?: SeparateProfileOpener): Promise<{ stop(): Promise<void> }> {
  if (process.platform !== 'win32') await fs.unlink(socketPath).catch(quiet('agent/computer/egress-host'));
  const server: Server = createServer(client => {
    let buffer = '';
    // One request per connection: the first line is answered and the connection ended; whatever follows it is not read (a second line
    // used to start a second ensure and a second end on a socket already ending).
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > 4_096) client.destroy(); return; }
      client.off('data', onData);
      let asked: { egress?: unknown; profile?: unknown } = {};
      try { asked = JSON.parse(buffer.slice(0, end)) as typeof asked; } catch { asked = {}; }
      buffer = '';
      const forProfile = asked !== null && typeof asked === 'object' && asked.profile !== undefined;
      const name = String((forProfile ? asked.profile : asked?.egress) ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) { client.end(`${JSON.stringify({ error: `${forProfile ? 'A profile' : 'An egress'} name is lower-case letters, digits and dashes.` })}\n`); return; }
      if (forProfile && !openProfile) { client.end(`${JSON.stringify({ error: 'This browser host does not open separate profiles.' })}\n`); return; }
      void (forProfile ? openProfile!(name) : contexts.ensure(name)).then(
        held => client.end(`${JSON.stringify(held)}\n`),
        (error: unknown) => client.end(`${JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })}\n`),
      );
    };
    client.on('data', onData);
    client.on('error', quiet('agent/computer/egress-host'));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  if (process.platform !== 'win32') await fs.chmod(socketPath, 0o600).catch(quiet('agent/computer/egress-host'));
  return {
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') await fs.unlink(socketPath).catch(quiet('agent/computer/egress-host'));
    },
  };
}

/** The host's egress service: tunnels, contexts and the socket. */
export async function startEgressService(stateDir: string, profile: string, tunnels: TunnelManager = tunnelManager(stateDir), openProfile?: SeparateProfileOpener): Promise<{ socket: string; contexts: EgressContexts; stop(): Promise<void> }> {
  const contexts = new EgressContexts(rawBrowserCdp(profile), name => egressServer(stateDir, name, tunnels));
  const socket = egressSocketPath(stateDir);
  const served = await serveEgress(socket, contexts, openProfile);
  return { socket, contexts, stop: async () => { await served.stop(); tunnels.closeAll(); } };
}

/** Thrown when no host of this build serves egress contexts (an older host, or none): the caller may make its own context instead. */
export class EgressNotServed extends Error {}

type HostFileReader = () => Promise<string>;
const readHostJson = (stateDir: string): HostFileReader => () => fs.readFile(path.join(stateDir, 'computer', 'host.json'), 'utf8');

/** One request line to the host's socket and its one JSON answer. */
async function askHost(readHostFile: HostFileReader, request: Record<string, string>, ms: number, late: string): Promise<Record<string, unknown>> {
  let socketPath: string | undefined;
  try { socketPath = (JSON.parse(await readHostFile()) as { egressSocket?: unknown }).egressSocket as string | undefined; } catch { socketPath = undefined; }
  if (typeof socketPath !== 'string' || !socketPath) throw new EgressNotServed('The browser host does not serve egress contexts.');
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const client = netConnect(socketPath!);
    let reply = '';
    let connected = false;
    const timer = setTimeout(() => { client.destroy(); reject(new Error(late)); }, ms);
    client.once('connect', () => { connected = true; client.write(`${JSON.stringify(request)}\n`); });
    client.on('data', chunk => { reply += String(chunk); });
    client.once('end', () => {
      clearTimeout(timer);
      let answer: Record<string, unknown>;
      try { answer = JSON.parse(reply.trim()) as Record<string, unknown>; } catch { reject(new Error('The browser host gave no answer.')); return; }
      if (typeof answer.error === 'string' && answer.error) reject(new Error(answer.error));
      else resolve(answer);
    });
    client.once('error', error => { clearTimeout(timer); reject(connected ? error : new EgressNotServed(`The browser host does not serve egress contexts (${(error as NodeJS.ErrnoException).code ?? error.message}).`)); });
  });
}

/** Asks the browser host for the context of `name`. */
export async function requestHostedContext(stateDir: string, name: string, readHostFile: HostFileReader = readHostJson(stateDir), ms = 30_000): Promise<HostedContext> {
  const answer = await askHost(readHostFile, { egress: name }, ms, `The browser host did not open the egress "${name}" in time.`);
  if (typeof answer.id === 'string' && answer.id && typeof answer.server === 'string' && answer.server) return { id: answer.id, server: answer.server };
  throw new Error('The browser host gave no egress context.');
}

/** Asks the browser host to open (or find) the separate persistent profile `name`; answers its Chrome's local debugging port. */
export async function requestSeparateProfile(stateDir: string, name: string, readHostFile: HostFileReader = readHostJson(stateDir), ms = 60_000): Promise<number> {
  const answer = await askHost(readHostFile, { profile: name }, ms, `The browser host did not open the profile "${name}" in time.`);
  if (typeof answer.port === 'number' && Number.isInteger(answer.port) && answer.port > 0) return answer.port;
  throw new Error('The browser host gave no profile port.');
}
