/** Egress: the settings list, the ssh tunnel manager (a fake spawn, no real ssh), the proxied fetch the check uses, and per-vendor choice. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp, connect as netConnect, type AddressInfo, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { addEgress, egressList, egressProblem, egressSetting, parseEgress, removeEgress } from './settings.js';
import { checkEgress, egressServer, egressTimeZone, fetchVia, sshTunnelArgs, TunnelManager, type TunnelChild, type TunnelDeps } from './egress.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-egress-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('egress setting', () => {
  it('is home alone until one is added; home is always first and never stored', async () => {
    expect(await egressList(dir)).toEqual([{ name: 'home' }]);
    await addEgress(dir, { name: 'prod', ssh: 'clikdeploy-prod-direct' });
    await addEgress(dir, { name: 'phone', proxy: 'socks5://100.64.0.9:1080/' });
    expect(await egressList(dir)).toEqual([{ name: 'home' }, { name: 'prod', ssh: 'clikdeploy-prod-direct' }, { name: 'phone', proxy: 'socks5://100.64.0.9:1080' }]);
    // The same name again replaces it in place.
    await addEgress(dir, { name: 'prod', ssh: 'root@157.173.195.175' });
    expect((await egressSetting(dir)).map(e => e.ssh ?? e.proxy)).toEqual(['root@157.173.195.175', 'socks5://100.64.0.9:1080']);
    expect(await removeEgress(dir, 'phone')).toBe(true);
    expect(await removeEgress(dir, 'phone')).toBe(false);
    expect(await egressSetting(dir)).toEqual([{ name: 'prod', ssh: 'root@157.173.195.175' }]);
  });

  it('keeps the other settings in the file', async () => {
    await fs.mkdir(path.join(dir, 'computer'), { recursive: true });
    await fs.writeFile(path.join(dir, 'computer', 'settings.json'), JSON.stringify({ headless: true }));
    await addEgress(dir, { name: 'prod', ssh: 'prod' });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'computer', 'settings.json'), 'utf8'))).toEqual({ headless: true, egress: [{ name: 'prod', ssh: 'prod' }] });
  });

  it.each([
    [{ name: 'home', ssh: 'x' }, /always there/],
    [{ name: 'Bad Name', ssh: 'x' }, /lower-case/],
    [{ name: 'a' }, /either ssh/],
    [{ name: 'a', ssh: 'x', proxy: 'socks5://h:1' }, /either ssh/],
    [{ name: 'a', ssh: '-oProxyCommand=evil' }, /ssh is a host/],
    [{ name: 'a', ssh: 'user@host; rm -rf' }, /ssh is a host/],
    [{ name: 'a', proxy: 'ftp://h:21' }, /proxy is/],
    [{ name: 'a', proxy: 'socks5://h' }, /proxy is/],
    [{ name: 'a', proxy: 'socks5://h:70000' }, /port/],
  ])('refuses %j', async (entry, why) => {
    expect(egressProblem(entry)).toMatch(why);
    await expect(addEgress(dir, entry as never)).rejects.toThrow(why);
  });

  it('reads only valid entries, first of each name', () => {
    expect(parseEgress([{ name: 'a', ssh: 'h' }, { name: 'a', ssh: 'other' }, { name: 'b' }, 'x', null, { name: 'c', proxy: 'http://p:8080' }])).toEqual([{ name: 'a', ssh: 'h' }, { name: 'c', proxy: 'http://p:8080' }]);
    expect(parseEgress('nope')).toEqual([]);
  });
});

/** A child process that does what the test says. */
class FakeChild extends EventEmitter implements TunnelChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  stderr = new EventEmitter();
  constructor(readonly pid: number) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); this.die(null, signal); return true; }
  die(code: number | null, signal: NodeJS.Signals | null = null): void { this.exitCode = code; this.signalCode = signal; this.emit('exit'); }
}

