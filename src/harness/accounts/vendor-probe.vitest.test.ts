import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeCommand, probeEnvironment, probeFetch } from './vendor-probe.js';
import { probeOnce } from './account-usage.js';

/** A fake vendor CLI: a shell script, never a real one. */
async function fakeVendor(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fake-vendor-'));
  const file = join(directory, 'vendor');
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.platform === 'win32')('vendor probes', () => {
  it('ends a vendor that never answers at the deadline, with what it started', async () => {
    const pids = join(await mkdtemp(join(tmpdir(), 'probe-pids-')), 'pids');
    const vendor = await fakeVendor(`sleep 60 & echo $$ $! > ${pids}; wait`);
    const started = Date.now();
    expect(await probeCommand(vendor, [], {}, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    const [leader, grandchild] = (await readFile(pids, 'utf8')).trim().split(' ').map(Number);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(leader!)).toBe(false);
    expect(alive(grandchild!)).toBe(false);
  });

  it('gives the vendor no stdin and a browser opener that does nothing', async () => {
    const vendor = await fakeVendor('read line || echo "eof"; echo "$BROWSER"; xdg-open https://example.com/login && echo opened-nothing');
    const output = await probeCommand(vendor, [], {}, 5_000);
    const [stdin, browser, opened] = output!.trim().split('\n');
    expect(stdin).toBe('eof');
    expect(browser).toMatch(/probe-no-browser\/xdg-open$/);
    expect(opened).toBe('opened-nothing');
    expect(probeEnvironment({ PATH: '/x' }).PATH).toMatch(/probe-no-browser:\/x$/);
  });

  it('a fetch that never answers gives up', async () => {
    const { createServer } = await import('node:http');
    const server = createServer(() => undefined).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expect(probeFetch(`http://127.0.0.1:${port}/`, {}, 100)).rejects.toThrow();
    } finally { server.closeAllConnections(); server.close(); }
  });
});

describe('usage probes in flight', () => {
  it('a probe that never settles frees its slot at the deadline, so the next ask runs', async () => {
    let calls = 0;
    const hung = probeOnce('hung-account', () => { calls += 1; return new Promise(() => undefined); }, 50);
    expect(await hung).toBeUndefined();
    const next = await probeOnce('hung-account', async () => { calls += 1; return { windows: [], label: 'ok' }; }, 50);
    expect(next).toEqual({ windows: [], label: 'ok' });
    expect(calls).toBe(2);
  });
});
