import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropRetiredVendorMcp, launchesRetired, stripRetiredJson, stripRetiredToml } from './retired-mcp.js';

describe('retired vendor MCP commands', () => {
  it('drops a conversations server and keeps the ones the user configured', () => {
    const stripped = stripRetiredJson(`${JSON.stringify({
      mcpServers: {
        context7: { command: 'node', args: ['context7'] },
        'clikcode-conversations': { command: '/bin/clikcode', args: ['conversations-mcp'] },
        'mc-brain': { command: '/bin/clikcode', args: ['npx-mcp', '/tmp/proxy.js'] },
      },
    }, null, 2)}\n`);
    expect(stripped?.removed.sort()).toEqual(['clikcode-conversations', 'mc-brain']);
    const left = JSON.parse(stripped!.text) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(left.mcpServers)).toEqual(['context7']);
  });

  it('drops a toml table and the lines around it stay', () => {
    const stripped = stripRetiredToml(`[marketplace]\nname = "x"\n\n[mcp_servers.clikcode-conversations]\ncommand = "/bin/clikcode"\nargs = ["conversations-mcp"]\nenabled = true\n\n[mcp_servers.context7]\ncommand = "node"\n`);
    expect(stripped?.removed).toEqual(['clikcode-conversations']);
    expect(stripped?.text).toContain('[marketplace]');
    expect(stripped?.text).toContain('[mcp_servers.context7]');
    expect(stripped?.text).not.toContain('conversations-mcp');
  });

  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('rewrites a profile once and then leaves it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-retired-'));
    const file = join(root, 'profiles', 'cursor', 'acct', '.cursor', 'mcp.json');
    await mkdir(join(root, 'profiles', 'cursor', 'acct', '.cursor'), { recursive: true });
    await writeFile(file, `${JSON.stringify({ mcpServers: { 'clikcode-conversations': { command: 'clikcode', args: ['conversations-mcp'] }, figma: { url: 'https://mcp.figma.com/mcp' } } })}\n`);
    expect(await dropRetiredVendorMcp(root)).toBe(1);
    const left = JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(left.mcpServers)).toEqual(['figma']);
    expect(await dropRetiredVendorMcp(root)).toBe(0);
  });

  it("recognizes ClikCode's own launcher in every shape a vendor writes it, and nothing else", () => {
    // Cline nests the command; OpenCode keeps one argv; a build's entry file is a launcher too.
    expect(launchesRetired({ transport: { type: 'stdio', command: '/home/me/.local/bin/clikcode', args: ['conversations-mcp'] } })).toBe(true);
    expect(launchesRetired({ type: 'local', command: ['/home/me/.local/bin/clikcode', 'swarm-mcp'] })).toBe(true);
    expect(launchesRetired({ command: '/home/me/projects/clikcode/dist/index.js', args: ['conversations-mcp'] })).toBe(true);
    expect(launchesRetired({ command: '/home/me/.local/share/clikcode/release/dist/index.js', args: ['swarm-mcp'] })).toBe(true);
    // The user's own server that happens to mention the word, or ClikCode's live one, stays.
    expect(launchesRetired({ command: 'node', args: ['my-server.js', 'conversations-mcp'] })).toBe(false);
    expect(launchesRetired({ command: '/home/me/.local/bin/clikcode', args: ['mcp-serve'] })).toBe(false);
  });

  it("cleans the files the catalog names, in the user's own home and in profiles, and leaves what is not ClikCode's", async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-retired-'));
    const home = join(root, 'home');
    const put = async (path: string, value: unknown): Promise<void> => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    };
    const cline = join(root, 'profiles', 'cline', 'acct', '.cline', 'data', 'settings', 'cline_mcp_settings.json');
    const antigravity = join(root, 'profiles', 'antigravity', 'acct', '.gemini', 'config', 'mcp_config.json');
    const droid = join(home, '.factory', 'mcp.json');
    await put(cline, { mcpServers: {
      'clikcode-conversations': { transport: { type: 'stdio', command: '/home/me/.local/bin/clikcode', args: ['conversations-mcp'] } },
      context7: { transport: { type: 'stdio', command: 'node', args: ['context7'] } },
    } });
    await put(antigravity, { mcpServers: {
      'clikcode-swarm': { command: '/home/me/projects/clikcode/dist/index.js', args: ['swarm-mcp'], disabled: false },
      'mc-brain': { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:4021/sse'], disabled: false },
    } });
    await put(droid, { mcpServers: {
      'clikcode-conversations': { type: 'stdio', command: '/home/me/.local/bin/clikcode', args: ['conversations-mcp'], disabled: false },
      mine: { type: 'stdio', command: 'node', args: ['mine.js'] },
    } });
    expect(await dropRetiredVendorMcp(root, home)).toBe(3);
    const servers = async (path: string): Promise<string[]> => Object.keys((JSON.parse(await readFile(path, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers);
    expect(await servers(cline)).toEqual(['context7']);
    expect(await servers(antigravity)).toEqual(['mc-brain']);
    expect(await servers(droid)).toEqual(['mine']);
    // The user's own file is kept as it was, once, beside it; a profile's is not.
    expect(await servers(`${droid}.pre-retired-mcp`)).toEqual(['clikcode-conversations', 'mine']);
    await expect(readFile(`${cline}.pre-retired-mcp`, 'utf8')).rejects.toThrow();
  });

  it("does not look outside its own state directory unless it is given the user's home", async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-retired-'));
    const outside = join(root, 'home', '.factory', 'mcp.json');
    await mkdir(join(outside, '..'), { recursive: true });
    const body = `${JSON.stringify({ mcpServers: { x: { command: '/bin/clikcode', args: ['swarm-mcp'] } } })}\n`;
    await writeFile(outside, body);
    expect(await dropRetiredVendorMcp(join(root, 'state'))).toBe(0);
    expect(await readFile(outside, 'utf8')).toBe(body);
  });

  it('runs again when the earlier, narrower pass stamped the directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-retired-'));
    await writeFile(join(root, 'retired-mcp.txt'), 'conversations-mcp npx-mcp swarm-mcp\n');
    const file = join(root, 'profiles', 'cline', 'acct', '.cline', 'data', 'settings', 'cline_mcp_settings.json');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { a: { transport: { command: 'clikcode', args: ['conversations-mcp'] } } } }));
    expect(await dropRetiredVendorMcp(root)).toBe(1);
  });
});