function tunnelFakes(over: Partial<TunnelDeps> = {}) {
  const spawned: Array<{ command: string; args: string[]; child: FakeChild }> = [];
  const listening = new Set<number>();
  let nextPort = 40_000, nextPid = 500;
  const exits: Array<() => void> = [];
  const deps: TunnelDeps = {
    spawn: (command, args) => { const child = new FakeChild(nextPid++); spawned.push({ command, args, child }); return child; },
    freePort: async () => nextPort++,
    portOpen: async port => listening.has(port),
    sleep: async () => { // the tunnel starts listening a moment after it was spawned
      for (const s of spawned) if (s.child.exitCode === null && !s.child.signalCode) listening.add(Number(s.args[2]!.split(':')[1]));
    },
    onExit: run => { exits.push(run); },
    readyMs: 2_000,
    ...over,
  };
  return { deps, spawned, listening, exits };
}

describe('ssh tunnel manager', () => {
  it('starts one ssh -D tunnel lazily, with the agreed options, and reuses it', async () => {
    const f = tunnelFakes();
    const tunnels = new TunnelManager(f.deps);
    expect(f.spawned).toHaveLength(0);
    const [a, b] = await Promise.all([tunnels.ensure('clikdeploy-prod-direct'), tunnels.ensure('clikdeploy-prod-direct')]);
    expect(a).toBe(40_000);
    expect(b).toBe(a);
    expect(await tunnels.ensure('clikdeploy-prod-direct')).toBe(a);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.command).toBe('ssh');
    expect(f.spawned[0]!.args).toEqual(sshTunnelArgs(40_000, 'clikdeploy-prod-direct'));
    expect(f.spawned[0]!.args).toEqual(['-N', '-D', '127.0.0.1:40000', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '--', 'clikdeploy-prod-direct']);
  });

  it('starts a new tunnel when the old one died', async () => {
    const f = tunnelFakes();
    const tunnels = new TunnelManager(f.deps);
    const first = await tunnels.ensure('prod');
    f.spawned[0]!.child.die(255);
    const second = await tunnels.ensure('prod');
    expect(second).not.toBe(first);
    expect(f.spawned).toHaveLength(2);
  });

  it('says why ssh ended before it was ready, and tries again on the next call', async () => {
    const f = tunnelFakes({ sleep: () => new Promise(resolve => setTimeout(resolve, 1)) });
    const tunnels = new TunnelManager(f.deps);
    const started = tunnels.ensure('prod');
    await new Promise(resolve => setTimeout(resolve, 0));
    f.spawned[0]!.child.stderr.emit('data', 'ssh: Could not resolve hostname prod\n');
    f.spawned[0]!.child.die(255);
    await expect(started).rejects.toThrow(/ended before it was ready: ssh: Could not resolve hostname prod/);
    void tunnels.ensure('prod').catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.spawned).toHaveLength(2);
    tunnels.closeAll();
  });

  it('gives up on a tunnel that never listens, ending only that ssh process', async () => {
    const f = tunnelFakes({ sleep: async () => { await new Promise(resolve => setTimeout(resolve, 5)); }, readyMs: 30 });
    const tunnels = new TunnelManager(f.deps);
    await expect(tunnels.ensure('prod')).rejects.toThrow(/did not start listening/);
    expect(f.spawned[0]!.child.killed).toEqual(['SIGTERM']);
  });

  it('ends its tunnels when the owning process exits', async () => {
    const f = tunnelFakes();
    const tunnels = new TunnelManager(f.deps);
    await tunnels.ensure('a'); await tunnels.ensure('b');
    expect(f.exits).toHaveLength(1);
    f.exits[0]!();
    expect(f.spawned.map(s => s.child.killed)).toEqual([['SIGTERM'], ['SIGTERM']]);
  });

  it('names the proxy a browser context uses: none for home, the proxy as is, a local SOCKS port for ssh', async () => {
    await addEgress(dir, { name: 'prod', ssh: 'prod-host' });
    await addEgress(dir, { name: 'phone', proxy: 'http://100.64.0.9:8080' });
    const tunnels = { ensure: async (target: string) => (target === 'prod-host' ? 41_234 : 0) };
    expect(await egressServer(dir, 'home', tunnels)).toBeUndefined();
    expect(await egressServer(dir, 'phone', tunnels)).toBe('http://100.64.0.9:8080');
    expect(await egressServer(dir, 'prod', tunnels)).toBe('socks5://127.0.0.1:41234');
    await expect(egressServer(dir, 'gone', tunnels)).rejects.toThrow(/No egress is named "gone"/);
  });
});

