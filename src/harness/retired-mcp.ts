/** Vendor configs still launch ClikCode commands that no longer exist.
 *
 * `conversations-mcp`, `npx-mcp` and `swarm-mcp` were removed when ClikCode
 * stopped writing its own servers into a vendor (commit 6b528c86). The copies
 * already written kept starting, and each one exited 1: thousands of
 * processes, none of them a chat.
 *
 * What is dropped is decided by ClikCode's own fingerprint, never by a name: a
 * server whose launcher is the ClikCode binary and whose arguments name a
 * retired command. A server the user configured themselves has neither, so it
 * is left alone wherever it lives.
 *
 * Where to look comes from the catalog (`managers.mcp.serverFiles`, the table
 * the first-run import and the per-session dedupe read too) for the user's own
 * home and every account profile, so a vendor taught there is cleaned without
 * another list here. Files the catalog does not name are still found by their
 * usual names under the profiles.
 */
import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJsonc, vendorConfigFiles, vendorSources } from '../agent/mcp/import.js';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';

const RETIRED = new Set(['conversations-mcp', 'npx-mcp', 'swarm-mcp']);
/** Bumped when what is looked at or recognized widens, so a state directory
 * that already ran the narrower pass runs this one. */
const PASS = 'v2';
const STAMP = `${[...RETIRED].sort().join(' ')} ${PASS}`;

/** A path that starts ClikCode: its binary, or a build's entry file. */
const CLIKCODE_LAUNCHER = /(?:^|[\\/])clikcode(?:\.cmd|\.exe)?$|[\\/]clikcode[^\\/]*[\\/](?:dist[\\/])?index\.js$|[\\/]release[\\/]dist[\\/]index\.js$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every string in a server's definition, however a vendor nests it (Cline
 * keeps the command under `transport`, OpenCode keeps one argv array). */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 3) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item, depth + 1));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringsOf(item, depth + 1));
  return [];
}

/** Whether a server definition launches a retired ClikCode command. */
export function launchesRetired(spec: unknown): boolean {
  const all = stringsOf(spec);
  return all.some((text) => RETIRED.has(text)) && all.some((text) => CLIKCODE_LAUNCHER.test(text));
}

function readJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* maybe a comment or a trailing comma */ }
  try { return JSON.parse(stripJsonc(text)); } catch { return undefined; }
}

/** JSON mcp config: remove the servers that launch a retired command. `key`
 * is where the vendor keeps its server table (catalog `key`); without it the
 * usual three places are tried. */
export function stripRetiredJson(text: string, key?: readonly string[]): { text: string; removed: string[] } | undefined {
  const root = readJson(text);
  if (!isRecord(root)) return undefined;
  const tables: Record<string, unknown>[] = [];
  if (key?.length) {
    let table: unknown = root;
    for (const part of key) table = isRecord(table) ? table[part] : undefined;
    if (isRecord(table)) tables.push(table);
  } else {
    for (const name of ['mcpServers', 'servers', 'mcp']) if (isRecord(root[name])) tables.push(root[name] as Record<string, unknown>);
  }
  const removed: string[] = [];
  for (const table of tables) {
    for (const [name, spec] of Object.entries(table)) {
      if (!launchesRetired(spec)) continue;
      removed.push(name);
      delete table[name];
    }
  }
  return removed.length ? { text: `${JSON.stringify(root, null, 2)}\n`, removed } : undefined;
}

function serverRoot(header: string): string | undefined {
  const match = /^\[mcp_servers\.(.+)]$/.exec(header.trim());
  if (!match) return undefined;
  const rest = match[1];
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const end = rest.indexOf(rest[0], 1);
    return end > 1 ? rest.slice(1, end) : undefined;
  }
  return rest.split('.')[0];
}

/** A toml profile: drop the `[mcp_servers.<name>]` table, and its nested
 * tables, when that table launches a retired command through ClikCode. */
