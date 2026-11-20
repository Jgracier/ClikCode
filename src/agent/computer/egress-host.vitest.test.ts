/** The browser host's egress contexts: made with raw CDP so they outlive the worker that asked, reused, remade when the tunnel moved,
 * and served to workers over a local socket. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EgressContexts, EgressNotServed, egressSocketPath, requestHostedContext, serveEgress, type BrowserCdp } from './egress-host.js';

function fakeCdp() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const live = new Set<string>();
  let made = 0;
  const cdp: BrowserCdp = {
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Target.createBrowserContext') { const id = `ctx-${++made}`; live.add(id); return { browserContextId: id }; }
      if (method === 'Target.disposeBrowserContext') { live.delete(String(params?.browserContextId)); return {}; }
      if (method === 'Target.getBrowserContexts') return { browserContextIds: [...live] };
      if (method === 'Target.createTarget') return { targetId: `target-in-${String(params?.browserContextId)}` };
      return {};
    },
  };
  return { cdp, calls, live };
}

describe('the host\'s egress contexts', () => {
  it('are made once with disposeOnDetach false and the egress proxy, and reused', async () => {
    const f = fakeCdp();
    const contexts = new EgressContexts(async () => f.cdp, async () => 'socks5://127.0.0.1:41000');
    const [a, b] = await Promise.all([contexts.ensure('prod'), contexts.ensure('prod')]);
    expect(a).toEqual({ id: 'ctx-1', server: 'socks5://127.0.0.1:41000' });
    expect(b).toEqual(a);
    expect(await contexts.ensure('prod')).toEqual(a);
    expect(f.calls.filter(([m]) => m === 'Target.createBrowserContext')).toEqual([['Target.createBrowserContext', { disposeOnDetach: false, proxyServer: 'socks5://127.0.0.1:41000' }]]);
  });

  it('are remade when the tunnel came back on another port (the old one disposed) or Chrome lost them', async () => {
    const f = fakeCdp();
    let server = 'socks5://127.0.0.1:41000';
    const contexts = new EgressContexts(async () => f.cdp, async () => server);
    await contexts.ensure('prod');
    server = 'socks5://127.0.0.1:42000';
    expect(await contexts.ensure('prod')).toEqual({ id: 'ctx-2', server });
    expect(f.calls).toContainEqual(['Target.disposeBrowserContext', { browserContextId: 'ctx-1' }]);
    f.live.clear();
    expect((await contexts.ensure('prod')).id).toBe('ctx-3');
  });

  it('open a restored tab in the egress context', async () => {
    const f = fakeCdp();
    const contexts = new EgressContexts(async () => f.cdp, async () => 'socks5://127.0.0.1:41000');
    expect(await contexts.openPage('prod', 'https://vendor.example/keys')).toBe('target-in-ctx-1');
    expect(f.calls).toContainEqual(['Target.createTarget', { url: 'https://vendor.example/keys', browserContextId: 'ctx-1' }]);
  });

  it('say so for home, and fail when the egress cannot open, trying again next time', async () => {
    const f = fakeCdp();
    let fail = true;
    const contexts = new EgressContexts(async () => f.cdp, async name => { if (name === 'home') return undefined; if (fail) throw new Error('The ssh tunnel to prod-host ended before it was ready.'); return 'socks5://127.0.0.1:1'; });
    await expect(contexts.ensure('home')).rejects.toThrow(/own connection/);
    await expect(contexts.ensure('prod')).rejects.toThrow(/ended before it was ready/);
    fail = false;
    expect((await contexts.ensure('prod')).id).toBe('ctx-1');
  });
});

describe('asking the host over its socket', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-egh-')); await fs.mkdir(path.join(dir, 'computer'), { recursive: true }); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('answers a worker with the context id, or the reason it could not', async () => {
    const socket = egressSocketPath(dir, 4242);
    const served = await serveEgress(socket, { ensure: async name => { if (name === 'gone') throw new Error('No egress is named "gone".'); return { id: `ctx-${name}`, server: 'socks5://127.0.0.1:41000' }; } });
    try {
      const hostFile = async () => JSON.stringify({ pid: 4242, egressSocket: socket });
      expect(await requestHostedContext(dir, 'prod', hostFile)).toEqual({ id: 'ctx-prod', server: 'socks5://127.0.0.1:41000' });
      await expect(requestHostedContext(dir, 'gone', hostFile)).rejects.toThrow('No egress is named "gone".');
      expect((await fs.stat(socket)).mode & 0o777).toBe(0o600);
    } finally { await served.stop(); }
    await expect(fs.stat(socket)).rejects.toThrow();
  });

  it('a host that serves no egress (an older one, or none) is told apart from a failure', async () => {
    await expect(requestHostedContext(dir, 'prod', async () => JSON.stringify({ pid: 1 }))).rejects.toBeInstanceOf(EgressNotServed);
    await expect(requestHostedContext(dir, 'prod', async () => { throw new Error('ENOENT'); })).rejects.toBeInstanceOf(EgressNotServed);
    await expect(requestHostedContext(dir, 'prod', async () => JSON.stringify({ pid: 1, egressSocket: path.join(dir, 'computer', 'nobody.sock') }))).rejects.toBeInstanceOf(EgressNotServed);
  });
});
