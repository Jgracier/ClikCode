import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropRetiredVendorMcp, stripRetiredJson, stripRetiredToml } from './retired-mcp.js';

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
});
