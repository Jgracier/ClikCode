/** Writing a vendor's own MCP config, for a harness with no usable `mcp add`.
 *
 * This is a second-best route and the risk is specific: the file belongs to
 * the user, so adding to it must never be rewriting it. Verified end to end
 * against the real Cursor -- it listed back all three servers from a file
 * this writer produced, including one that was already in it.
 */
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpConfigEntry, mcpConfigPath, writeMcpConfigEntry } from './mcp-registry';

const CURSOR = { homeRelativeDir: ['.cursor'], file: 'mcp.json', key: 'mcpServers' };
const KIMI = { rootEnv: 'KIMI_CODE_HOME', homeRelativeDir: ['.kimi-code'], file: 'mcp.json', key: 'mcpServers' };

const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('where the config file is', () => {
  it('sits under the home the harness is being run against', () => {
    expect(mcpConfigPath(CURSOR, { HOME: '/tmp/acct' })).toBe('/tmp/acct/.cursor/mcp.json');
  });

  it('prefers the vendor\'s own directory variable when it is set', () => {
    // An isolated account profile must resolve to its OWN file, not a shared one.
    expect(mcpConfigPath(KIMI, { HOME: '/tmp/acct', KIMI_CODE_HOME: '/tmp/acct/kimi' }))
      .toBe('/tmp/acct/kimi/mcp.json');
    expect(mcpConfigPath(KIMI, { HOME: '/tmp/acct' })).toBe('/tmp/acct/.kimi-code/mcp.json');
  });

  it('ignores a variable that is set but blank', () => {
    expect(mcpConfigPath(KIMI, { HOME: '/tmp/acct', KIMI_CODE_HOME: '   ' })).toBe('/tmp/acct/.kimi-code/mcp.json');
  });
});

describe('the server entry', () => {
  it('spells a local server as a command with its arguments', () => {
    expect(mcpConfigEntry({ name: 'x', target: 'npx', args: ['-y', 'pkg'] }))
      .toEqual({ command: 'npx', args: ['-y', 'pkg'] });
  });

  it('spells a remote server as a url, with no empty args key', () => {
    expect(mcpConfigEntry({ name: 'x', target: 'https://mcp.example.com/sse' }))
      .toEqual({ url: 'https://mcp.example.com/sse' });
    expect(mcpConfigEntry({ name: 'x', target: 'npx' })).toEqual({ command: 'npx' });
  });
});

describe('merging into a file that is the user\'s', () => {
  const fresh = async () => join(await mkdtemp(join(tmpdir(), 'clikcode-mcp-')), 'mcp.json');

  it('creates the file and its directory when neither exists', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'clikcode-mcp-')), 'deep', 'mcp.json');
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx' });
    expect(await read(path)).toEqual({ mcpServers: { one: { command: 'npx' } } });
  });

  it('keeps every other server, and every key it does not know about', async () => {
    const path = await fresh();
    await writeFile(path, JSON.stringify({
      someOtherKey: { keep: true },
      mcpServers: { 'already-here': { command: 'echo', args: ['mine'] } },
    }));
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'added', target: 'npx', args: ['-y'] });
    expect(await read(path)).toEqual({
      someOtherKey: { keep: true },
      mcpServers: {
        'already-here': { command: 'echo', args: ['mine'] },
        added: { command: 'npx', args: ['-y'] },
      },
    });
  });

  it('replaces only the entry of the same name, which makes re-installing idempotent', async () => {
    const path = await fresh();
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx', args: ['old'] });
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx', args: ['new'] });
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'two', target: 'npx' });
    const after = await read(path);
    expect(after.mcpServers).toEqual({ one: { command: 'npx', args: ['new'] }, two: { command: 'npx' } });
  });

  it('adds the key when the file exists without it', async () => {
    const path = await fresh();
    await writeFile(path, JSON.stringify({ unrelated: 1 }));
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx' });
    expect(await read(path)).toEqual({ unrelated: 1, mcpServers: { one: { command: 'npx' } } });
  });

  it('replaces a key holding the wrong type rather than crashing on it', async () => {
    const path = await fresh();
    await writeFile(path, JSON.stringify({ mcpServers: 'nonsense' }));
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx' });
    expect(await read(path)).toEqual({ mcpServers: { one: { command: 'npx' } } });
  });

  it('refuses a file that is not a JSON object instead of overwriting it', async () => {
    // It might be someone else's file entirely. Losing it is far worse than
    // declining to add one server.
    const path = await fresh();
    await writeFile(path, JSON.stringify(['not', 'an', 'object']));
    await expect(writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx' }))
      .rejects.toThrow(/not a JSON object/);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['not', 'an', 'object']);
  });

  it('treats an empty file as an empty object', async () => {
    const path = await fresh();
    await writeFile(path, '   \n');
    await writeMcpConfigEntry(path, 'mcpServers', { name: 'one', target: 'npx' });
    expect(await read(path)).toEqual({ mcpServers: { one: { command: 'npx' } } });
  });
});
