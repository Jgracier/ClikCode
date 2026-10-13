import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRemoteTarget, mcpConfigEntry, removeMcpConfigEntry, writeMcpConfigEntry } from './mcp-registry';

const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const scratch = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'mcp-registry-')), 'mcp.json');

describe('the servers recorded for ClikCode\'s own agent', () => {
  it('spells a local server as a command with its arguments and a remote one as a url', () => {
    expect(mcpConfigEntry({ name: 'figma', target: 'npx', args: ['-y', 'figma-mcp'] })).toEqual({ command: 'npx', args: ['-y', 'figma-mcp'] });
    expect(mcpConfigEntry({ name: 's', target: 'https://mcp.example/mcp' })).toEqual({ url: 'https://mcp.example/mcp' });
    expect(mcpConfigEntry({ name: 's', target: 'https://mcp.example/mcp', headers: { 'X-Key': 'k' } })).toEqual({ url: 'https://mcp.example/mcp', headers: { 'X-Key': 'k' } });
    expect(mcpConfigEntry({ name: 'l', target: 'node', env: { A: '1' } })).toEqual({ command: 'node', env: { A: '1' } });
  });

  it('merges one server in and keeps every other server and key', async () => {
    const path = await scratch();
    await writeFile(path, JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'mine' } } }));
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'figma', target: 'npx', args: ['-y', 'figma-mcp'] });
    expect(await read(path)).toEqual({ theme: 'dark', mcpServers: { mine: { command: 'mine' }, figma: { command: 'npx', args: ['-y', 'figma-mcp'] } } });
  });

  it('creates the file, and refuses one that is not a JSON object', async () => {
    const path = await scratch();
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'a', target: 'a' });
    expect(await read(path)).toEqual({ mcpServers: { a: { command: 'a' } } });
    await writeFile(path, '[1]');
    await expect(writeMcpConfigEntry(path, 'mcpServers', { name: 'b', target: 'b' })).rejects.toThrow(/not a JSON object/);
    expect(await readFile(path, 'utf8')).toBe('[1]');
  });

  it('removes only the named server', async () => {
    const path = await scratch();
    await writeFile(path, JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    expect(await removeMcpConfigEntry(path, 'mcpServers', 'a')).toBe(true);
    expect(await removeMcpConfigEntry(path, 'mcpServers', 'a')).toBe(false);
    expect(await read(path)).toEqual({ mcpServers: { b: { command: 'b' } } });
  });

  it('knows a URL from an executable', () => {
    expect(isRemoteTarget('https://example.com/mcp')).toBe(true);
    expect(isRemoteTarget('npx')).toBe(false);
    expect(isRemoteTarget('/usr/local/bin/server')).toBe(false);
  });
});