export function stripRetiredToml(text: string): { text: string; removed: string[] } | undefined {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) if (/^\s*\[/.test(lines[index])) starts.push(index);
  if (!starts.length) return undefined;
  starts.push(lines.length);
  const retiredRoots = new Set<string>();
  for (let section = 0; section < starts.length - 1; section += 1) {
    const root = serverRoot(lines[starts[section]]);
    if (!root || root.includes('.')) continue;
    const body = lines.slice(starts[section], starts[section + 1]).join('\n');
    const quoted = [...body.matchAll(/["']([^"'\n]+)["']/g)].map((match) => match[1]);
    if (quoted.some((text) => RETIRED.has(text)) && quoted.some((text) => CLIKCODE_LAUNCHER.test(text))) retiredRoots.add(root);
  }
  if (!retiredRoots.size) return undefined;
  const drop = new Set<number>();
  for (let section = 0; section < starts.length - 1; section += 1) {
    const root = serverRoot(lines[starts[section]]);
    if (!root || !retiredRoots.has(root)) continue;
    for (let line = starts[section]; line < starts[section + 1]; line += 1) drop.add(line);
  }
  const kept = lines.filter((_, index) => !drop.has(index));
  while (kept.length && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();
  const next = kept.join('\n');
  return { text: text.endsWith('\n') ? (next.endsWith('\n') ? next : `${next}\n`) : next.replace(/\n$/, ''), removed: [...retiredRoots] };
}

/** Names a vendor config usually has, for a vendor the catalog does not name. */
const CONFIGS = new Set(['mcp.json', '.claude.json', 'claude.json', 'config.toml', 'mcp_config.json', 'cline_mcp_settings.json']);

interface Target { path: string; format: 'json' | 'jsonc' | 'toml'; key?: readonly string[] }

async function walkConfigs(directory: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of names) {
    if (entry.name === 'node_modules' || entry.name === 'plugins' || entry.name === 'updates') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walkConfigs(path, depth + 1));
    else if (CONFIGS.has(entry.name)) found.push(path);
  }
  return found;
}

/** Written beside, then renamed over: a vendor reading the file never sees half of it. */
async function rewrite(path: string, text: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  const temporary = `${path}.${process.pid}.retired.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', mode });
  await rename(temporary, path);
}

/** What to look at: the catalog's files for every vendor under the user's
 * home (when `home` is given) and each account profile, then the usual names
 * under the profiles. */
async function targets(stateDir: string, home: string | undefined): Promise<Target[]> {
  const found = new Map<string, Target>();
  try {
    for (const source of vendorSources()) {
      if (source.format === 'yaml') continue; // no ClikCode-written server lives in a YAML file
      for (const path of await vendorConfigFiles(source, home ?? join(stateDir, '.no-home'), stateDir)) {
        if (!found.has(path)) found.set(path, { path, format: source.format, key: source.key });
      }
    }
  } catch (error) {
    lifecycle('mcp.retired', { error: `catalog unavailable: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
  }
  const profiles = join(stateDir, 'profiles');
  for (const command of await readdir(profiles).catch(() => [] as string[])) {
    for (const account of await readdir(join(profiles, command)).catch(() => [] as string[])) {
      for (const path of await walkConfigs(join(profiles, command, account))) {
        if (!found.has(path)) found.set(path, { path, format: path.endsWith('.toml') ? 'toml' : 'json' });
      }
    }
  }
  return [...found.values()];
}

/** One pass over this state's vendor configs. A stamp stops the next worker
 * from walking them again for the same set of retired commands and the same
 * reach of this pass. `home` is the user's home when this state directory is
 * the user's own: a test or a sandbox state directory passes none, and no
 * file outside it is read. */
export async function dropRetiredVendorMcp(stateDir: string, home?: string): Promise<number> {
  const stampPath = join(stateDir, 'retired-mcp.txt');
  if (await readFile(stampPath, 'utf8').then((text) => text.trim() === STAMP, () => false)) return 0;
  const profiles = join(stateDir, 'profiles');
  const removed: string[] = [];
  let changed = 0;
  for (const target of await targets(stateDir, home)) {
    try {
      const text = await readFile(target.path, 'utf8').catch(quiet('harness/retired-mcp'));
      if (!text || ![...RETIRED].some((name) => text.includes(name))) continue;
      const stripped = target.format === 'toml' ? stripRetiredToml(text) : stripRetiredJson(text, target.key);
      if (!stripped) continue;
      // The user's own file is kept as it was, once, beside it.
      if (!target.path.startsWith(profiles) && !existsSync(`${target.path}.pre-retired-mcp`)) await copyFile(target.path, `${target.path}.pre-retired-mcp`);
      await rewrite(target.path, stripped.text);
      removed.push(...stripped.removed);
      changed += 1;
    } catch (error) {
      lifecycle('mcp.retired', { error: error instanceof Error ? error.message.slice(0, 160) : String(error), file: target.path.split(/[\\/]/).slice(-2).join('/') });
    }
  }
  await writeFile(stampPath, `${STAMP}\n`, 'utf8').catch(quiet('harness/retired-mcp'));
  if (removed.length) lifecycle('mcp.retired', { removed: removed.length, files: changed, names: [...new Set(removed)].join(',').slice(0, 200) });
  return removed.length;
}

/** The user's home, when `stateDir` is the user's own state directory. */
export function homeForOwnState(stateDir: string): string | undefined {
  return stateDir === join(homedir(), '.clikcode') ? homedir() : undefined;
}
