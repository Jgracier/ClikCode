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
import { cp, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from './definition.js';
import {
  installMcpOnHarness, isRemoteTarget, mcpHeadersReachHarness, removeMcpConfigEntry, removeMcpFromHarness, type McpServerEntry,
} from './mcp-registry.js';
import { mcpServerNeedsSignIn, type McpSignInAnswer } from './mcp-sign-in.js';
import { hasMcpOAuth } from '../agent/mcp/oauth.js';
import { npxRoots, withoutNpx, type NpxRoots } from './npx-bin.js';
import { loadMcpServers, MCP_SERVERS_KEY, mcpConfigFilePath, type McpServerSpec } from '../agent/mcp/config.js';
import { importedFromCommand, vendorMcpServerNames, vendorMcpServerUrls } from '../agent/mcp/import.js';
import { discoverSkills, type Skill } from '../agent/skills.js';
import { objectOrEmpty, updateJsonFile } from '../session/store/json-file.js';
import { stateDirectory } from '../session/store/paths.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

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
  /** Remote servers that need a browser sign-in, or could not be checked:
   * never given to a vendor (see mcp-sign-in.ts). */
  mcpNeedsSignIn: string[];
  /** ClikCode's own earlier copies of those, taken back out of this harness. */
  mcpRemoved: string[];
  /** Copies that could not be taken out, and why (a JSONC file with comments). */
  mcpRemoveFailed: Array<{ name: string; detail?: string }>;
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
  /** Tests pass these. Production asks the server, and the vendor's own
   * `mcp remove`. */
  signIn?: (entry: McpServerEntry, headersReach: boolean) => Promise<McpSignInAnswer>;
  remove?: typeof removeMcpFromHarness;
  /** Tests pass the check; production asks the local server (localServerDown). */
  serverDown?: (target: string) => Promise<boolean>;
  /** ClikCode's own servers (search/mcp-entry.ts), given to every harness
   * by the same rules as the user's: never over a name already there. */
  builtins?: readonly McpServerEntry[];
  /** Where npm keeps what npx installed. Tests pass fixtures. */
  npx?: NpxRoots;
  /** How a vendor starts ClikCode (search/mcp-entry.ts clikcodeLauncher),
   * which runs an npx server's installed bin. Without it npx entries are
   * written as they are. */
  launcher?: { target: string; args: readonly string[] };
  /** Only take ClikCode's sign-in servers back out: write nothing new and
   * copy no skills. For a sweep over every profile at once, which must not
   * fan anything out to a harness nobody chose. */
  takeBackOnly?: boolean;
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

/** Whether a server on this machine is down: a refused (or silent)
 * connection. A remote server is never judged here. */
export async function localServerDown(target: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(target); } catch { return false; }
  if (!/^(?:localhost|127(?:\.\d+){3}|\[::1\])$/.test(url.hostname)) return false;
  try {
    const response = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(1_500) });
    await response.body?.cancel().catch(() => undefined);
    return false;
  } catch {
    return true;
  }
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
  const mcpNeedsSignIn: string[] = [];
  const mcpRemoved: string[] = [];
  const mcpRemoveFailed: Array<{ name: string; detail?: string }> = [];
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
  const launcher = input.launcher;
  const headersReach = mcpHeadersReachHarness(input.harness);
  const signIn = input.signIn ?? ((entry: McpServerEntry, reach: boolean) => mcpServerNeedsSignIn(entry, { stateDir, headersReach: reach }));
  // A server ClikCode signs in to itself (its OAuth client configured, or a
  // token or a refusal stored for it -- agent/mcp/oauth.ts) needs a sign-in
  // by definition, whatever an unauthenticated probe would say; its tokens
  // are ClikCode's and never reach a vendor.
  const ownOAuth = new Set((await Promise.all(loaded.servers.map(async (spec) => (
    spec.transport !== 'stdio' && (spec.oauth || await hasMcpOAuth(stateDir, spec.name, spec.url)) ? spec.name : undefined
  )))).filter((name): name is string => !!name));
  // Remote servers are asked at once, not one after another.
  const answers = new Map(await Promise.all(entries.filter((entry) => isRemoteTarget(entry.target))
    .map(async (entry) => [entry.name, ownOAuth.has(entry.name) ? 'sign-in' as const : await signIn(entry, headersReach)] as const)));
  // Grok quits outright when an HTTP server it was given does not answer
  // ("worker quit with fatal: Transport channel closed", 2026-10-06: a local
  // dev server that was down), where every other vendor goes on without it.
  // So Grok gets a local server only while it is up; asking costs nothing,
  // since a refused connection fails at once.
  const down = input.harness.command === 'grok'
    ? new Set((await Promise.all(entries.filter((entry) => isRemoteTarget(entry.target))
      .map(async (entry) => (await (input.serverDown ?? localServerDown)(entry.target)) ? entry.name : undefined))).filter(Boolean))
    : new Set<string | undefined>();
  const ownership = await mcpOwnership(stateDir, input, home, profile, present.known);
  for (const entry of entries) {
    if (present.unreadable) { mcpSkipped.push(entry.name); continue; }
    if (down.has(entry.name)) {
      mcpSkipped.push(entry.name);
      // ClikCode's earlier copy comes back out, and goes back in once the
      // server answers; one the user put there is theirs.
      const there = present.known ? ownership.urls.get(entry.name) === entry.target : ownership.recorded(entry.name);
      if (there && await ownership.owns(entry.name)) {
        const removed = await (input.remove ?? removeMcpFromHarness)(input.harness, entry.name, input.account, home);
        if (removed.ok) {
          mcpRemoved.push(entry.name);
          await forgetProvisioned(stateDir, input, entry.name);
        } else mcpRemoveFailed.push({ name: entry.name, ...(removed.detail ? { detail: removed.detail } : {}) });
      }
      continue;
    }
    const answer = answers.get(entry.name);
    if (answer && answer !== 'open') {
      // Never handed to a vendor: each one keeps its own sign-in, so it
      // would be a sign-in owed in every vendor and profile, and Copilot
      // opens the browser for it on every session. ClikCode's own earlier
      // copy comes back out; one the user put there is theirs.
      mcpNeedsSignIn.push(entry.name);
      // The same server, not a different one the user keeps under the name.
      const there = present.known ? ownership.urls.get(entry.name) === entry.target : ownership.recorded(entry.name);
      if (answer === 'sign-in' && there && await ownership.owns(entry.name)) {
        const removed = await (input.remove ?? removeMcpFromHarness)(input.harness, entry.name, input.account, home);
        if (removed.ok) {
          mcpRemoved.push(entry.name);
          await forgetProvisioned(stateDir, input, entry.name);
        } else mcpRemoveFailed.push({ name: entry.name, ...(removed.detail ? { detail: removed.detail } : {}) });
      }
      continue;
    }
    if (input.takeBackOnly) continue;
    if (present.known && present.names.has(entry.name)) continue;
    if (grokClaudeMcp?.names.has(entry.name)) continue;
    if (!present.known && await alreadyProvisioned(stateDir, input, entry.name)) continue;
    // Only the vendor's copy: mcp.json keeps the user's own npx line.
    const written = launcher ? await withoutNpx(entry, () => (roots ??= input.npx ? Promise.resolve(input.npx) : npxRoots(home)), launcher) : entry;
    const result = await (input.install ?? installMcpOnHarness)(input.harness, written, input.account);
    if (result.ok) {
      mcpInstalled.push(entry.name);
      // Every write is recorded: it is how a later turn knows this copy is
      // ClikCode's to take back, and for a harness whose file is unknown it
      // is also the brake on writing it again.
      await rememberProvisioned(stateDir, input, entry.name);
    } else if (result.detail && /already|exists|duplicate/i.test(result.detail)) {
      if (!present.known) await rememberProvisioned(stateDir, input, entry.name);
    } else mcpSkipped.push(entry.name);
  }

  const userDirParts = USER_SKILL_DIR[input.harness.command];
  if (userDirParts && !input.takeBackOnly) {
    const catalog = await discoverSkills({ cwd: workspace, stateDir, homeDir: home });
    const userDir = skillRoot(userDirParts, home, profile);
    const projectParts = PROJECT_SKILL_DIR[input.harness.command];
    const projectDir = projectParts ? join(workspace, ...projectParts) : userDir;
    const grokSeesClaudeSkills = input.harness.command === 'grok' && await grokImports(home, 'skills');
    for (const skill of catalog.skills) {
      // A plugin's skill belongs to the plugin, which ClikCode's own agent
      // loads; a vendor with plugins of its own installs them there.
      if (skill.source === 'plugin') continue;
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

  if (!present.unreadable) await ownership.settle(entries.map((entry) => entry.name).filter((name) => !mcpRemoved.includes(name)));
  return { mcpInstalled, mcpSkipped, mcpNeedsSignIn, mcpRemoved, mcpRemoveFailed, skillsCopied };
}

/** Which of this harness's servers ClikCode wrote.
 *
 * Every write is recorded in mcp-provision.json now, but before that only
 * harnesses whose file ClikCode cannot read were, so the first pass over a
 * harness and account also adopts what was clearly ClikCode's: anything in
 * an isolated account profile (ClikCode made the profile; the user never
 * configured it by hand), and in the user's own home, a server mcp-import.json
 * says was imported from a DIFFERENT vendor -- the vendor it was imported
 * from is where the user put it. After that first pass only the record
 * counts, so a server the user adds by hand later is never taken. */
async function mcpOwnership(
  stateDir: string, input: ProvisionInput, home: string,
  profile: { env: string; path: string } | undefined, known: boolean,
): Promise<{
  urls: Map<string, string>;
  recorded: (name: string) => boolean;
  owns: (name: string) => Promise<boolean>;
  settle: (names: readonly string[]) => Promise<void>;
}> {
  const marker = await readMarker(stateDir);
  const legacyKey = `legacy\0${input.harness.command}\0${input.account?.id ?? ''}`;
  const legacy = !(legacyKey in marker);
  const urls = known ? await vendorMcpServerUrls(input.harness.command, home, profile) : new Map<string, string>();
  const recorded = (name: string): boolean => provisionKey(input, name) in marker;
  const owns = async (name: string): Promise<boolean> => {
    if (recorded(name)) return true;
    if (!legacy) return false;
    if (profile) return true;
    const from = await importedFromCommand(stateDir, name);
    return from !== undefined && from !== input.harness.command;
  };
  // Only ClikCode's own list is adopted, and only what is in the file now.
  const settle = async (names: readonly string[]): Promise<void> => {
    if (!legacy) return;
    const adopted: string[] = [];
    for (const name of names) if (urls.has(name) && await owns(name)) adopted.push(name);
    await changeMarker(stateDir, (latest) => {
      for (const name of adopted) latest[provisionKey(input, name)] = true;
      latest[legacyKey] = true;
      return true;
    });
  };
  return { urls, recorded, owns, settle };
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

function markerPath(stateDir: string): string {
  return join(stateDir, 'mcp-provision.json');
}

async function readMarker(stateDir: string): Promise<Record<string, true>> {
  return objectOrEmpty(await readFile(markerPath(stateDir), 'utf8').catch(() => undefined)) as Record<string, true>;
}

/** A harness whose config file ClikCode cannot read still must not be given
 * the same server on every turn. The marker is only that brake. */
async function alreadyProvisioned(stateDir: string, input: ProvisionInput, name: string): Promise<boolean> {
  return provisionKey(input, name) in await readMarker(stateDir);
}

/** Every worker's turn changes the marker: each change is made to the file as
 * it is now, under its lock, never to an earlier read of it. */
async function changeMarker(stateDir: string, change: (marker: Record<string, true>) => boolean): Promise<void> {
  await updateJsonFile(markerPath(stateDir), (raw) => objectOrEmpty(raw) as Record<string, true>, (marker) => change(marker) ? marker : undefined);
}

async function rememberProvisioned(stateDir: string, input: ProvisionInput, name: string): Promise<void> {
  await changeMarker(stateDir, (marker) => {
    marker[provisionKey(input, name)] = true;
    return true;
  });
}

async function forgetProvisioned(stateDir: string, input: ProvisionInput, name: string): Promise<void> {
  const key = provisionKey(input, name);
  await changeMarker(stateDir, (marker) => key in marker && delete marker[key]);
}

/** One copy ClikCode wrote: the harness and the account whose profile has it
 * (no account: the user's own home). */
export interface ProvisionedCopy { harness: string; accountId?: string }

/** The copies of each server ClikCode itself wrote, by the record every write
 * leaves in mcp-provision.json. */
async function provisionedCopies(stateDir: string): Promise<Map<string, ProvisionedCopy[]>> {
  const copies = new Map<string, ProvisionedCopy[]>();
  for (const key of Object.keys(await readMarker(stateDir))) {
    const [harness, accountId, name, extra] = key.split('\0');
    if (harness === 'legacy' || !harness || name === undefined || extra !== undefined) continue;
    copies.set(name, [...copies.get(name) ?? [], { harness, ...(accountId ? { accountId } : {}) }]);
  }
  return copies;
}

/** `clikcode mcp list`: ClikCode's servers (its mcp.json) and where it has
 * copied each one. */
export async function listSharedMcpServers(stateDir: string = stateDirectory()): Promise<{
  servers: Array<McpServerEntry & { copies: ProvisionedCopy[] }>; problem?: string;
}> {
  const loaded = await loadMcpServers(stateDir);
  const copies = await provisionedCopies(stateDir);
  return {
    servers: loaded.servers.map((spec) => ({ ...specToEntry(spec), copies: copies.get(spec.name) ?? [] })),
    ...(loaded.problem ? { problem: loaded.problem } : {}),
  };
}

export interface McpRemoveResult {
  /** It was in ClikCode's mcp.json, and is not now. */
  unrecorded: boolean;
  takenBack: ProvisionedCopy[];
  failed: Array<ProvisionedCopy & { detail?: string }>;
}

/** `clikcode mcp remove`: ClikCode's own copies of one server come back out
 * of every vendor it gave them to, by the same take-back provisioning uses,
 * and then the server leaves ClikCode's mcp.json. Only a copy the record says
 * ClikCode wrote is touched: one the user put in a vendor is theirs. A copy
 * in a profile whose account is gone goes with the profile; only its record
 * is dropped. */
export async function removeSharedMcpServer(name: string, input: {
  accounts: readonly AiHarnessAccount[];
  stateDir?: string;
  home?: string;
  remove?: typeof removeMcpFromHarness;
}): Promise<McpRemoveResult> {
  const stateDir = input.stateDir ?? stateDirectory();
  const home = input.home ?? homedir();
  const takenBack: ProvisionedCopy[] = [];
  const failed: McpRemoveResult['failed'] = [];
  for (const copy of (await provisionedCopies(stateDir)).get(name) ?? []) {
    const harness = localHarnessForCommand(copy.harness);
    const account = copy.accountId ? input.accounts.find((item) => item.id === copy.accountId) : undefined;
    const forget = (): Promise<void> => changeMarker(stateDir, (marker) => {
      const key = `${copy.harness}\0${copy.accountId ?? ''}\0${name}`;
      return key in marker && delete marker[key];
    });
    if (!harness || (copy.accountId && !account)) { await forget(); continue; }
    const removed = await (input.remove ?? removeMcpFromHarness)(harness, name, account, home);
    if (removed.ok) {
      takenBack.push(copy);
      await forget();
    } else failed.push({ ...copy, ...(removed.detail ? { detail: removed.detail } : {}) });
  }
  const unrecorded = await removeMcpConfigEntry(mcpConfigFilePath(stateDir), MCP_SERVERS_KEY, name);
  return { unrecorded, takenBack, failed };
}
