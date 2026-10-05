/** Give the harness that was just chosen whatever ClikCode already has, and
 * only what that harness does not already have.
 *
 * MCP servers come from `<state dir>/mcp.json`. Skills come from the same
 * directories ClikCode's own agent reads. Hooks are not copied: Claude and
 * Grok already run Claude's hook files, and every other harness uses a hook
 * schema of its own.
 *
 * An existing name is never replaced. The vendor's copy may be one the user
 * edited, and a different command under the same name stays theirs.
 */
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from './definition.js';
import { installMcpOnHarness, type McpServerEntry } from './mcp-registry.js';
import { npxRoots, withoutNpx, type NpxRoots } from './npx-bin.js';
import { loadMcpServers, type McpServerSpec } from '../agent/mcp/config.js';
import { vendorMcpServerNames } from '../agent/mcp/import.js';
import { discoverSkills, type Skill } from '../agent/skills.js';
import { stateDirectory } from '../session/store/paths.js';

/** `<dir>/<name>/SKILL.md`, checked against a real install of that harness. */
const USER_SKILL_DIR: Record<string, readonly string[]> = {
  claude: ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  grok: ['.grok', 'skills'],
  gemini: ['.gemini', 'skills'],
  copilot: ['.copilot', 'skills'],
  qwen: ['.qwen', 'skills'],
  hermes: ['.hermes', 'skills'],
  cn: ['.continue', 'skills'],
  junie: ['.junie', 'skills'],
  command: ['.commandcode', 'skills'],
  cursor: ['.cursor', 'skills'],
};

/** Project skill directory, where the vendor documents one. The others load
 * skills from the user directory only, so a project skill is copied there. */
const PROJECT_SKILL_DIR: Record<string, readonly string[]> = {
  claude: ['.claude', 'skills'],
  cursor: ['.cursor', 'skills'],
  command: ['.commandcode', 'skills'],
};

export interface ProvisionResult {
  mcpInstalled: string[];
  mcpSkipped: string[];
  skillsCopied: string[];
}

export interface ProvisionInput {
  harness: AiLocalHarnessDefinition;
  account?: AiHarnessAccount;
  workspace?: string;
  stateDir?: string;
  home?: string;
  /** Tests pass the writer. Production uses the harness's own mcp add. */
  install?: typeof installMcpOnHarness;
  /** ClikCode's own servers (search/mcp-entry.ts), given to every harness
   * by the same rules as the user's: never over a name already there. */
  builtins?: readonly McpServerEntry[];
  /** Where npm keeps what npx installed. Tests pass fixtures. */
  npx?: NpxRoots;
}

function profileOf(account?: AiHarnessAccount): { env: string; path: string } | undefined {
  const profile = account?.nativeProfile;
  return profile ? { env: profile.env, path: profile.path } : undefined;
}

/** A profile that is a fake HOME keeps the dotted directory. A profile that
 * is the vendor root (`QWEN_HOME` standing in for `~/.qwen`) drops it. */
export function skillRoot(
  parts: readonly string[], home: string, profile?: { env: string; path: string },
): string {
  if (!profile || profile.env === 'HOME') return join(profile?.path ?? home, ...parts);
  return join(profile.path, ...parts.slice(1));
}

function specToEntry(spec: McpServerSpec): McpServerEntry {
  if (spec.transport === 'stdio') {
    return {
      name: spec.name, target: spec.command,
      ...(spec.args.length ? { args: spec.args } : {}),
      ...(Object.keys(spec.env).length ? { env: spec.env } : {}),
    };
  }
  return { name: spec.name, target: spec.url, ...(Object.keys(spec.headers).length ? { headers: spec.headers } : {}) };
}

async function copySkill(skill: Skill, directory: string): Promise<boolean> {
  if (skill.name.includes('/') || skill.name.includes('\\') || skill.name === '..') return false;
  const destination = join(directory, skill.name);
  if (await stat(destination).then(() => true, () => false)) return false;
  const source = await realpath(skill.dir).catch(() => skill.dir);
  const realDest = await realpath(directory).catch(() => directory);
  if (source === destination || source.startsWith(`${realDest}/`)) return false;
  await mkdir(directory, { recursive: true });
  await cp(skill.dir, destination, { recursive: true });
  return true;
}

/** Install what this harness is missing. Safe to call on every turn: a name
 * that is already present is not written again. */
