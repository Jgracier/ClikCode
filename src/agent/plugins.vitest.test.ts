import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hooksForWorkspace, toolHooksFrom } from './hooks.js';
import {
  enabledPluginAgents, enabledPluginCommandDirs, enabledPluginMcpServers, findPlugin, listPlugins, pluginDataDir, resolveAgentType, setPluginEnabled,
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

const ID = 'demo@claude-market';

/** The demo plugin, installed for Claude Code as its `/plugin` leaves it. */
async function installForClaude(settings?: object): Promise<string> {
  const claudeDir = path.join(home, '.claude');
  const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-market', 'demo', '1.2.3');
  await fs.cp(DEMO, installPath, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: [
    { scope: 'project', projectPath: '/elsewhere', installPath: '/nonexistent', version: '0.0.1' },
    { scope: 'user', installPath, version: '1.2.3' },
  ] } }));
  if (settings) await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(settings));
  return installPath;
}

function skillContext(): ToolContext {
  return { cwd, stateDir, homeDir: home, turnId: 'turn-1' } as unknown as ToolContext;
}

describe('plugins', () => {
  it("wires every part of a Claude Code plugin into the agent", async () => {
    const installed = await installForClaude();
    expect(listPlugins({ stateDir, home })).toMatchObject([{ id: ID, name: 'demo', version: '1.2.3', enabled: true, root: installed }]);

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
    expect(verdict).toEqual({ deny: `blocked by demo plugin data=${pluginDataDir(stateDir, ID)} root=${installed}` });
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

  it('reads Claude Code\'s plugins in place, and keeps enable/disable in ClikCode', async () => {
    const installPath = await installForClaude({ enabledPlugins: { [ID]: false } });
    const claudeDir = path.join(home, '.claude');
    const installed = await fs.readFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8');
    const settings = await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8');

    expect(listPlugins({ stateDir, home })).toMatchObject([{ id: ID, enabled: false, root: installPath, version: '1.2.3' }]);
    expect(enabledPluginMcpServers({ stateDir, home })).toEqual([]);
    expect((await discoverSkills({ cwd, stateDir, homeDir: home })).skills.map((skill) => skill.name)).not.toContain('demo-skill');
    expect(await hooksForWorkspace({ cwd, stateDir, home, notice: () => undefined })).toEqual({});
    await setPluginEnabled({ stateDir, home }, 'demo', true);
    expect(enabledPluginMcpServers({ stateDir, home }).map((server) => server.name)).toEqual(['plugin:demo:echo', 'plugin:demo:remote']);
    expect(enabledPluginAgents({ stateDir, home })).toHaveLength(1);
    await setPluginEnabled({ stateDir, home }, ID, false);
    expect(listPlugins({ stateDir, home })[0]?.enabled).toBe(false);
    expect(() => findPlugin({ stateDir, home }, 'nope')).toThrow('No plugin named nope');
    // Nothing under ~/.claude was written.
    expect(await fs.readFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).toBe(installed);
    expect(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(settings);
  });

  it('gives a plugin\'s commands to ClikCode\'s own agent sessions only', async () => {
    const installed = await installForClaude();
    const previous = process.env.CLIKCODE_HOME;
    const previousHome = process.env.HOME;
    process.env.CLIKCODE_HOME = stateDir;
    process.env.HOME = home;
    try {
      const { customCommandsFor } = await import('../tui/slash/context.js');
      const command = customCommandsFor({ id: 's', route: 'gateway', workspace: cwd } as never, undefined).find((item) => item.name === 'greet');
      expect(command?.body).toContain(`${installed}/notes.txt`);
      expect(customCommandsFor({ id: 's', workspace: cwd, nativeHarness: 'codex' } as never, undefined).map((item) => item.name)).not.toContain('greet');
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
      process.env.HOME = previousHome;
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
    await installForClaude();
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
