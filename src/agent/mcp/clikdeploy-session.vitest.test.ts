import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIKDEPLOY_CONFIG_DIR_ENV, clikDeploySessionServer } from './clikdeploy-session.js';
import { ampMcpConfig, codexMcpLaunch, globalMcpServers } from '../../harness/transport/acp-mcp-servers.js';
import { nativeMcpConfig } from '../../harness/transport/native/mcp-config.js';

const URL_ = 'http://127.0.0.1:9';
const KEY = 'cdk_test_secret_key_123';
let root: string;
const saved: Record<string, string | undefined> = {};
const names = ['XDG_CONFIG_HOME', 'CLIKDEPLOY_API_URL_OVERRIDE', 'CLIKCODE_HOME', 'CLIKCODE_MCP_ENTRY'];

async function signIn(): Promise<void> {
  await mkdir(join(root, 'config', 'clikdeploy-nodejs'), { recursive: true });
  await writeFile(join(root, 'config', 'clikdeploy-nodejs', 'config.json'), JSON.stringify({ authByUrl: { [URL_]: { apiKey: KEY } } }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cd-session-'));
  for (const name of names) saved[name] = process.env[name];
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CLIKDEPLOY_API_URL_OVERRIDE = URL_;
  process.env.CLIKCODE_HOME = join(root, 'state');
  process.env.CLIKCODE_MCP_ENTRY = '/opt/clikcode/index.js';
  // Computer use off: the only server left is ClikDeploy's.
  await mkdir(join(root, 'state', 'computer'), { recursive: true });
  await writeFile(join(root, 'state', 'computer', 'settings.json'), '{"enabled":false}');
});
afterEach(async () => {
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  await rm(root, { recursive: true, force: true });
});

describe('the ClikDeploy session server', () => {
  it('is left out while this machine is not signed in to ClikDeploy, without an error', async () => {
    expect(clikDeploySessionServer()).toBeUndefined();
    expect(await globalMcpServers('some-harness', undefined, '/nonexistent-home')).toEqual([]);
  });

  it('goes to every harness while signed in, as a stdio proxy that names where the sign-in is, not the key', async () => {
    await signIn();
    const servers = await globalMcpServers('some-harness', undefined, '/nonexistent-home');
    expect(servers).toEqual([{ name: 'clikdeploy', transport: 'stdio', command: process.execPath, args: ['/opt/clikcode/index.js', 'clikdeploy-mcp-serve'], env: expect.objectContaining({
      CLIKCODE_WORKER_PID: String(process.pid), [CLIKDEPLOY_CONFIG_DIR_ENV]: join(root, 'config', 'clikdeploy-nodejs'),
    }) }]);
    expect(JSON.stringify(servers)).not.toContain(KEY);
  });

  it('never puts the key in a vendor file, launch line or environment', async () => {
    await signIn();
    const servers = await globalMcpServers('some-harness', undefined, '/nonexistent-home');
    expect(JSON.stringify(ampMcpConfig(servers))).not.toContain(KEY);
    expect(JSON.stringify(codexMcpLaunch(servers))).not.toContain(KEY);
    const native = await nativeMcpConfig({ command: 'amp', turn: { mcpConfigArgv: ['--mcp-config'] } } as never);
    try {
      expect(native.argv[0]).toBe('--mcp-config');
      const written = await readFile(native.argv[1]!, 'utf8');
      expect(written).toContain('clikdeploy-mcp-serve');
      expect(written).not.toContain(KEY);
    } finally { await native.dispose(); }
  });

  it('steps aside for a server the user recorded under the same name', async () => {
    await signIn();
    await writeFile(join(root, 'state', 'mcp.json'), JSON.stringify({ mcpServers: { clikdeploy: { command: 'mine', args: [] } } }));
    expect(await globalMcpServers('some-harness', undefined, '/nonexistent-home')).toEqual([{ name: 'clikdeploy', transport: 'stdio', command: 'mine', args: [], env: {} }]);
  });
});
