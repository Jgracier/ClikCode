/** A chosen harness receives what it is missing, and keeps what it already has. */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import type { AiHarnessAccount } from './definition.js';
import { provisionChosenHarness, skillRoot } from './provision.js';
import { vendorMcpServerNames } from '../agent/mcp/import.js';
import { writeMcpConfigEntry } from './mcp-registry.js';
import { conversationsForAcpSession, conversationsMcpEntry } from '../search/mcp-entry.js';

const cursor = allLocalHarnesses().find((item) => item.command === 'cursor')!;
const grok = allLocalHarnesses().find((item) => item.command === 'grok')!;

function account(home: string): AiHarnessAccount {
  return {
    id: 'acct', provider: 'cursor', label: 'Cursor', authKind: 'oauth', models: [], status: 'ready', credentialRef: 'none',
    nativeProfile: { env: 'HOME', path: home },
  };
}

async function layout(): Promise<{ home: string; state: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clikcode-provision-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  const workspace = join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { home, state, workspace };
}

describe('provisioning the harness that was chosen', () => {
  it('adds an MCP server that is missing and leaves a different command under the same name', async () => {
    const { home, state, workspace } = await layout();
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { kept: { command: 'echo', args: ['mine'] } },
    }));
    await writeFile(join(state, 'mcp.json'), JSON.stringify({
      mcpServers: {
        kept: { command: 'npx', args: ['-y', 'other'] },
        fresh: { command: 'npx', args: ['-y', 'fresh-mcp'] },
      },
    }));
    const install: NonNullable<Parameters<typeof provisionChosenHarness>[0]['install']> = async (_harness, entry) => {
      await writeMcpConfigEntry(join(home, '.cursor', 'mcp.json'), 'mcpServers', entry);
      return { harness: 'cursor', ok: true };
    };
    const result = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home, install });
    expect(result.mcpInstalled).toEqual(['fresh']);
    const written = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(written.mcpServers.kept).toEqual({ command: 'echo', args: ['mine'] });
    expect(written.mcpServers.fresh).toEqual({ command: 'npx', args: ['-y', 'fresh-mcp'] });
    const again = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home, install });
    expect(again.mcpInstalled).toEqual([]);
  });

  it("gives every harness ClikCode's conversation server, once, unless a server by that name is already there", async () => {
    const { home, state, workspace } = await layout();
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const builtin = conversationsMcpEntry('/opt/clikcode/bin/clikcode', '/usr/bin/node', 'linux', () => true)!;
    expect(builtin).toEqual({ name: 'clikcode-conversations', target: '/opt/clikcode/bin/clikcode', args: ['conversations-mcp'] });
    expect(conversationsMcpEntry('/x/dist/index.js', '/usr/bin/node', 'linux', () => false)!.args).toEqual(['/x/dist/index.js', 'conversations-mcp']);
    const install: NonNullable<Parameters<typeof provisionChosenHarness>[0]['install']> = async (_harness, entry) => {
      await writeMcpConfigEntry(join(home, '.cursor', 'mcp.json'), 'mcpServers', entry);
      return { harness: 'cursor', ok: true };
    };
    const first = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home, install, builtins: [builtin] });
    expect(first.mcpInstalled).toEqual(['clikcode-conversations']);
    const written = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['clikcode-conversations']).toEqual({ command: '/opt/clikcode/bin/clikcode', args: ['conversations-mcp'] });
    const again = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home, install, builtins: [builtin] });
    expect(again.mcpInstalled).toEqual([]);
    // The user's own server by that name is theirs.
    const other = await layout();
    await mkdir(join(other.home, '.cursor'), { recursive: true });
    await writeFile(join(other.state, 'mcp.json'), JSON.stringify({ mcpServers: { 'clikcode-conversations': { command: 'mine' } } }));
    const entries: string[] = [];
    await provisionChosenHarness({
      harness: cursor, account: account(other.home), workspace: other.workspace, stateDir: other.state, home: other.home, builtins: [builtin],
      install: async (_harness, entry) => { entries.push(entry.target); return { harness: 'cursor', ok: true }; },
    });
    expect(entries).toEqual(['mine']);
  });

  it('hands the conversation server to the ACP session of a vendor whose config cannot take it', async () => {
    // opencode adds only remote servers; the real install declines a local
    // one without running anything, so the session carries it instead.
    const opencode = allLocalHarnesses().find((item) => item.command === 'opencode')!;
    const { home, state, workspace } = await layout();
    const builtin = conversationsMcpEntry('/opt/clikcode/bin/clikcode', '/usr/bin/node', 'linux', () => true)!;
    const provisioned = await provisionChosenHarness({
      harness: opencode, account: { ...account(home), provider: 'opencode' }, workspace, stateDir: state, home, builtins: [builtin],
    });
    expect(provisioned.mcpSkipped).toEqual(['clikcode-conversations']);
    expect(conversationsForAcpSession(builtin, provisioned.mcpSkipped, { CLIKCODE_SESSION_ID: 's1' })).toEqual([
      { name: 'clikcode-conversations', command: '/opt/clikcode/bin/clikcode', args: ['conversations-mcp'], env: [{ name: 'CLIKCODE_SESSION_ID', value: 's1' }] },
    ]);
    // Given through the vendor's own config: not handed over a second time.
    expect(conversationsForAcpSession(builtin, [], { CLIKCODE_SESSION_ID: 's1' })).toEqual([]);
  });

  it('does not write into an MCP file it cannot parse', async () => {
    const { home, state, workspace } = await layout();
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.cursor', 'mcp.json'), '{');
    await writeFile(join(state, 'mcp.json'), JSON.stringify({ mcpServers: { fresh: { command: 'npx' } } }));
    const result = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home });
    expect(result.mcpInstalled).toEqual([]);
    expect(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{');
  });

  it('copies a skill that is missing and does not replace one that is there', async () => {
    const { home, state, workspace } = await layout();
    await mkdir(join(state, 'skills', 'demo'), { recursive: true });
    await writeFile(join(state, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill\n---\n\nDo the demo.\n');
    await mkdir(join(workspace, '.clikcode', 'skills', 'local'), { recursive: true });
    await writeFile(join(workspace, '.clikcode', 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: For this repo\n---\n\nLocal.\n');
    await mkdir(join(home, '.cursor', 'skills', 'demo'), { recursive: true });
    await writeFile(join(home, '.cursor', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Mine\n---\n\nLeave me.\n');
    const result = await provisionChosenHarness({ harness: cursor, account: account(home), workspace, stateDir: state, home });
    expect(result.skillsCopied).toEqual(['local']);
    expect(await readFile(join(home, '.cursor', 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain('Leave me.');
    expect(await readFile(join(workspace, '.cursor', 'skills', 'local', 'SKILL.md'), 'utf8')).toContain('Local.');
  });

});

describe('where a harness keeps what it was given', () => {
  it('treats a vendor root profile as that root, and HOME as a home', () => {
    expect(skillRoot(['.qwen', 'skills'], '/home/me', { env: 'QWEN_HOME', path: '/profiles/qwen' })).toBe('/profiles/qwen/skills');
    expect(skillRoot(['.cursor', 'skills'], '/home/me', { env: 'HOME', path: '/profiles/home' })).toBe('/profiles/home/.cursor/skills');
  });

  it('knows Command Code\'s user MCP file, and does not invent one for a harness it has not seen', async () => {
    const known = await vendorMcpServerNames('command', '/no/such/home');
    expect(known.known).toBe(true);
    expect([...known.names]).toEqual([]);
    expect((await vendorMcpServerNames('aider', '/no/such/home')).known).toBe(false);
  });

  it('counts only the profile\'s own file for an isolated profile', async () => {
    const { home } = await layout();
    const profile = join(home, 'profiles', 'claude', 'one');
    await mkdir(profile, { recursive: true });
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'only-home': { command: 'npx' } } }));
    await writeFile(join(profile, '.claude.json'), JSON.stringify({ mcpServers: { 'in-profile': { command: 'npx' } } }));
    const names = await vendorMcpServerNames('claude', home, { env: 'CLAUDE_CONFIG_DIR', path: profile });
    expect([...names.names]).toEqual(['in-profile']);
    expect([...(await vendorMcpServerNames('claude', home)).names]).toEqual(['only-home']);
  });

  it('does not give Grok an MCP server or skill Claude already provides', async () => {
    const { home, state, workspace } = await layout();
    await mkdir(join(home, '.claude', 'skills', 'from-claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'from-claude', 'SKILL.md'), '---\nname: from-claude\ndescription: Already visible\n---\n\nThere.\n');
    await mkdir(join(state, 'skills', 'only-here'), { recursive: true });
    await writeFile(join(state, 'skills', 'only-here', 'SKILL.md'), '---\nname: only-here\ndescription: Not in Claude\n---\n\nHere.\n');
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'mc-brain': { command: 'npx' } } }));
    await writeFile(join(state, 'mcp.json'), JSON.stringify({ mcpServers: { 'mc-brain': { command: 'npx', args: ['-y', 'mcp-remote'] } } }));
    const result = await provisionChosenHarness({
      harness: grok, workspace, stateDir: state, home,
      install: async () => { throw new Error('should not install a server Grok already reads'); },
    });
    expect(result.mcpInstalled).toEqual([]);
    expect(result.skillsCopied).toEqual(['only-here']);
    expect(await readFile(join(home, '.grok', 'skills', 'only-here', 'SKILL.md'), 'utf8')).toContain('Not in Claude');
  });

});
