/** `clikcode plugin`: installing, removing, enabling and disabling plugins in
 * ClikCode's own registry (plugins.ts reads it), and the marketplaces they
 * come from.
 *
 *   add <dir>              copied into <state>/plugins/cache/<name>
 *   add <git url>          cloned, then copied the same way
 *   add <name>@<market>    looked up in a marketplace's .claude-plugin/marketplace.json
 *   marketplace add <dir | git url>
 *
 * A marketplace is ClikCode's own (`marketplace add`) or one Claude Code
 * already knows (`~/.claude/plugins/known_marketplaces.json`), read in place
 * and never written. Claude Code's installed plugins are never written either:
 * enabling or disabling one is a choice recorded in ClikCode's file. */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  claudePluginsDirectory, listPlugins, looksLikePlugin, MARKETPLACE_MANIFEST, pluginRegistryPath, pluginsDirectory,
  readPluginManifest, readPluginRegistry, type InstalledPlugin, type MarketplaceRecord, type PluginRecord, type PluginRegistry, type PluginRoots,
} from './plugins.js';

const execFileAsync = promisify(execFile);
const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function writeRegistry(stateDir: string, registry: PluginRegistry): Promise<void> {
  const file = pluginRegistryPath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temporary, file);
}

async function isDirectory(file: string): Promise<boolean> {
  try { return (await stat(file)).isDirectory(); } catch { return false; }
}

/** A git URL, as opposed to a local path: a scheme, scp-style `git@host:`, or a trailing `.git` on a host. */
export function isGitUrl(spec: string): boolean {
  return /^(https?|ssh|git|file):\/\//i.test(spec) || /^[\w.-]+@[\w.-]+:/.test(spec);
}

/** `name@marketplace`: no slash, one @, not a scp-style URL. */
function marketplaceSpec(spec: string): { plugin: string; marketplace: string } | undefined {
  const match = /^([\w.-]+)@([\w.-]+)$/.exec(spec);
  return match ? { plugin: match[1]!, marketplace: match[2]! } : undefined;
}

