import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hooksForWorkspace, toolHooksFrom } from './hooks.js';
import { addMarketplace, addPlugin, findPlugin, listMarketplaces, removeMarketplace, removePlugin, setPluginEnabled } from './plugin-install.js';
import {
  enabledPluginAgents, enabledPluginCommandDirs, enabledPluginMcpServers, listPlugins, pluginDataDir, resolveAgentType,
} from './plugins.js';
import { discoverSkills } from './skills.js';
import { skillTool } from './tools/skill.js';
import { discoverCustomCommands, expandCustomCommand } from '../session/custom-commands.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { ScriptedModelClient, type ScriptEntry } from './testing.js';
import type { ModelClient, ModelStepRequest, ModelStepResult } from './model-client.js';
import type { ToolContext } from './tool-contract.js';

// The slash-command context loads the bundled router through the bridge; the
// catalog's own functions stand in for it in a source test.
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness');
  return { ...(await importOriginal<object>()), localHarnessForCommand: router.localHarnessForCommand };
});

const run = promisify(execFile);
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugin-marketplace');
const DEMO = path.join(FIXTURE, 'plugins', 'demo');

let root: string;
let stateDir: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plugins-')));
  stateDir = path.join(root, 'state');
  home = path.join(root, 'home');
  cwd = path.join(root, 'work');
  await Promise.all([stateDir, home, cwd].map((dir) => fs.mkdir(dir, { recursive: true })));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function gitRepo(from: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.cp(from, repo, { recursive: true });
  const git = (...args: string[]) => run('git', ['-c', 'user.name=Jgracier', '-c', 'user.email=Jgracier@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd: repo });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'fixture');
  return repo;
}

function skillContext(): ToolContext {
  return { cwd, stateDir, homeDir: home, turnId: 'turn-1' } as unknown as ToolContext;
}

describe('plugins', () => {
  it('installs from a directory and wires every part into the agent', async () => {
    const { id, record } = await addPlugin({ stateDir, home }, DEMO);
    expect(id).toBe('demo');
    expect(record).toMatchObject({ name: 'demo', version: '1.2.3', enabled: true });
    const installed = record.path;
    expect(installed.startsWith(path.join(stateDir, 'plugins', 'cache'))).toBe(true);
    expect(listPlugins({ stateDir, home })).toMatchObject([{ id: 'demo', origin: 'clikcode', enabled: true }]);

    // skills: in the catalog, ${CLAUDE_PLUGIN_ROOT} expanded when loaded
    const catalog = await discoverSkills({ cwd, stateDir, homeDir: home });
    expect(catalog.skills.find((skill) => skill.name === 'demo-skill')).toMatchObject({ source: 'plugin', pluginRoot: installed });
    const loaded = await skillTool.run({ name: 'demo-skill' }, skillContext());
    expect(loaded.output).toContain(`Read ${installed}/notes.txt first.`);

    // commands: a template with $ARGUMENTS and the plugin root expanded
    const commands = discoverCustomCommands(undefined, { workspace: cwd, home, clikcodeDirs: [], plugins: enabledPluginCommandDirs({ stateDir, home }) });
    const greet = commands.find((command) => command.name === 'greet');
    expect(greet).toMatchObject({ description: 'Greet someone', argumentHint: '<name>' });
    expect(expandCustomCommand(greet!, 'Ada')).toBe(`Greet Ada, using the notes in ${installed}/notes.txt.`);

    // hooks: merged, expanded, and given the plugin's environment
    const config = await hooksForWorkspace({ cwd, stateDir, home, notice: () => undefined });
    expect(config.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(`sh "${installed}/hooks/guard.sh"`);
    const hooks = toolHooksFrom(config);
    const verdict = await hooks!.preToolUse!({ id: 'c1', name: 'bash', args: { command: 'ls' } }, { sessionId: 's', cwd } as never);
    expect(verdict).toEqual({ deny: `blocked by demo plugin data=${pluginDataDir(stateDir, 'demo')} root=${installed}` });
    expect(await hooks!.preToolUse!({ id: 'c2', name: 'read_file', args: { path: 'x' } }, { sessionId: 's', cwd } as never)).toBeUndefined();

    // MCP servers: Claude Code's names, plugin root and ${VAR:-default} expanded
    expect(enabledPluginMcpServers({ stateDir, home })).toEqual([
      { name: 'plugin:demo:echo', transport: 'stdio', command: 'node', args: [`${installed}/server.mjs`, 'plain'], env: {} },
      { name: 'plugin:demo:remote', transport: 'http', url: 'https://mcp.example.invalid/mcp', headers: {} },
    ]);

    // agents: a subagent type with its prompt and Claude-named tools
    expect(enabledPluginAgents({ stateDir, home })).toEqual([
      { name: 'reviewer', plugin: 'demo', description: 'Reviews code for the demo plugin', prompt: 'You are the demo reviewer. Read the code and report problems.', tools: ['Read', 'Grep'] },
    ]);
    expect(resolveAgentType({ stateDir, home }, 'demo:reviewer')).toMatchObject({ agentType: { name: 'reviewer' } });
    expect(resolveAgentType({ stateDir, home }, 'nope')).toEqual({ error: 'No agent type "nope". Available: reviewer.' });
    expect(resolveAgentType({ stateDir, home }, undefined)).toEqual({});
  });

  it('disables, enables and removes a plugin', async () => {
    const { record } = await addPlugin({ stateDir, home }, DEMO);
    await setPluginEnabled({ stateDir, home }, 'demo', false);
    expect(listPlugins({ stateDir, home })[0]?.enabled).toBe(false);
    expect(enabledPluginMcpServers({ stateDir, home })).toEqual([]);
    expect((await discoverSkills({ cwd, stateDir, homeDir: home })).skills.map((skill) => skill.name)).not.toContain('demo-skill');
    expect(await hooksForWorkspace({ cwd, stateDir, home, notice: () => undefined })).toEqual({});
    await setPluginEnabled({ stateDir, home }, 'demo', true);
    expect(enabledPluginAgents({ stateDir, home })).toHaveLength(1);
    await removePlugin({ stateDir, home }, 'demo');
    expect(listPlugins({ stateDir, home })).toEqual([]);
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => findPlugin({ stateDir, home }, 'demo')).toThrow('No plugin named demo');
  });

  it('installs name@marketplace from a local marketplace', async () => {
    await expect(addPlugin({ stateDir, home }, 'demo@fixture-market')).rejects.toThrow('No marketplace named fixture-market');
    const market = await addMarketplace({ stateDir, home }, FIXTURE);
    expect(market).toMatchObject({ name: 'fixture-market', path: FIXTURE });
    const { id, record } = await addPlugin({ stateDir, home }, 'demo@fixture-market');
    expect(id).toBe('demo@fixture-market');
    expect(record).toMatchObject({ marketplace: 'fixture-market', version: '1.2.3' });
    expect(enabledPluginAgents({ stateDir, home }).map((agent) => agent.name)).toEqual(['reviewer']);
    await expect(addPlugin({ stateDir, home }, 'missing@fixture-market')).rejects.toThrow('lists no plugin named missing');
    expect(await removeMarketplace({ stateDir, home }, 'fixture-market')).toBe(true);
    // A local marketplace is read in place; removing it leaves the directory alone.
    expect((await fs.stat(FIXTURE)).isDirectory()).toBe(true);
  });

  it('installs from a git URL, a git marketplace, and a marketplace entry that points at a repository', async () => {
    const pluginRepo = await gitRepo(DEMO, 'demo-repo');
    const direct = await addPlugin({ stateDir, home }, `file://${pluginRepo}`);
    expect(direct.id).toBe('demo');
    await expect(fs.stat(path.join(direct.record.path, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(direct.record.path, 'agents', 'reviewer.md'), 'utf8')).toContain('demo reviewer');

    const marketRepo = await gitRepo(FIXTURE, 'market-repo');
    const market = await addMarketplace({ stateDir, home }, `file://${marketRepo}`);
    expect(market.path).toBe(path.join(stateDir, 'plugins', 'marketplaces', 'fixture-market'));
    const fromMarket = await addPlugin({ stateDir, home }, 'demo@fixture-market');
    expect(fromMarket.record.path).toBe(path.join(stateDir, 'plugins', 'cache', 'demo@fixture-market'));

    const remoteMarket = path.join(root, 'remote-market');
    await fs.mkdir(path.join(remoteMarket, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(remoteMarket, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'remote-market', plugins: [{ name: 'demo', source: { source: 'url', url: `file://${pluginRepo}` } }],
    }));
    await addMarketplace({ stateDir, home }, remoteMarket);
    const remote = await addPlugin({ stateDir, home }, 'demo@remote-market');
    expect(remote.record).toMatchObject({ name: 'demo', marketplace: 'remote-market', version: '1.2.3' });
    // Three installs of one plugin: the bare agent name is ambiguous, so it is namespaced.
    expect(enabledPluginAgents({ stateDir, home }).map((agent) => agent.name)).toEqual(['demo:reviewer']);
    expect(listMarketplaces({ stateDir, home }).map((item) => item.name).sort()).toEqual(['fixture-market', 'remote-market']);
    await fs.rm(path.join(stateDir, 'plugins', 'tmp'), { recursive: true, force: true });
  });

  it('discovers Claude Code\'s installed plugins read-only, and keeps enable/disable in ClikCode', async () => {
    const claudeDir = path.join(home, '.claude');
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-market', 'demo', '1.2.3');
    await fs.cp(DEMO, installPath, { recursive: true });
    const installed = JSON.stringify({ version: 2, plugins: { 'demo@claude-market': [
      { scope: 'project', projectPath: '/elsewhere', installPath: '/nonexistent', version: '0.0.1' },
      { scope: 'user', installPath, version: '1.2.3' },
    ] } });
    const settings = JSON.stringify({ enabledPlugins: { 'demo@claude-market': false } });
    await fs.writeFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), installed);
    await fs.writeFile(path.join(claudeDir, 'settings.json'), settings);
    await fs.writeFile(path.join(claudeDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'claude-market': { installLocation: FIXTURE } }));

    expect(listPlugins({ stateDir, home })).toMatchObject([{ id: 'demo@claude-market', origin: 'claude', enabled: false, root: installPath, version: '1.2.3' }]);
    await setPluginEnabled({ stateDir, home }, 'demo@claude-market', true);
    expect(enabledPluginMcpServers({ stateDir, home }).map((server) => server.name)).toEqual(['plugin:demo:echo', 'plugin:demo:remote']);
    await expect(removePlugin({ stateDir, home }, 'demo@claude-market')).rejects.toThrow('installed by Claude Code');
    // Claude Code's marketplaces are offered too, read in place.
    expect(listMarketplaces({ stateDir, home })).toEqual([{ name: 'claude-market', path: FIXTURE, origin: 'claude' }]);
    // Nothing under ~/.claude was written.
    expect(await fs.readFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).toBe(installed);
    expect(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(settings);
  });

  it('gives a plugin\'s commands to ClikCode\'s own agent sessions only', async () => {
    const { record } = await addPlugin({ stateDir, home }, DEMO);
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = stateDir;
    try {
      const { customCommandsFor } = await import('../tui/slash/context.js');
      const command = customCommandsFor({ id: 's', route: 'gateway', workspace: cwd } as never, undefined).find((item) => item.name === 'greet');
      expect(command?.body).toContain(`${record.path}/notes.txt`);
      expect(customCommandsFor({ id: 's', workspace: cwd, nativeHarness: 'codex' } as never, undefined).map((item) => item.name)).not.toContain('greet');
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  });
});

class RoutedModelClient implements ModelClient {
  readonly clients = new Map<string, ScriptedModelClient>();
  constructor(routes: Record<string, ScriptEntry[]>) {
    for (const [prompt, script] of Object.entries(routes)) this.clients.set(prompt, new ScriptedModelClient(script));
  }
  step(request: ModelStepRequest): Promise<ModelStepResult> {
    const first = request.items.find((item) => item.type === 'text' && item.role === 'user');
    const prompt = first?.type === 'text' ? first.text.replace(/^<environment>[\s\S]*?<\/environment>\n\n/, '') : '';
    const client = this.clients.get(prompt);
    if (!client) throw new Error(`No script for prompt: ${prompt}`);
    return client.step(request);
  }
}

describe('plugin agent types', () => {
  it('runs task with subagent_type: the agent\'s prompt, and only its tools', async () => {
    await addPlugin({ stateDir, home }, DEMO);
    await fs.writeFile(path.join(cwd, 'a.txt'), 'x = 1\n');
    const client = new RoutedModelClient({
      parent: [
        { toolCalls: [{ id: 'bad', name: 'task', args: { prompt: 'Review a.txt', subagent_type: 'nope' } }] },
        { toolCalls: [{ id: 't1', name: 'task', args: { prompt: 'Review a.txt', subagent_type: 'reviewer' } }] },
        { text: 'Reviewed.' },
      ],
      'Review a.txt': [{ text: 'a.txt:1 looks fine.' }],
    });
    const result = await runGatewayHarnessTurn({
      sessionId: 'p1', cwd, stateDir, homeDir: home, userConfigDir: path.join(root, 'config'),
      prompt: 'parent', permissionMode: 'bypass', modelClient: client,
    });
    expect(result.stopReason).toBe('completed');
    const parent = client.clients.get('parent')!.requests;
    expect(parent[0]!.system).toContain('# Agent types');
    expect(parent[0]!.system).toContain('- reviewer: Reviews code for the demo plugin');
    const results = (request: ModelStepRequest) => request.items.flatMap((item) => (item.type === 'tool_result' ? [item.output] : []));
    expect(results(parent[1]!)).toContain('No agent type "nope". Available: reviewer.');
    expect(results(parent[2]!).at(-1)).toContain('a.txt:1 looks fine.');
    const child = client.clients.get('Review a.txt')!.requests[0]!;
    expect(child.system).toContain('# Agent: reviewer\nYou are the demo reviewer.');
    expect(child.tools.map((tool) => tool.name).sort()).toEqual(['grep', 'read_file']);
  });
});
