/** Plugins in Claude Code's format: a directory with an optional
 * `.claude-plugin/plugin.json` and conventional parts --
 *
 *   commands/*.md      slash commands (prompt templates, `$ARGUMENTS`)
 *   agents/*.md        subagent types (frontmatter name/description/tools, body = prompt)
 *   skills/<n>/SKILL.md
 *   hooks/hooks.json   `{ "hooks": { "PreToolUse": [...] } }`
 *   .mcp.json          `{ "mcpServers": { ... } }` (or the bare table)
 *
 * Each part joins what ClikCode's own agent already has: skills the skill
 * catalog, commands the custom slash commands, hooks the hook config, MCP
 * servers the turn's servers, agents the `agent`/`task` tools' types.
 * `${CLAUDE_PLUGIN_ROOT}` is expanded as Claude Code expands it.
 *
 * Two places hold plugins:
 *   - ClikCode's own, `<state dir>/plugins/plugins.json`, written by
 *     `clikcode plugin` (plugin-install.ts).
 *   - The ones the user installed for Claude Code, read live from
 *     `~/.claude/plugins/installed_plugins.json` (user scope), enabled as
 *     Claude's settings say unless ClikCode's file says otherwise. Never
 *     written: enabling or disabling one here is recorded in ClikCode's file.
 *
 * Everything here is synchronous and reads small files: the slash-command
 * list is built synchronously, and a plugin is a handful of entries. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HookConfig } from './hooks.js';
import { parseMcpServerEntry, type McpServerSpec } from './mcp/config.js';
import { parseFrontmatter } from './skills.js';

export const PLUGIN_MANIFEST = path.join('.claude-plugin', 'plugin.json');
export const MARKETPLACE_MANIFEST = path.join('.claude-plugin', 'marketplace.json');
const REGISTRY_FILE = 'plugins.json';
const MAX_AGENT_FILES = 100;
const MAX_FILE_BYTES = 256 * 1024;

export interface PluginRecord {
  name: string;
  /** Absolute path of the installed copy (or, for a local marketplace, the plugin in place). */
  path: string;
  /** What the user passed to `plugin add`. */
  source: string;
  marketplace?: string;
  version?: string;
  description?: string;
  enabled: boolean;
  installedAt: string;
}

export interface MarketplaceRecord { name: string; source: string; path: string; addedAt: string }

export interface PluginRegistry {
  plugins: Record<string, PluginRecord>;
  marketplaces: Record<string, MarketplaceRecord>;
  /** Enable/disable choices made in ClikCode for Claude Code's plugins, by Claude's id. */
  claude: Record<string, { enabled: boolean }>;
}

export interface InstalledPlugin {
  /** `name@marketplace`, or the bare name of one added from a path or URL. */
  id: string;
  name: string;
  root: string;
  origin: 'clikcode' | 'claude';
  enabled: boolean;
  version?: string;
  description?: string;
}

export interface PluginRoots { stateDir: string; home?: string }

export interface PluginAgent {
  name: string;
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Claude Code tool names (`Read`, `Grep`, `mcp__x__y`); absent = the kind's default set. */
  tools?: string[];
  plugin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch {
    // fail-open-ok: a missing or unreadable file declares nothing
    return undefined;
  }
}

export function pluginsDirectory(stateDir: string): string {
  return path.join(stateDir, 'plugins');
}

export function pluginRegistryPath(stateDir: string): string {
  return path.join(pluginsDirectory(stateDir), REGISTRY_FILE);
}

export function readPluginRegistry(stateDir: string): PluginRegistry {
  const raw = readJson(pluginRegistryPath(stateDir));
  const table = (key: string) => (isRecord(raw) && isRecord(raw[key]) ? raw[key] : {});
  return {
    plugins: table('plugins') as PluginRegistry['plugins'],
    marketplaces: table('marketplaces') as PluginRegistry['marketplaces'],
    claude: table('claude') as PluginRegistry['claude'],
  };
}

export function claudePluginsDirectory(home: string = homedir()): string {
  return path.join(home, '.claude', 'plugins');
}

// ── manifest ─────────────────────────────────────────────────────────────────

export interface PluginManifest {
  name?: string; version?: string; description?: string;
  commands?: unknown; agents?: unknown; skills?: unknown; hooks?: unknown; mcpServers?: unknown;
}

export function readPluginManifest(root: string): PluginManifest | undefined {
  const raw = readJson(path.join(root, PLUGIN_MANIFEST));
  return isRecord(raw) ? raw as PluginManifest : undefined;
}