export async function provisionChosenHarness(input: ProvisionInput): Promise<ProvisionResult> {
  const home = input.home ?? homedir();
  const stateDir = input.stateDir ?? stateDirectory();
  const profile = profileOf(input.account);
  const workspace = input.workspace?.trim() || process.cwd();
  const mcpInstalled: string[] = [];
  const mcpSkipped: string[] = [];
  const skillsCopied: string[] = [];

  const loaded = await loadMcpServers(stateDir);
  const present = await vendorMcpServerNames(input.harness.command, home, profile);
  // Grok reads ~/.claude.json unless [compat.claude] mcps is turned off, so a
  // name Claude already has is already available. Adding it again connects twice.
  const grokClaudeMcp = input.harness.command === 'grok' && await grokImports(home, 'mcps')
    ? await vendorMcpServerNames('claude', home)
    : undefined;
  const userEntries = loaded.servers.map(specToEntry);
  const userNames = new Set(userEntries.map((entry) => entry.name));
  // A user's server by the same name is theirs and wins.
  const entries = [...userEntries, ...(input.builtins ?? []).filter((entry) => !userNames.has(entry.name))];
  let roots: Promise<NpxRoots> | undefined;
  for (const entry of entries) {
    if (present.unreadable) { mcpSkipped.push(entry.name); continue; }
    if (present.known && present.names.has(entry.name)) continue;
    if (grokClaudeMcp?.names.has(entry.name)) continue;
    if (!present.known && await alreadyProvisioned(stateDir, input, entry.name)) continue;
    // Only the vendor's copy: mcp.json keeps the user's own npx line.
    const written = await withoutNpx(entry, () => (roots ??= input.npx ? Promise.resolve(input.npx) : npxRoots(home)));
    const result = await (input.install ?? installMcpOnHarness)(input.harness, written, input.account);
    if (result.ok) {
      mcpInstalled.push(entry.name);
      if (!present.known) await rememberProvisioned(stateDir, input, entry.name);
    } else if (result.detail && /already|exists|duplicate/i.test(result.detail)) {
      if (!present.known) await rememberProvisioned(stateDir, input, entry.name);
    } else mcpSkipped.push(entry.name);
  }

  const userDirParts = USER_SKILL_DIR[input.harness.command];
  if (userDirParts) {
    const catalog = await discoverSkills({ cwd: workspace, stateDir, homeDir: home });
    const userDir = skillRoot(userDirParts, home, profile);
    const projectParts = PROJECT_SKILL_DIR[input.harness.command];
    const projectDir = projectParts ? join(workspace, ...projectParts) : userDir;
    const grokSeesClaudeSkills = input.harness.command === 'grok' && await grokImports(home, 'skills');
    for (const skill of catalog.skills) {
      // Those two sources are the directories Grok scans on its own.
      if (grokSeesClaudeSkills && (skill.source === 'user-claude' || skill.source === 'project-claude')) continue;
      const directory = skill.source === 'project' || skill.source === 'project-claude' ? projectDir : userDir;
      try {
        if (await copySkill(skill, directory)) skillsCopied.push(skill.name);
      } catch {
        // One skill that cannot be copied must not stop the turn, or the
        // ones that can.
      }
    }
  }

  return { mcpInstalled, mcpSkipped, skillsCopied };
}

/** Grok's compat.claude flags default to on. An explicit false is the only off. */
async function grokImports(home: string, flag: 'mcps' | 'skills'): Promise<boolean> {
  const text = await readFile(join(home, '.grok', 'config.toml'), 'utf8').catch(() => '');
  const section = text.match(/\[compat\.claude\][^\[]*/);
  if (!section) return true;
  return !new RegExp(`^${flag}\\s*=\\s*false\\s*$`, 'm').test(section[0]);
}

function provisionKey(input: ProvisionInput, name: string): string {
  return `${input.harness.command}\0${input.account?.id ?? ''}\0${name}`;
}

async function readMarker(stateDir: string): Promise<Record<string, true>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, 'mcp-provision.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, true> : {};
  } catch { return {}; }
}

/** A harness whose config file ClikCode cannot read still must not be given
 * the same server on every turn. The marker is only that brake. */
async function alreadyProvisioned(stateDir: string, input: ProvisionInput, name: string): Promise<boolean> {
  return provisionKey(input, name) in await readMarker(stateDir);
}

async function rememberProvisioned(stateDir: string, input: ProvisionInput, name: string): Promise<void> {
  const marker = await readMarker(stateDir);
  marker[provisionKey(input, name)] = true;
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'mcp-provision.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}
