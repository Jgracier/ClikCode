import { describe, expect, it } from 'vitest';
import { acpMcpServer, globalMcpServersForAcp } from './acp-mcp-servers.js';

describe('acpMcpServer', () => {
  it('spells a local server with env pairs', () => {
    expect(acpMcpServer({ name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } }, {}))
      .toEqual({ name: 'a', command: 'npx', args: ['-y', 'x'], env: [{ name: 'K', value: 'v' }] });
  });
  it('sends a remote server only to a harness that takes its transport', () => {
    const spec = { name: 'r', transport: 'http', url: 'https://x/mcp', headers: { A: 'b' } } as const;
    expect(acpMcpServer(spec, {})).toBeUndefined();
    expect(acpMcpServer(spec, { mcpCapabilities: { http: true } }))
      .toEqual({ type: 'http', name: 'r', url: 'https://x/mcp', headers: [{ name: 'A', value: 'b' }] });
  });
});

describe('the built-in ClikCode server', () => {
  async function inHome<T>(run: (home: string) => Promise<T>, setup?: (home: string) => Promise<void>): Promise<T> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-builtin-'));
    const saved = { home: process.env.CLIKCODE_HOME, entry: process.env.CLIKCODE_MCP_ENTRY };
    process.env.CLIKCODE_HOME = home;
    process.env.CLIKCODE_MCP_ENTRY = '/opt/clikcode/index.js';
    try { await setup?.(home); return await run(home); }
    finally {
      if (saved.home === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = saved.home;
      if (saved.entry === undefined) delete process.env.CLIKCODE_MCP_ENTRY; else process.env.CLIKCODE_MCP_ENTRY = saved.entry;
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  it('goes to every harness session without being recorded, naming the worker to call back', async () => {
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, '/nonexistent-home'));
    expect(servers).toEqual([{ name: 'clikcode', command: process.execPath, args: ['/opt/clikcode/index.js', 'mcp-serve'], env: [{ name: 'CLIKCODE_WORKER_PID', value: String(process.pid) }] }]);
  });

  it('is withheld while computer use is off', async () => {
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, '/nonexistent-home'),
      async home => { const fs = await import('node:fs/promises'); await fs.mkdir(`${home}/computer`, { recursive: true }); await fs.writeFile(`${home}/computer/settings.json`, '{"enabled":false}'); });
    expect(servers).toEqual([]);
  });

  it('steps aside for a server the user recorded under the same name', async () => {
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, '/nonexistent-home'),
      async home => { const fs = await import('node:fs/promises'); await fs.writeFile(`${home}/mcp.json`, JSON.stringify({ mcpServers: { clikcode: { command: 'mine', args: [] } } })); });
    expect(servers).toEqual([{ name: 'clikcode', command: 'mine', args: [], env: [] }]);
  });
});