/** A minimal SOCKS5 server (no sign-in, CONNECT by name) for the fetch test. */
function socksServer(): Promise<{ server: Server; port: number; asked: string[] }> {
  const asked: string[] = [];
  const server = createTcp(client => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', (request: Buffer) => {
        const length = request[4]!;
        const host = request.subarray(5, 5 + length).toString();
        const port = request.readUInt16BE(5 + length);
        asked.push(`${host}:${port}`);
        const upstream = netConnect({ host: host === 'example.test' ? '127.0.0.1' : host, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, asked })));
}

describe('reading a page through an egress', () => {
  it('fetches through a SOCKS5 proxy, asking it for the host by name', async () => {
    const web = createHttp((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('203.0.113.7'); });
    await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
    const socks = await socksServer();
    try {
      const webPort = (web.address() as AddressInfo).port;
      expect(await fetchVia(`socks5://127.0.0.1:${socks.port}`, `http://example.test:${webPort}/`)).toBe('203.0.113.7');
      expect(socks.asked).toEqual([`example.test:${webPort}`]);
    } finally { web.close(); socks.server.close(); }
  });

  it('check reports each way out with its address, or why it failed', async () => {
    await addEgress(dir, { name: 'prod', ssh: 'prod-host' });
    await addEgress(dir, { name: 'broken', ssh: 'nowhere' });
    const tunnels = { ensure: async (target: string) => { if (target === 'nowhere') throw new Error('The ssh tunnel to nowhere ended before it was ready.'); return 41_000; } };
    const seen: Array<string | undefined> = [];
    const results = await checkEgress(dir, { tunnels, fetch: async server => { seen.push(server); return server ? '157.173.195.175\n' : '98.97.107.150'; } });
    expect(seen).toEqual([undefined, 'socks5://127.0.0.1:41000']);
    expect(results.map(({ ms: _ms, ...row }) => row)).toEqual([
      { name: 'home', via: 'this computer\'s own connection', ok: true, ip: '98.97.107.150' },
      { name: 'prod', via: 'ssh prod-host', ok: true, ip: '157.173.195.175' },
      { name: 'broken', via: 'ssh nowhere', ok: false, error: 'The ssh tunnel to nowhere ended before it was ready.' },
    ]);
  });
});

describe('egressTimeZone', () => {
  it('asks through the egress, keeps the answer, and falls back to it when the lookup fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-geo-'));
    try {
      const asked: Array<[string | undefined, string]> = [];
      const answer = async (server: string | undefined, url: string) => { asked.push([server, url]); return JSON.stringify({ ip: '157.173.195.175', timezone: 'America/Chicago' }); };
      expect(await egressTimeZone(dir, 'prod', 'socks5://127.0.0.1:41000', answer)).toBe('America/Chicago');
      expect(asked).toEqual([['socks5://127.0.0.1:41000', 'https://ipinfo.io/json']]);
      const down = async () => { throw new Error('offline'); };
      expect(await egressTimeZone(dir, 'prod', 'socks5://127.0.0.1:41000', down)).toBe('America/Chicago');
      expect(await egressTimeZone(dir, 'other', 'socks5://127.0.0.1:41000', down)).toBeUndefined();
      // A name that is not a time zone is never handed to Chrome; the second service is asked instead.
      const odd = async (_: string | undefined, url: string) => url.includes('ipinfo') ? JSON.stringify({ timezone: 'Mars/Olympus; rm -rf' }) : JSON.stringify({ query: '1.2.3.4', timezone: 'Europe/Berlin' });
      expect(await egressTimeZone(dir, 'eu', 'socks5://127.0.0.1:41000', odd)).toBe('Europe/Berlin');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
