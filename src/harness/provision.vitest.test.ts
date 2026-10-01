/** A chosen harness receives what it is missing, and keeps what it already has. */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import type { AiHarnessAccount } from './definition.js';
import { hookShare, provisionChosenHarness, skillRoot, syncClaudeHookFile } from './provision.js';
import { vendorMcpServerNames } from '../agent/mcp/import.js';
import { writeMcpConfigEntry } from './mcp-registry.js';

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

  it('adds a hook command that is missing and keeps the one already in the file', async () => {
    const { home } = await layout();
    const file = join(home, 'settings.json');
    await writeFile(file, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      other: 1,
    }));
    const incoming = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'echo new' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    };
    expect(await syncClaudeHookFile(file, incoming)).toBe(2);
    const written = JSON.parse(await readFile(file, 'utf8')) as { other: number; hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    expect(written.other).toBe(1);
    expect(written.hooks.PreToolUse[0].hooks.map((hook) => hook.command)).toEqual(['echo mine']);
    expect(written.hooks.PreToolUse[1].hooks.map((hook) => hook.command)).toEqual(['echo new']);
    expect(await syncClaudeHookFile(file, incoming)).toBe(0);
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

  it('names who already runs Claude\'s hooks', () => {
    expect(hookShare('claude')).toBe('inherits');
    expect(hookShare('grok')).toBe('inherits');
    expect(hookShare('codex')).toBe('different');
  });
});
