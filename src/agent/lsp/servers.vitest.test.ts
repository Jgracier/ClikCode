import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { languageServerPoolForTests as pool, serverFor, shutdownLanguageServers } from './servers.js';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe.skipIf(process.platform === 'win32')('the language server pool', () => {
  let root: string;
  let pids: string;
  const originalPath = process.env.PATH;
  const pidsNow = async (): Promise<number[]> => (await readdir(pids)).map(Number);

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'lsp-pool-')));
    const bin = path.join(root, 'bin');
    pids = path.join(root, 'pids');
    await Promise.all([mkdir(bin), mkdir(pids)]);
    await writeFile(path.join(bin, 'gopls'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`);
    await chmod(path.join(bin, 'gopls'), 0o755);
    process.env.PATH = bin;
    process.env.FAKE_LSP_PID_DIR = pids;
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_LSP_PID_DIR;
    delete process.env.FAKE_LSP_SLOW_INIT;
    pool.setIdleMs(10 * 60_000);
    await shutdownLanguageServers();
    await rm(root, { recursive: true, force: true });
  });

  const project = async (name: string): Promise<string> => {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'go.mod'), `module ${name}\n`);
    await writeFile(path.join(dir, 'a.go'), 'package x\n');
    return path.join(dir, 'a.go');
  };

  it('stops a server that has been idle, and starts it again on the next query', async () => {
    pool.setIdleMs(200);
    const file = await project('p');
    const first = await serverFor(file, root);
    await until(() => !first.running);
    expect(pool.size()).toBe(0);
    const second = await serverFor(file, root);
    expect(second).not.toBe(first);
    expect(second.running).toBe(true);
  });

  it('counts servers still starting toward the cap', async () => {
    process.env.FAKE_LSP_SLOW_INIT = '300';
    const files = await Promise.all(Array.from({ length: 8 }, (_, index) => project(`p${index}`)));
    let most = 0;
    const watch = setInterval(() => { most = Math.max(most, pool.size()); }, 5);
    try {
      await Promise.all(files.map((file) => serverFor(file, root)));
    } finally { clearInterval(watch); }
    expect(most).toBeLessThanOrEqual(6);
    expect(pool.size()).toBeLessThanOrEqual(6);
  });

  it('kills a server still starting when the process exits', async () => {
    process.env.FAKE_LSP_SLOW_INIT = '60000';
    const pending = serverFor(await project('slow'), root).catch((error: unknown) => error);
    await until(async () => (await pidsNow()).length === 1);
    const [pid] = await pidsNow();
    pool.killAllNow();
    await until(() => !alive(pid!));
    expect(await pending).toBeInstanceOf(Error);
  });
});