async function git(args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync('git', args, { ...(cwd ? { cwd } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args[0]} failed: ${detail.split('\n').slice(-3).join(' ')}`);
  }
}

/** A fresh clone at `ref` (a branch or tag) and then `sha`, when given. */
async function cloneInto(url: string, destination: string, pin: { ref?: string; sha?: string } = {}): Promise<void> {
  await git(['clone', '--quiet', ...(pin.sha ? [] : ['--depth', '1']), ...(pin.ref ? ['--branch', pin.ref] : []), '--', url, destination]);
  if (pin.sha) await git(['checkout', '--quiet', pin.sha], destination);
}

async function scratchDir(stateDir: string): Promise<string> {
  const base = path.join(pluginsDirectory(stateDir), 'tmp');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'clone-'));
}

// ── marketplaces ─────────────────────────────────────────────────────────────

interface MarketplaceEntry { name: string; source: unknown; version?: string; description?: string }
interface Marketplace { name: string; root: string; pluginRoot?: string; plugins: MarketplaceEntry[] }

async function readMarketplace(root: string): Promise<Marketplace> {
  const file = path.join(root, MARKETPLACE_MANIFEST);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    throw new Error(`${file} is missing or not valid JSON${(error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : `: ${(error as Error).message}`}`);
  }
  if (!isRecord(raw) || typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) throw new Error(`${file} has no usable "name"`);
  const plugins = (Array.isArray(raw.plugins) ? raw.plugins : []).filter((item): item is MarketplaceEntry => isRecord(item) && typeof item.name === 'string');
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  return { name: raw.name, root, plugins, ...(typeof metadata.pluginRoot === 'string' ? { pluginRoot: metadata.pluginRoot } : {}) };
}

/** ClikCode's marketplaces, then Claude Code's (read in place). */
function knownMarketplaces(roots: PluginRoots): Map<string, string> {
  const found = new Map<string, string>();
  for (const [name, record] of Object.entries(readPluginRegistry(roots.stateDir).marketplaces)) found.set(name, record.path);
  try {
    const claude = JSON.parse(readFileSync(path.join(claudePluginsDirectory(roots.home ?? homedir()), 'known_marketplaces.json'), 'utf8')) as unknown;
    if (isRecord(claude)) {
      for (const [name, record] of Object.entries(claude)) {
        if (!found.has(name) && isRecord(record) && typeof record.installLocation === 'string') found.set(name, record.installLocation);
      }
    }
  } catch { /* fail-open-ok: Claude Code knows no marketplaces */ }
  return found;
}

export async function addMarketplace(roots: PluginRoots, spec: string): Promise<MarketplaceRecord> {
  const registry = readPluginRegistry(roots.stateDir);
  let root: string;
  let scratch: string | undefined;
  if (isGitUrl(spec)) {
    scratch = await scratchDir(roots.stateDir);
    root = path.join(scratch, 'repo');
    await cloneInto(spec, root);
  } else {
    root = path.resolve(spec);
    if (!await isDirectory(root)) throw new Error(`${spec} is neither a directory nor a git URL`);
  }
  try {
    const marketplace = await readMarketplace(root);
    if (scratch) {
      // A cloned marketplace lives in the state directory; a local one is read in place.
      const destination = path.join(pluginsDirectory(roots.stateDir), 'marketplaces', marketplace.name);
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(root, destination);
      root = destination;
    }
    const record: MarketplaceRecord = { name: marketplace.name, source: spec, path: root, addedAt: new Date().toISOString() };
    registry.marketplaces[marketplace.name] = record;
    await writeRegistry(roots.stateDir, registry);
    return record;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

export async function removeMarketplace(roots: PluginRoots, name: string): Promise<boolean> {
  const registry = readPluginRegistry(roots.stateDir);
  const record = registry.marketplaces[name];
  if (!record) return false;
  delete registry.marketplaces[name];
  await writeRegistry(roots.stateDir, registry);
  const owned = path.join(pluginsDirectory(roots.stateDir), 'marketplaces', name);
  if (path.resolve(record.path) === owned) await rm(owned, { recursive: true, force: true });
  return true;
}

export function listMarketplaces(roots: PluginRoots): Array<{ name: string; path: string; origin: 'clikcode' | 'claude' }> {
  const own = readPluginRegistry(roots.stateDir).marketplaces;
  return [...knownMarketplaces(roots)].map(([name, root]) => ({ name, path: root, origin: own[name] ? 'clikcode' : 'claude' }));
}

/** Where a marketplace entry's plugin is: a directory in the marketplace, or a repository. */
type ResolvedSource = { dir: string } | { git: string; subdir?: string; ref?: string; sha?: string };

function resolveEntrySource(marketplace: Marketplace, entry: MarketplaceEntry): ResolvedSource {
  const source = entry.source;
  if (typeof source === 'string') {
    if (isGitUrl(source)) return { git: source };
    const relative = !source.startsWith('.') && !path.isAbsolute(source) && marketplace.pluginRoot ? path.join(marketplace.pluginRoot, source) : source;
    const dir = path.resolve(marketplace.root, relative);
    if (dir !== marketplace.root && !dir.startsWith(`${marketplace.root}${path.sep}`)) throw new Error(`${entry.name}'s source ${source} is outside its marketplace`);
    return { dir };
  }
  if (!isRecord(source)) throw new Error(`${entry.name} has no source in marketplace ${marketplace.name}`);
  const pin = { ...(typeof source.ref === 'string' ? { ref: source.ref } : {}), ...(typeof source.sha === 'string' ? { sha: source.sha } : {}) };
  if (source.source === 'github' && typeof source.repo === 'string') return { git: `https://github.com/${source.repo}.git`, ...pin };
  if ((source.source === 'url' || source.source === 'git') && typeof source.url === 'string') return { git: source.url, ...pin };
  if (source.source === 'git-subdir' && typeof source.url === 'string' && typeof source.path === 'string') return { git: source.url, subdir: source.path, ...pin };
  throw new Error(`${entry.name}'s source type "${String(source.source)}" is not supported (supported: a relative path, github, url, git-subdir)`);
}

// ── plugins ──────────────────────────────────────────────────────────────────

/** Copy a plugin directory into the cache under its id, without its .git. */
async function installCopy(stateDir: string, from: string, cacheName: string): Promise<string> {
  const destination = path.join(pluginsDirectory(stateDir), 'cache', cacheName);
  const staging = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(from, staging, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  return destination;
}

export async function addPlugin(roots: PluginRoots, spec: string): Promise<{ id: string; record: PluginRecord }> {
  let scratch: string | undefined;
  try {
    let dir: string;
    let marketplace: string | undefined;
    let entry: MarketplaceEntry | undefined;
    const fromMarket = !isGitUrl(spec) && !await isDirectory(path.resolve(spec)) ? marketplaceSpec(spec) : undefined;
    if (fromMarket) {
      const root = knownMarketplaces(roots).get(fromMarket.marketplace);
      if (!root) throw new Error(`No marketplace named ${fromMarket.marketplace}. Add it with \`clikcode plugin marketplace add <path|git url>\`.`);
      const market = await readMarketplace(root);
      entry = market.plugins.find((item) => item.name === fromMarket.plugin);
      if (!entry) throw new Error(`Marketplace ${market.name} lists no plugin named ${fromMarket.plugin}`);
      const source = resolveEntrySource(market, entry);
      if ('dir' in source) dir = source.dir;
      else {
        scratch = await scratchDir(roots.stateDir);
        await cloneInto(source.git, path.join(scratch, 'repo'), source);
        dir = path.resolve(scratch, 'repo', source.subdir ?? '.');
      }
      marketplace = market.name;
    } else if (isGitUrl(spec)) {
      scratch = await scratchDir(roots.stateDir);
      await cloneInto(spec, path.join(scratch, 'repo'));
      dir = path.join(scratch, 'repo');
    } else {
      dir = path.resolve(spec);
      if (!await isDirectory(dir)) throw new Error(`${spec} is not a directory, a git URL, or name@marketplace`);
    }
    if (!looksLikePlugin(dir)) {
      throw new Error(`${spec} is not a plugin: no .claude-plugin/plugin.json${await isDirectory(path.join(dir, '.claude-plugin')) ? ' (a marketplace? add it with `clikcode plugin marketplace add`)' : ''}`);
    }
    const manifest = readPluginManifest(dir);
    const name = manifest?.name ?? entry?.name ?? path.basename(dir.replace(/\.git$/, ''));
    if (!NAME_PATTERN.test(name)) throw new Error(`Plugin name "${name}" is not a usable name`);
    const id = marketplace ? `${name}@${marketplace}` : name;
    const installed = await installCopy(roots.stateDir, dir, id);
    const version = manifest?.version ?? entry?.version;
    const description = manifest?.description ?? entry?.description;
    const record: PluginRecord = {
      name, path: installed, source: spec, enabled: true, installedAt: new Date().toISOString(),
      ...(marketplace ? { marketplace } : {}), ...(version ? { version } : {}), ...(description ? { description } : {}),
    };
    const registry = readPluginRegistry(roots.stateDir);
    registry.plugins[id] = record;
    await writeRegistry(roots.stateDir, registry);
    return { id, record };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** By id, or by a name only one plugin has. */
export function findPlugin(roots: PluginRoots, query: string): InstalledPlugin {
  const plugins = listPlugins(roots);
  const exact = plugins.find((plugin) => plugin.id === query);
  if (exact) return exact;
  const named = plugins.filter((plugin) => plugin.name === query);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`${query} is ambiguous: ${named.map((plugin) => plugin.id).join(', ')}`);
  throw new Error(`No plugin named ${query}`);
}

export async function setPluginEnabled(roots: PluginRoots, query: string, enabled: boolean): Promise<InstalledPlugin> {
  const plugin = findPlugin(roots, query);
  const registry = readPluginRegistry(roots.stateDir);
  if (plugin.origin === 'clikcode') registry.plugins[plugin.id] = { ...registry.plugins[plugin.id]!, enabled };
  else registry.claude[plugin.id] = { enabled };
  await writeRegistry(roots.stateDir, registry);
  return { ...plugin, enabled };
}

export async function removePlugin(roots: PluginRoots, query: string): Promise<InstalledPlugin> {
  const plugin = findPlugin(roots, query);
  if (plugin.origin === 'claude') throw new Error(`${plugin.id} was installed by Claude Code; remove it there, or \`clikcode plugin disable ${plugin.id}\` to stop ClikCode using it`);
  const registry = readPluginRegistry(roots.stateDir);
  delete registry.plugins[plugin.id];
  await writeRegistry(roots.stateDir, registry);
  const cache = path.join(pluginsDirectory(roots.stateDir), 'cache');
  if (path.resolve(plugin.root).startsWith(`${cache}${path.sep}`)) await rm(plugin.root, { recursive: true, force: true });
  return plugin;
}
