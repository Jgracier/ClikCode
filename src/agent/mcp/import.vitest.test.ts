/** The one-time import of vendor-configured MCP servers into mcp.json.
 *
 * Every case runs against a throwaway HOME and state directory holding
 * fixture vendor files in the shapes each vendor really writes, so nothing
 * here can read or touch the developer's own configuration.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_MARKER_FILE, importNotice, importVendorMcpServers, normalize, parseToml, stripJsonc } from './import';
import { mcpToolsForTurn } from './manager';

let home: string;
let state: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-import-'));
  home = join(root, 'home');
  state = join(root, 'state');
  await mkdir(home, { recursive: true });
});

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

const servers = async (): Promise<Record<string, Record<string, unknown>>> =>
  (JSON.parse(await readFile(join(state, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;

describe('reading each vendor', () => {
  it('imports from Claude, Codex, Gemini, Goose and opencode in mcp.json shape', async () => {
    await put(join(home, '.claude.json'), {
      numStartups: 4,
      mcpServers: {
        context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { KEY: 'k1' } },
        figma: { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { Authorization: 'Bearer t' } },
      },
      // Local scope: tied to one repository by the user, so not imported.
      projects: { '/repo': { mcpServers: { postgres: { command: 'pg-mcp' } } } },
    });
    await put(join(home, '.codex', 'config.toml'), [
      'model = "gpt-5" # trailing comment',
      '[mcp_servers.docs]',
      'command = "docs-mcp"',
      'args = [',
      '  "--port", # why this port',
      '  "0",',
      ']',
      'env = { TOKEN = "abc", "QUOTED KEY" = "v" }',
      '',
      '[mcp_servers.remote]',
      'url = "https://example.com/mcp"',
      '[mcp_servers.remote.http_headers]',
      'X-Key = "secret"',
    ].join('\n'));
    await put(join(home, '.gemini', 'settings.json'), {
      mcpServers: { legacy: { url: 'https://sse.example.com/sse' }, streamable: { httpUrl: 'https://h.example.com/mcp' } },
    });
    await put(join(home, '.config', 'goose', 'config.yaml'), [
      'extensions:',
      '  developer:',
      '    type: builtin',
      '    enabled: true',
      '  fetch:',
      '    type: stdio',
      '    cmd: uvx',
      '    args: [mcp-server-fetch]',
      '    envs: {}',
      '    enabled: true',
    ].join('\n'));
    await put(join(home, '.config', 'opencode', 'opencode.jsonc'), `{
      // a comment with a URL-like // inside
      "mcp": { "browser": { "type": "local", "command": ["npx", "-y", "@playwright/mcp"], "environment": { "A": "b" } }, },
    }`);

    const result = await importVendorMcpServers(state, home);
    expect(result.ran).toBe(true);
    expect(result.imported.map((server) => `${server.name}:${server.from}`)).toEqual([
      'context7:Claude Code', 'figma:Claude Code', 'legacy:Gemini CLI', 'streamable:Gemini CLI',
      'docs:Codex', 'remote:Codex', 'browser:OpenCode', 'fetch:Goose',
    ]);
    expect(await servers()).toEqual({
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { KEY: 'k1' } },
      figma: { url: 'https://mcp.figma.com/mcp', headers: { Authorization: 'Bearer t' } },
      docs: { command: 'docs-mcp', args: ['--port', '0'], env: { TOKEN: 'abc', 'QUOTED KEY': 'v' } },
      remote: { url: 'https://example.com/mcp', headers: { 'X-Key': 'secret' } },
      legacy: { type: 'sse', url: 'https://sse.example.com/sse' },
      streamable: { url: 'https://h.example.com/mcp' },
      fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
      browser: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { A: 'b' } },
    });
    expect(result.skipped).toEqual([{ name: 'developer', from: 'Goose', reason: 'is a Goose builtin extension, not a portable MCP server' }]);
    expect(importNotice(result)).toMatch(/^Imported 8 MCP servers from your harness configs into mcp\.json: context7 \(Claude Code\), figma/);
  });

  it('reads an isolated ClikCode account profile as well as the home config', async () => {
    await put(join(state, 'profiles', 'claude', 'acct-1', '.claude.json'), { mcpServers: { brain: { command: 'brain-mcp' } } });
    await put(join(state, 'profiles', 'codex', 'acct-2', 'config.toml'), '[mcp_servers.tick]\ncommand = "tick"\n');
    const result = await importVendorMcpServers(state, home);
    expect(result.imported).toEqual([{ name: 'brain', from: 'Claude Code' }, { name: 'tick', from: 'Codex' }]);
  });

  it('writes the file private to the user, since env and headers are often keys', async () => {
    await put(join(home, '.claude.json'), { mcpServers: { a: { command: 'a', env: { API_KEY: 'x' } } } });
    await importVendorMcpServers(state, home);
    expect((await stat(join(state, 'mcp.json'))).mode & 0o777).toBe(0o600);
  });
});

describe('duplicates', () => {
  it('imports a server fanned out to many vendors once, without calling it a conflict', async () => {
    await put(join(home, '.claude.json'), { mcpServers: { ctx: { type: 'stdio', command: 'npx', args: ['ctx'] } } });
    await put(join(home, '.cursor', 'mcp.json'), { mcpServers: { ctx: { command: 'npx', args: ['ctx'] } } });
    await put(join(home, '.codex', 'config.toml'), '[mcp_servers.ctx]\ncommand = "npx"\nargs = ["ctx"]\n');
    const result = await importVendorMcpServers(state, home);
    expect(result.imported).toEqual([{ name: 'ctx', from: 'Claude Code' }]);
    expect(result.skipped).toEqual([]);
  });

  it('keeps Claude Code\'s definition when vendors disagree about a name, and says so', async () => {
    await put(join(home, '.codex', 'config.toml'), '[mcp_servers.db]\ncommand = "old-db"\n');
    await put(join(home, '.claude.json'), { mcpServers: { db: { command: 'new-db' } } });
    const result = await importVendorMcpServers(state, home);
    expect((await servers()).db).toEqual({ command: 'new-db' });
    expect(result.skipped).toEqual([{ name: 'db', from: 'Codex', reason: 'conflicts with Claude Code\'s definition, which was kept' }]);
  });

  it('skips a second name for the same URL, which would duplicate every tool', async () => {
    await put(join(home, '.grok', 'config.toml'), [
      '[mcp_servers.trading]', 'url = "https://agent.example.com/mcp"', 'enabled = true',
      '[mcp_servers.agent]', 'url = "https://agent.example.com/mcp"', 'enabled = true',
    ].join('\n'));
    const result = await importVendorMcpServers(state, home);
    expect(Object.keys(await servers())).toEqual(['trading']);
    expect(result.skipped).toEqual([{ name: 'agent', from: 'Grok Build', reason: 'same server as "trading"' }]);
  });
});

describe('what already is in mcp.json', () => {
  it('is never overwritten, and its other keys survive', async () => {
    await put(join(state, 'mcp.json'), { note: 'mine', mcpServers: { db: { command: 'hand-edited', disabled: true } } });
    await put(join(home, '.claude.json'), { mcpServers: { db: { command: 'other' }, extra: { command: 'extra' } } });
    const result = await importVendorMcpServers(state, home);
    const file = JSON.parse(await readFile(join(state, 'mcp.json'), 'utf8')) as Record<string, unknown>;
    expect(file).toEqual({ note: 'mine', mcpServers: { db: { command: 'hand-edited', disabled: true }, extra: { command: 'extra' } } });
    expect(result.skipped).toEqual([{ name: 'db', from: 'Claude Code', reason: 'mcp.json already has a server by that name' }]);
  });

  it('leaves a malformed mcp.json alone and tries again once it is fixed', async () => {
    await put(join(state, 'mcp.json'), '{ not json');
    await put(join(home, '.claude.json'), { mcpServers: { a: { command: 'a' } } });
    const first = await importVendorMcpServers(state, home);
    expect(first).toMatchObject({ ran: false, imported: [] });
    expect(first.problem).toMatch(/is not a JSON object/);
    expect(await readFile(join(state, 'mcp.json'), 'utf8')).toBe('{ not json');
    await put(join(state, 'mcp.json'), '{}');
    expect((await importVendorMcpServers(state, home)).imported).toEqual([{ name: 'a', from: 'Claude Code' }]);
  });
});

describe('running once', () => {
  it('does not bring back a server the user removed after the import', async () => {
    await put(join(home, '.claude.json'), { mcpServers: { a: { command: 'a' } } });
    expect((await importVendorMcpServers(state, home)).ran).toBe(true);
    await put(join(state, 'mcp.json'), { mcpServers: {} });
    const again = await importVendorMcpServers(state, home);
    expect(again).toEqual({ ran: false, imported: [], skipped: [] });
    expect(await servers()).toEqual({});
  });

  it('records the run even when there was nothing to import, and writes no mcp.json', async () => {
    const result = await importVendorMcpServers(state, home);
    expect(result).toEqual({ ran: true, imported: [], skipped: [] });
    expect(importNotice(result)).toBeUndefined();
    await expect(stat(join(state, IMPORT_MARKER_FILE))).resolves.toBeTruthy();
    await expect(stat(join(state, 'mcp.json'))).rejects.toThrow();
  });
});

describe('what does not carry over', () => {
  const skip = (dialect: Parameters<typeof normalize>[0], raw: unknown): string | undefined => {
    const result = normalize(dialect, raw);
    return 'skip' in result ? result.skip : undefined;
  };

  it('names a reason for each server it leaves behind', () => {
    expect(skip('mcp-servers', { command: 'a', disabled: true })).toBe('is disabled there');
    expect(skip('codex', { command: 'a', enabled: false })).toBe('is disabled there');
    expect(skip('mcp-servers', { command: 'a', env: { KEY: '${API_KEY}' } })).toMatch(/placeholders/);
    expect(skip('opencode', { type: 'remote', url: 'https://x.dev', headers: { A: '{env:TOKEN}' } })).toMatch(/placeholders/);
    expect(skip('codex', { url: 'https://x.dev/mcp', bearer_token_env_var: 'TOKEN' })).toMatch(/bearer token/);
    expect(skip('gemini', { command: './server', cwd: '/repo' })).toMatch(/working directory/);
    expect(skip('mcp-servers', { type: 'sdk', name: 'x' })).toMatch(/transport type "sdk"/);
    expect(skip('goose', { type: 'stdio', cmd: 'a', env_keys: ['TOKEN'] })).toMatch(/keyring/);
    expect(skip('mcp-servers', { url: 'ws://x' })).toMatch(/not http/);
    expect(skip('mcp-servers', {})).toBe('names no command or URL');
  });

  it('accepts the transport spellings vendors use for the same two things', () => {
    expect(normalize('mcp-servers', { type: 'local', command: 'a' })).toEqual({ entry: { command: 'a' } });
    expect(normalize('mcp-servers', { type: 'streamable-http', url: 'https://x.dev' })).toEqual({ entry: { url: 'https://x.dev' } });
    expect(normalize('mcp-servers', { type: 'sse', url: 'https://x.dev' })).toEqual({ entry: { type: 'sse', url: 'https://x.dev' } });
  });
});

describe('the small parsers', () => {
  it('reads the TOML an MCP table is written in, and skips a line it cannot', () => {
    expect(parseToml([
      'broken = = line',
      "[mcp_servers.'odd name']",
      "command = 'C:\\literal'",
      'args = ["a\\"b", "\\u00e9"]',
      'timeout = 30',
      'nested.deep = true',
      '[[profiles]]',
      'name = "one"',
    ].join('\n'))).toEqual({
      mcp_servers: { 'odd name': { command: 'C:\\literal', args: ['a"b', 'é'], timeout: 30, nested: { deep: true } } },
      profiles: [{ name: 'one' }],
    });
  });

  it('strips JSONC comments and trailing commas without touching strings', () => {
    expect(JSON.parse(stripJsonc('{ "u": "https://a//b", /* c */ "x": [1,], // d\n }'))).toEqual({ u: 'https://a//b', x: [1] });
  });
});

describe('where it runs', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
  let saved: { HOME?: string; CLIKCODE_HOME?: string };
  beforeEach(() => { saved = { HOME: process.env.HOME, CLIKCODE_HOME: process.env.CLIKCODE_HOME }; });
  afterEach(async () => {
    // A different state directory shuts the shared manager's servers down.
    process.env.CLIKCODE_HOME = await mkdtemp(join(tmpdir(), 'mcp-import-idle-'));
    await mcpToolsForTurn(process.env.CLIKCODE_HOME);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('imports before the agent\'s first turn loads its servers, and says so once', async () => {
    process.env.HOME = home;
    process.env.CLIKCODE_HOME = state;
    await put(join(home, '.claude.json'), { mcpServers: { fake: { command: process.execPath, args: [FIXTURE] } } });
    const first = await mcpToolsForTurn(state);
    expect(first.notes).toEqual(['Imported 1 MCP server from your harness configs into mcp.json: fake (Claude Code)']);
    expect(first.tools.length).toBeGreaterThan(0);
    const second = await mcpToolsForTurn(state);
    expect(second.notes).toEqual([]);
    expect(second.tools.length).toBe(first.tools.length);
  });
});
