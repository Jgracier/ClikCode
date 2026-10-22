/** Vendor profiles still launch ClikCode commands that no longer exist.
 *
 * `conversations-mcp`, `npx-mcp` and `swarm-mcp` were removed when ClikCode
 * stopped writing its own servers into a vendor (commit 6b528c86). The copies
 * already in account profiles kept starting, and each one exited 1: thousands
 * of processes, none of them a chat. This drops those entries. A server the
 * user configured themselves is left alone.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';

const RETIRED = new Set(['conversations-mcp', 'npx-mcp', 'swarm-mcp']);
const STAMP = [...RETIRED].sort().join(' ');

function usesRetired(value: unknown): boolean {
  if (typeof value === 'string') return RETIRED.has(value);
  if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && RETIRED.has(item));
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** JSON mcp config: remove servers whose command or args is a retired ClikCode command. */
export function stripRetiredJson(text: string): { text: string; removed: string[] } | undefined {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(root)) return undefined;
  const key = isRecord(root.mcpServers) ? 'mcpServers' : isRecord(root.servers) ? 'servers' : undefined;
  if (!key) return undefined;
  const servers = root[key] as Record<string, unknown>;
  const removed: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!isRecord(spec)) continue;
    if (usesRetired(spec.command) || usesRetired(spec.args)) removed.push(name);
  }
  if (!removed.length) return undefined;
  const next = { ...servers };
  for (const name of removed) delete next[name];
  return { text: `${JSON.stringify({ ...root, [key]: next }, null, 2)}\n`, removed };
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
 * tables, when that table's command or args names a retired command. */
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
    if ([...RETIRED].some((name) => body.includes(`"${name}"`) || body.includes(`'${name}'`))) retiredRoots.add(root);
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

const CONFIGS = new Set(['mcp.json', '.claude.json', 'claude.json', 'config.toml']);

/** One pass over this state's vendor profiles. A stamp stops the next worker
 * from walking them again for the same set of retired commands. */
export async function dropRetiredVendorMcp(stateDir: string): Promise<number> {
  const stampPath = join(stateDir, 'retired-mcp.txt');
  if (await readFile(stampPath, 'utf8').then((text) => text.trim() === STAMP, () => false)) return 0;
  const profiles = join(stateDir, 'profiles');
  const removed: string[] = [];
  const commands = await readdir(profiles).catch(() => [] as string[]);
  for (const command of commands) {
    const accounts = await readdir(join(profiles, command)).catch(() => [] as string[]);
    for (const account of accounts) {
      const root = join(profiles, command, account);
      const files = await walkConfigs(root);
      for (const file of files) {
        const text = await readFile(file, 'utf8').catch(() => undefined);
        if (!text) continue;
        const stripped = file.endsWith('.toml') ? stripRetiredToml(text) : stripRetiredJson(text);
        if (!stripped) continue;
        await writeFile(file, stripped.text, 'utf8');
        removed.push(...stripped.removed);
      }
    }
  }
  await writeFile(stampPath, `${STAMP}\n`, 'utf8').catch(() => undefined);
  if (removed.length) lifecycle('mcp.retired', { removed: removed.length, names: [...new Set(removed)].join(',').slice(0, 200) });
  return removed.length;
}

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
