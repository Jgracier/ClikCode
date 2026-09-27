import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMcp, releaseMcp } from './manager';
import { IMPORT_MARKER_FILE } from './import';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A state directory with one fake server, and the vendor import already
 * recorded, so the developer's own MCP servers are never touched. */
function stateDir(env: Record<string, string> = {}): { dir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-life-'));
  const pidFile = join(dir, 'fake.pid');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_PID_FILE: pidFile, ...env } } } }));
  writeFileSync(join(dir, IMPORT_MARKER_FILE), JSON.stringify({ ranAt: new Date().toISOString(), imported: [] }));
  return { dir, pidFile };
}

const previousHome = process.env.CLIKCODE_HOME;
afterEach(async () => {
  await releaseMcp();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previousHome;
});

describe('MCP servers follow the route of the conversation', () => {
  it('start when the route is chosen, before any turn, and stop when it is left', { timeout: 30_000 }, async () => {
    const { dir, pidFile } = stateDir();
    process.env.CLIKCODE_HOME = dir;
    prepareMcp(dir);
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    await releaseMcp();
    await until(() => !alive(pid));
  });

  it('stop a server that is still starting, at once rather than when its start would end', { timeout: 30_000 }, async () => {
    // Never answers the handshake: without the abort, release waited out the
    // 30s connect timeout -- or, before that, left the server running for good.
    const { dir, pidFile } = stateDir({ FAKE_MCP_SILENT: '1' });
    process.env.CLIKCODE_HOME = dir;
    prepareMcp(dir);
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const started = Date.now();
    await releaseMcp();
    await until(() => !alive(pid), 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