/** A directory Claude Code would load as a plugin: a manifest, or at least one conventional part. */
export function looksLikePlugin(root: string): boolean {
  return existsSync(path.join(root, PLUGIN_MANIFEST))
    || ['commands', 'agents', 'skills', path.join('hooks', 'hooks.json'), '.mcp.json'].some((part) => existsSync(path.join(root, part)));
}

// ── which plugins ────────────────────────────────────────────────────────────

/** Claude Code's user-scope plugins: `installed_plugins.json` (version 2 keeps
 * a list per id, version 1 one entry), enabled unless its settings say false. */
export function claudeInstalledPlugins(home: string = homedir()): Array<Omit<InstalledPlugin, 'enabled'> & { claudeEnabled: boolean }> {
  const record = readJson(path.join(claudePluginsDirectory(home), 'installed_plugins.json'));
  const table = isRecord(record) && isRecord(record.plugins) ? record.plugins : isRecord(record) ? record : {};
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const found: Array<Omit<InstalledPlugin, 'enabled'> & { claudeEnabled: boolean }> = [];
  for (const [id, value] of Object.entries(table)) {
    if (id === 'version') continue;
    const entries = (Array.isArray(value) ? value : [value]).filter(isRecord);
    const entry = entries.find((item) => (item.scope ?? 'user') === 'user');
    const root = typeof entry?.installPath === 'string' ? entry.installPath : undefined;
    if (!root || !existsSync(root)) continue;
    const manifest = readPluginManifest(root);
    found.push({
      id, name: manifest?.name ?? id.split('@')[0]!, root, origin: 'claude', claudeEnabled: enabled[id] !== false,
      ...(typeof entry?.version === 'string' ? { version: entry.version } : manifest?.version ? { version: manifest.version } : {}),
      ...(manifest?.description ? { description: manifest.description } : {}),
    });
  }
  return found;
}

/** Every plugin ClikCode knows: its own first, then Claude Code's (an id in both is ClikCode's). */
export function listPlugins(roots: PluginRoots): InstalledPlugin[] {
  const registry = readPluginRegistry(roots.stateDir);
  const own: InstalledPlugin[] = Object.entries(registry.plugins).map(([id, record]) => ({
    id, name: record.name, root: record.path, origin: 'clikcode', enabled: record.enabled !== false,
    ...(record.version ? { version: record.version } : {}), ...(record.description ? { description: record.description } : {}),
  }));
  const ids = new Set(own.map((plugin) => plugin.id));
  const claude = claudeInstalledPlugins(roots.home ?? homedir()).filter((plugin) => !ids.has(plugin.id))
    .map(({ claudeEnabled, ...plugin }): InstalledPlugin => ({ ...plugin, enabled: registry.claude[plugin.id]?.enabled ?? claudeEnabled }));
  return [...own, ...claude];
}

export function enabledPlugins(roots: PluginRoots): InstalledPlugin[] {
  return listPlugins(roots).filter((plugin) => plugin.enabled && existsSync(plugin.root));
}

// ── parts ────────────────────────────────────────────────────────────────────

/** `${CLAUDE_PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_DATA}`) as Claude Code expands them. */
export function expandPluginRoot(text: string, root: string, dataDir?: string): string {
  let out = text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
  if (dataDir) out = out.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);
  return out;
}

/** A manifest path field: a string or a list of them, relative to the plugin. */
function manifestPaths(root: string, value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return list.map((item) => path.resolve(root, expandPluginRoot(item, root)))
    // A manifest cannot point outside its own plugin.
    .filter((item) => item === root || item.startsWith(`${root}${path.sep}`));
}

function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); } catch { return false; }
}

/** Directories of `<name>/SKILL.md` folders. */
export function pluginSkillDirs(plugin: Pick<InstalledPlugin, 'root'>): string[] {
  const manifest = readPluginManifest(plugin.root);
  return [...new Set([path.join(plugin.root, 'skills'), ...manifestPaths(plugin.root, manifest?.skills)])].filter(isDirectory);
}

/** Directories of `*.md` command templates. */
export function pluginCommandDirs(plugin: Pick<InstalledPlugin, 'root'>): string[] {
  const manifest = readPluginManifest(plugin.root);
  return [...new Set([path.join(plugin.root, 'commands'), ...manifestPaths(plugin.root, manifest?.commands)])].filter(isDirectory);
}

function toolList(value: unknown): string[] | undefined {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  const cleaned = list?.map((item) => item.trim()).filter(Boolean);
  return cleaned?.length ? cleaned : undefined;
}

