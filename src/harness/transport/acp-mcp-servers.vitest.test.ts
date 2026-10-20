import { describe, expect, it } from 'vitest';
import { acpMcpServer, ampMcpConfig, codexMcpLaunch, globalMcpServers, globalMcpServersForAcp } from './acp-mcp-servers.js';
import { mcpOAuthFile } from '../../agent/mcp/oauth.js';

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
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, undefined, '/nonexistent-home'));
    expect(servers).toEqual([{ name: 'clikcode', command: process.execPath, args: ['/opt/clikcode/index.js', 'mcp-serve'], env: [{ name: 'CLIKCODE_WORKER_PID', value: String(process.pid) }] }]);
  });

  it('is withheld while computer use is off', async () => {
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, undefined, '/nonexistent-home'),
      async home => { const fs = await import('node:fs/promises'); await fs.mkdir(`${home}/computer`, { recursive: true }); await fs.writeFile(`${home}/computer/settings.json`, '{"enabled":false}'); });
    expect(servers).toEqual([]);
  });

  it('steps aside for a server the user recorded under the same name', async () => {
    const servers = await inHome(() => globalMcpServersForAcp('some-harness', {}, undefined, '/nonexistent-home'),
      async home => { const fs = await import('node:fs/promises'); await fs.writeFile(`${home}/mcp.json`, JSON.stringify({ mcpServers: { clikcode: { command: 'mine', args: [] } } })); });
    expect(servers).toEqual([{ name: 'clikcode', command: 'mine', args: [], env: [] }]);
  });
});

describe('the global servers for Codex', () => {
  async function inHome<T>(run: (state: string, home: string) => Promise<T>): Promise<T> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-codex-mcp-'));
    const state = path.join(root, 'state');
    const home = path.join(root, 'home');
    await fs.mkdir(state, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const saved = { home: process.env.CLIKCODE_HOME, entry: process.env.CLIKCODE_MCP_ENTRY };
    process.env.CLIKCODE_HOME = state;
    process.env.CLIKCODE_MCP_ENTRY = '/opt/clikcode/index.js';
    try { return await run(state, home); }
    finally {
      if (saved.home === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = saved.home;
      if (saved.entry === undefined) delete process.env.CLIKCODE_MCP_ENTRY; else process.env.CLIKCODE_MCP_ENTRY = saved.entry;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('spells the built-in server as -c config overrides on the app-server launch', () => {
    const builtIn = { name: 'clikcode', transport: 'stdio', command: '/usr/bin/node', args: ['/opt/clikcode/index.js', 'mcp-serve'], env: { CLIKCODE_WORKER_PID: '42' } } as const;
    expect(codexMcpLaunch([builtIn])).toEqual({ args: [
      '-c', 'mcp_servers.clikcode.command="/usr/bin/node"',
      '-c', 'mcp_servers.clikcode.args=["/opt/clikcode/index.js","mcp-serve"]',
      '-c', 'mcp_servers.clikcode.env={CLIKCODE_WORKER_PID="42"}',
    ], env: {} });
  });

  it('keeps header values off the command line, and leaves out what Codex cannot take', () => {
    const launch = codexMcpLaunch([
      { name: 'remote', transport: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer s3cret', 'X-Team': 't' } },
      { name: 'legacy', transport: 'sse', url: 'https://x.dev/sse', headers: {} },
      { name: 'has.dot', transport: 'stdio', command: 'x', args: [], env: {} },
    ]);
    expect(launch.args).toEqual([
      '-c', 'mcp_servers.remote.url="https://x.dev/mcp"',
      '-c', 'mcp_servers.remote.env_http_headers={Authorization="CLIKCODE_MCP_SECRET_0",X-Team="CLIKCODE_MCP_SECRET_1"}',
    ]);
    expect(launch.env).toEqual({ CLIKCODE_MCP_SECRET_0: 'Bearer s3cret', CLIKCODE_MCP_SECRET_1: 't' });
    expect(launch.args.join(' ')).not.toContain('s3cret');
  });

  it('hands Codex the recorded servers it does not already have, with a stored sign-in as the bearer', async () => {
    await inHome(async (state, home) => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(path.join(state, 'mcp.json'), JSON.stringify({ mcpServers: {
        mine: { command: 'mine-mcp', args: ['--x'] },
        shared: { command: 'shared-mcp' },
        signed: { url: 'https://signed.dev/mcp' },
        unsigned: { url: 'https://unsigned.dev/mcp' },
        refused: { url: 'https://refused.dev/mcp' },
      } }));
      // Codex already has `shared` of its own: it is not given twice.
      await fs.mkdir(path.join(home, '.codex'), { recursive: true });
      await fs.writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "shared-mcp"\n');
      const record = (url: string, extra: object) => JSON.stringify({ server: url, ...extra });
      await fs.mkdir(path.join(state, 'mcp-oauth'), { recursive: true });
      await fs.writeFile(mcpOAuthFile(state, 'signed'), record('https://signed.dev/mcp', { tokens: { accessToken: 'tok-1' } }));
      await fs.writeFile(mcpOAuthFile(state, 'refused'), record('https://refused.dev/mcp', { needsSignIn: true }));
      const servers = await globalMcpServers('codex', undefined, home);
      expect(servers.map((server) => server.name)).toEqual(['clikcode', 'mine', 'signed', 'unsigned']);
      const launch = codexMcpLaunch(servers);
      expect(launch.args).toContain('mcp_servers.mine.command="mine-mcp"');
      expect(launch.args.some((arg) => arg.includes('shared'))).toBe(false);
      expect(launch.args).toContain('mcp_servers.signed.env_http_headers={Authorization="CLIKCODE_MCP_SECRET_0"}');
      expect(launch.env).toEqual({ CLIKCODE_MCP_SECRET_0: 'Bearer tok-1' });
      expect(launch.args.join(' ')).not.toContain('tok-1');
      // The same bearer reaches an ACP agent that takes remote servers, as a header.
      const acp = await globalMcpServersForAcp('some-harness', { mcpCapabilities: { http: true } }, undefined, home);
      expect(acp.find((server) => server.name === 'signed')?.headers).toEqual([{ name: 'Authorization', value: 'Bearer tok-1' }]);
      expect(acp.find((server) => server.name === 'unsigned')?.headers).toEqual([]);
    });
  });
});

describe('the global servers for Amp', () => {
  it('spells them as Amp\'s mcpServers setting', () => {
    expect(ampMcpConfig([
      { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } },
      { name: 'r', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
    ])).toEqual({ a: { command: 'npx', args: ['-y', 'x'], env: { K: 'v' } }, r: { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } } });
  });
});
