/** The global MCP servers reach Codex: the app-server is launched with the
 * recorded servers as `-c mcp_servers.*` overrides, without the ones Codex has
 * of its own, and a remote server's stored sign-in rides in the app-server's
 * environment, never on its command line. Driven by a fake app-server child;
 * the home and state directory are the test file's own (vitest.setup.ts). */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexSession } from './codex-app-server.js';
import { mcpOAuthFile } from '../../agent/mcp/oauth.js';
import { stateDirectory } from '../../session/store/paths.js';

const fakeServer = `
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: {} });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'T' } } });
  } });
`;

describe('the global MCP servers on the Codex app-server launch', () => {
  afterEach(async () => {
    await rm(join(stateDirectory(), 'mcp.json'), { force: true });
    await rm(join(stateDirectory(), 'mcp-oauth'), { recursive: true, force: true });
    await rm(join(homedir(), '.codex'), { recursive: true, force: true });
  });

  it('passes the recorded servers Codex does not have, with a stored bearer in its environment', async () => {
    await mkdir(stateDirectory(), { recursive: true });
    await writeFile(join(stateDirectory(), 'mcp.json'), JSON.stringify({ mcpServers: {
      docs: { command: 'docs-mcp', args: ['--stdio'], env: { DOCS_KEY: 'k' } },
      shared: { command: 'shared-mcp' },
      linear: { url: 'https://mcp.linear.app/mcp' },
    } }));
    await mkdir(join(homedir(), '.codex'), { recursive: true });
    await writeFile(join(homedir(), '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "shared-mcp"\n');
    await mkdir(join(stateDirectory(), 'mcp-oauth'), { recursive: true });
    await writeFile(mcpOAuthFile(stateDirectory(), 'linear'), JSON.stringify({ server: 'https://mcp.linear.app/mcp', tokens: { accessToken: 'lin-token' } }));

    const launches: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const codex = createCodexSession({
      spawn: (_binary, argv, options) => { launches.push({ argv, env: options.env ?? {} }); return spawn(process.execPath, ['-e', fakeServer], options); },
    });
    try {
      await codex.runTurn({ binary: 'codex', prompt: '', cwd: process.cwd(), permissionMode: 'ask', prepareOnly: true });
    } finally { await codex.close(); }

    expect(launches).toHaveLength(1);
    const { argv, env } = launches[0]!;
    expect(argv.slice(0, 2)).toEqual(['app-server', '--stdio']);
    expect(argv).toContain('mcp_servers.docs.command="docs-mcp"');
    expect(argv).toContain('mcp_servers.docs.args=["--stdio"]');
    // Its key is forwarded by name, not written on the command line.
    expect(argv).toContain('mcp_servers.docs.env_vars=["DOCS_KEY"]');
    expect(argv.join(' ')).not.toContain('DOCS_KEY="k"');
    expect(env.DOCS_KEY).toBe('k');
    expect(argv).toContain('mcp_servers.linear.url="https://mcp.linear.app/mcp"');
    expect(argv.some((arg) => arg.startsWith('mcp_servers.shared.'))).toBe(false);
    const headers = argv.find((arg) => arg.startsWith('mcp_servers.linear.env_http_headers='))!;
    const variable = /Authorization="([A-Z0-9_]+)"/.exec(headers)?.[1];
    expect(variable).toBeDefined();
    expect(env[variable!]).toBe('Bearer lin-token');
    expect(argv.join(' ')).not.toContain('lin-token');
  }, 20_000);
});