function readAgentFile(file: string, plugin: Pick<InstalledPlugin, 'root' | 'name'>): PluginAgent | undefined {
  let text: string;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return undefined;
    text = readFileSync(file, 'utf8');
  } catch { return undefined; } // fail-open-ok: an unreadable agent file is simply not offered
  const parsed = parseFrontmatter(text);
  if ('error' in parsed) return undefined;
  const name = typeof parsed.fields.name === 'string' && parsed.fields.name.trim() ? parsed.fields.name.trim() : path.basename(file, '.md');
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.replace(/\s+/g, ' ').trim() : '';
  const prompt = expandPluginRoot(parsed.body.trim(), plugin.root);
  if (!/^[\w.:-]+$/.test(name) || !prompt) return undefined;
  const tools = toolList(parsed.fields.tools);
  return { name, description, prompt, plugin: plugin.name, ...(tools ? { tools } : {}) };
}

export function pluginAgents(plugin: Pick<InstalledPlugin, 'root' | 'name'>): PluginAgent[] {
  const manifest = readPluginManifest(plugin.root);
  const files: string[] = [];
  for (const entry of [path.join(plugin.root, 'agents'), ...manifestPaths(plugin.root, manifest?.agents)]) {
    if (isDirectory(entry)) {
      let names: string[] = [];
      try { names = readdirSync(entry).sort(); } catch { /* fail-open-ok: listed a moment ago */ }
      files.push(...names.filter((name) => name.toLowerCase().endsWith('.md')).map((name) => path.join(entry, name)));
    } else if (entry.toLowerCase().endsWith('.md') && existsSync(entry)) files.push(entry);
  }
  return [...new Set(files)].slice(0, MAX_AGENT_FILES).flatMap((file) => readAgentFile(file, plugin) ?? []);
}

/** The plugin's persistent data directory, `${CLAUDE_PLUGIN_DATA}`. */
export function pluginDataDir(stateDir: string, id: string): string {
  return path.join(pluginsDirectory(stateDir), 'data', id.replace(/[^\w.@-]/g, '_'));
}

/** hooks/hooks.json and the manifest's `hooks` (a path, a table, or a list of
 * either), commands expanded and given the plugin's environment. */
export function pluginHooks(plugin: Pick<InstalledPlugin, 'root' | 'id'>, stateDir: string): HookConfig {
  const manifest = readPluginManifest(plugin.root);
  const dataDir = pluginDataDir(stateDir, plugin.id);
  const sources: unknown[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string') manifestPaths(plugin.root, value).forEach((file) => sources.push(readJson(file)));
    else if (Array.isArray(value)) value.forEach(add);
    else if (isRecord(value)) sources.push(value);
  };
  add(path.join(plugin.root, 'hooks', 'hooks.json'));
  if (manifest?.hooks !== undefined) add(manifest.hooks);
  const merged: Record<string, unknown[]> = {};
  const seen = new Set<string>();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const table = isRecord(source.hooks) ? source.hooks : source;
    for (const [event, groups] of Object.entries(table)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isRecord(group)) continue;
        const key = JSON.stringify([event, group]);
        if (seen.has(key)) continue; // hooks.json named twice (default path and manifest)
        seen.add(key);
        const hooks = (Array.isArray(group.hooks) ? group.hooks : []).filter(isRecord).map((hook) => ({
          ...hook,
          ...(typeof hook.command === 'string' ? { command: expandPluginRoot(hook.command, plugin.root, dataDir) } : {}),
          env: { CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: dataDir },
        }));
        (merged[event] ??= []).push({ ...group, hooks });
      }
    }
  }
  return merged as HookConfig;
}

/** `${VAR}` and `${VAR:-default}` from the environment, as Claude Code expands .mcp.json. */
function expandEnv(text: string, root: string, dataDir: string): string {
  return expandPluginRoot(text, root, dataDir).replace(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
}

function expandDeep(value: unknown, root: string, dataDir: string): unknown {
  if (typeof value === 'string') return expandEnv(value, root, dataDir);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, root, dataDir));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandDeep(item, root, dataDir)]));
  return value;
}

/** Claude Code's name for a plugin's server, so its tools are named
 * `mcp__plugin_<plugin>_<server>__<tool>` here as there (hook matchers carry over). */
export function pluginServerName(plugin: string, server: string): string {
  return `plugin:${plugin}:${server}`;
}

