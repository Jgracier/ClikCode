/** A one-shot CLI harness with a per-run MCP flag (Amp's --mcp-config) gets
 * the global servers it does not already have, in a private file removed after
 * the run; one without the flag gets nothing. Home and state are the test
 * file's own (vitest.setup.ts). */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeMcpConfig } from './mcp-config.js';
import { mcpOAuthFile } from '../../../agent/mcp/oauth.js';
import { stateDirectory } from '../../../session/store/paths.js';

describe('the global MCP servers for a one-shot CLI turn', () => {
  afterEach(async () => {
    await rm(join(stateDirectory(), 'mcp.json'), { force: true });
    await rm(join(stateDirectory(), 'mcp-oauth'), { recursive: true, force: true });
    await rm(join(homedir(), '.config', 'amp'), { recursive: true, force: true });
  });

  it('go to Amp as --mcp-config, without the ones it has and without a stored sign-in', async () => {
    await mkdir(stateDirectory(), { recursive: true });
    await writeFile(join(stateDirectory(), 'mcp.json'), JSON.stringify({ mcpServers: {
      docs: { command: 'docs-mcp' }, shared: { command: 'shared-mcp' }, signed: { url: 'https://signed.dev/mcp' }, open: { url: 'https://open.dev/mcp', headers: { 'X-Key': 'k' } },
    } }));
    await mkdir(join(homedir(), '.config', 'amp'), { recursive: true });
    await writeFile(join(homedir(), '.config', 'amp', 'settings.json'), JSON.stringify({ 'amp.mcpServers': { shared: { command: 'shared-mcp' } } }));
    await mkdir(join(stateDirectory(), 'mcp-oauth'), { recursive: true });
    await writeFile(mcpOAuthFile(stateDirectory(), 'signed'), JSON.stringify({ server: 'https://signed.dev/mcp', tokens: { accessToken: 'tok' } }));

    const config = await nativeMcpConfig({ command: 'amp', turn: { mcpConfigArgv: ['--mcp-config'] } as never });
    expect(config.argv[0]).toBe('--mcp-config');
    const file = config.argv[1]!;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const servers = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(['clikcode', 'docs', 'open']);
    expect(servers.open).toEqual({ url: 'https://open.dev/mcp', headers: { 'X-Key': 'k' } });
    expect(await readFile(file, 'utf8')).not.toContain('tok');
    await config.dispose();
    await expect(stat(file)).rejects.toThrow();
  });

  it('is nothing for a harness with no per-run MCP mechanism', async () => {
    expect((await nativeMcpConfig({ command: 'aider', turn: {} as never })).argv).toEqual([]);
  });
});