/** .mcp.json and the manifest's `mcpServers` (a path or a table). */
export function pluginMcpServers(plugin: Pick<InstalledPlugin, 'root' | 'name' | 'id'>, stateDir: string): McpServerSpec[] {
  const manifest = readPluginManifest(plugin.root);
  const dataDir = pluginDataDir(stateDir, plugin.id);
  const tables: unknown[] = [readJson(path.join(plugin.root, '.mcp.json'))];
  const declared = manifest?.mcpServers;
  for (const item of Array.isArray(declared) ? declared : [declared]) {
    if (typeof item === 'string') manifestPaths(plugin.root, item).forEach((file) => tables.push(readJson(file)));
    else if (isRecord(item)) tables.push(item);
  }
  const servers = new Map<string, McpServerSpec>();
  for (const raw of tables) {
    if (!isRecord(raw)) continue;
    const table = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
    for (const [name, entry] of Object.entries(table)) {
      const fullName = pluginServerName(plugin.name, name);
      if (servers.has(fullName)) continue;
      const spec = parseMcpServerEntry(fullName, expandDeep(entry, plugin.root, dataDir));
      if (spec) servers.set(fullName, spec);
    }
  }
  return [...servers.values()];
}

// ── across enabled plugins ───────────────────────────────────────────────────

export function enabledPluginAgents(roots: PluginRoots): PluginAgent[] {
  const all = enabledPlugins(roots).flatMap((plugin) => pluginAgents(plugin));
  const count = new Map<string, number>();
  for (const agent of all) count.set(agent.name, (count.get(agent.name) ?? 0) + 1);
  // The bare name when no other plugin has it, else Claude Code's `plugin:agent`.
  const named = all.map((agent) => (count.get(agent.name) === 1 ? agent : { ...agent, name: `${agent.plugin}:${agent.name}` }));
  const seen = new Set<string>();
  return named.filter((agent) => !seen.has(agent.name) && Boolean(seen.add(agent.name)));
}

/** An agent by its bare or `plugin:agent` name. */
export function findPluginAgent(roots: PluginRoots, type: string): PluginAgent | undefined {
  const agents = enabledPluginAgents(roots);
  return agents.find((agent) => agent.name === type || `${agent.plugin}:${agent.name}` === type);
}

/** Resolves a `subagent_type` for the task/agent tools: the call to pass on, or the error to return. */
export function resolveAgentType(roots: PluginRoots, type: string | undefined): { agentType?: { name: string; prompt: string; tools?: string[] } } | { error: string } {
  const wanted = type?.trim();
  if (!wanted || wanted === 'general-purpose') return {};
  const agent = findPluginAgent(roots, wanted);
  if (agent) return { agentType: { name: agent.name, prompt: agent.prompt, ...(agent.tools ? { tools: agent.tools } : {}) } };
  const names = enabledPluginAgents(roots).map((item) => item.name);
  return { error: `No agent type "${wanted}".${names.length ? ` Available: ${names.join(', ')}.` : ' No plugin agents are installed; leave subagent_type out.'}` };
}

/** The system prompt's list of agent types; empty when there are none. */
export function agentTypesPromptSection(agents: readonly PluginAgent[], maxDescription = 150): string {
  if (!agents.length) return '';
  return [
    '# Agent types',
    'Plugins provide these specialised sub-agents. Pass one as subagent_type to agent (coding) or task (read-only research) when it fits the job.',
    ...agents.slice(0, 20).map((agent) => `- ${agent.name}: ${agent.description.length > maxDescription ? `${agent.description.slice(0, maxDescription - 1)}…` : agent.description}`),
  ].join('\n');
}

export function enabledPluginHooks(roots: PluginRoots): HookConfig {
  const merged: Record<string, unknown[]> = {};
  for (const plugin of enabledPlugins(roots)) {
    for (const [event, groups] of Object.entries(pluginHooks(plugin, roots.stateDir))) (merged[event] ??= []).push(...(groups ?? []));
  }
  return merged as HookConfig;
}

export function enabledPluginMcpServers(roots: PluginRoots): McpServerSpec[] {
  return enabledPlugins(roots).flatMap((plugin) => pluginMcpServers(plugin, roots.stateDir));
}

/** Each enabled plugin's command directories, for the custom slash commands. */
export function enabledPluginCommandDirs(roots: PluginRoots): Array<{ plugin: string; root: string; dir: string }> {
  return enabledPlugins(roots).flatMap((plugin) => pluginCommandDirs(plugin).map((dir) => ({ plugin: plugin.name, root: plugin.root, dir })));
}

/** Each enabled plugin's skill directories, for the skill catalog. */
export function enabledPluginSkillDirs(roots: PluginRoots): Array<{ plugin: string; root: string; dir: string }> {
  return enabledPlugins(roots).flatMap((plugin) => pluginSkillDirs(plugin).map((dir) => ({ plugin: plugin.name, root: plugin.root, dir })));
}
