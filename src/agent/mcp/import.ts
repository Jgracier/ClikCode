/** A one-time copy of the MCP servers the user already gave their vendor
 * harnesses into `<state dir>/mcp.json`, so ClikCode's own agent has them too.
 *
 * Why it exists: `clikcode mcp add` only started writing mcp.json once this
 * agent could use MCP. Every server added before that -- through ClikCode or
 * by hand in Claude Code, Codex, Gemini and the rest -- lives only in those
 * vendors' files, so without this the agent would see none of them.
 *
 * Everything the user configured is imported, not only what ClikCode itself
 * installed: the user put each one there on purpose, and nothing in a vendor
 * file says who wrote it. What is left out is what would not RUN the same way
 * here, each with its reason recorded (see `normalize`).
 *
 * Duplicates. One server fanned out by `clikcode mcp add` appears under the
 * same name in many files, so a name is imported once. When two vendors
 * disagree about a name, SOURCES order decides -- Claude Code first, because
 * its entries carry the transport type, env and headers explicitly, so its
 * copy is the least likely to have lost something in a vendor's own
 * translation. A second name for an identical command or URL is skipped too:
 * two names for one server would give the model every tool twice.
 *
 * It runs once per state directory, recorded in `mcp-import.json`. Running it
 * again would bring back a server the user deliberately removed from mcp.json,
 * and servers added from now on reach mcp.json through `mcp add` directly.
 * An entry already in mcp.json is never touched, whatever it holds.
 */
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MCP_SERVERS_KEY, mcpConfigFilePath, parseMcpServerEntry } from './config.js';
import { CONVERSATIONS_MCP_NAME } from '../../search/mcp-entry.js';

type Format = 'json' | 'jsonc' | 'toml' | 'yaml';
type Dialect = 'mcp-servers' | 'gemini' | 'opencode' | 'goose' | 'codex';

/** One vendor file. `homeRelative` is where it sits under the user's home;
 * `rootRelative` is where it sits under the vendor's own directory variable
 * (CLAUDE_CONFIG_DIR, CODEX_HOME), which is what an isolated ClikCode account
 * profile points at. Paths are the ones mcp-registry's installs write through
 * each vendor's `mcp add`, or its config file where it has no add. */
interface VendorSource {
  vendor: string;
  command: string;
  homeRelative: readonly string[];
  rootRelative?: readonly string[];
  format: Format;
  /** Path of the server table inside the file. */
  key: readonly string[];
  dialect: Dialect;
}

/** Precedence order: on a name conflict the earlier source wins. */
export const SOURCES: readonly VendorSource[] = [
  // Top level only. `projects[path].mcpServers` is Claude's local scope: the
  // user tied that server to one repository (a database, a staging API), and
  // this agent reads mcp.json in every directory.
  { vendor: 'Claude Code', command: 'claude', homeRelative: ['.claude.json'], rootRelative: ['.claude.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Codex', command: 'codex', homeRelative: ['.codex', 'config.toml'], rootRelative: ['config.toml'], format: 'toml', key: ['mcp_servers'], dialect: 'codex' },
  { vendor: 'Gemini CLI', command: 'gemini', homeRelative: ['.gemini', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'gemini' },
  { vendor: 'Qwen Code', command: 'qwen', homeRelative: ['.qwen', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'gemini' },
  { vendor: 'Grok', command: 'grok', homeRelative: ['.grok', 'config.toml'], format: 'toml', key: ['mcp_servers'], dialect: 'codex' },
  { vendor: 'Copilot', command: 'copilot', homeRelative: ['.copilot', 'mcp-config.json'], rootRelative: ['mcp-config.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Cursor', command: 'cursor', homeRelative: ['.cursor', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Kimi', command: 'kimi', homeRelative: ['.kimi-code', 'mcp.json'], rootRelative: ['mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Factory Droid', command: 'droid', homeRelative: ['.factory', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Kiro', command: 'kiro', homeRelative: ['.kiro', 'settings', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Cline', command: 'cline', homeRelative: ['.cline', 'data', 'settings', 'cline_mcp_settings.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Auggie', command: 'auggie', homeRelative: ['.augment', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Amp', command: 'amp', homeRelative: ['.config', 'amp', 'settings.json'], format: 'json', key: ['amp.mcpServers'], dialect: 'mcp-servers' },
  { vendor: 'Hermes', command: 'hermes', homeRelative: ['.hermes', 'config.yaml'], format: 'yaml', key: ['mcp_servers'], dialect: 'mcp-servers' },
  { vendor: 'Goose', command: 'goose', homeRelative: ['.config', 'goose', 'config.yaml'], format: 'yaml', key: ['extensions'], dialect: 'goose' },
  { vendor: 'opencode', command: 'opencode', homeRelative: ['.config', 'opencode', 'opencode.json'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' },
  { vendor: 'opencode', command: 'opencode', homeRelative: ['.config', 'opencode', 'opencode.jsonc'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' },
  { vendor: 'Kilo', command: 'kilo', homeRelative: ['.config', 'kilo', 'kilo.json'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' },
  { vendor: 'Kilo', command: 'kilo', homeRelative: ['.config', 'kilo', 'kilo.jsonc'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' },
  // `cmd mcp add -s user` writes ~/.commandcode/mcp.json. Verified against
  // Command Code's own MCP reference (user scope).
  { vendor: 'Command Code', command: 'command', homeRelative: ['.commandcode', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' },
];

export const IMPORT_MARKER_FILE = 'mcp-import.json';

export interface ImportedServer { name: string; from: string }
export interface SkippedServer { name: string; from: string; reason: string }
export interface McpImportResult {
  /** False when the import had already run, or could not run (see problem). */
  ran: boolean;
  imported: ImportedServer[];
  skipped: SkippedServer[];
  problem?: string;
}

type Normalized = { entry: Record<string, unknown> } | { skip: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  return Object.values(value).every((item) => typeof item === 'string') ? value as Record<string, string> : undefined;
}

/** Placeholder syntaxes vendors expand at launch -- Claude's `${VAR}`,
 * opencode's `{env:VAR}` / `{file:…}`. ClikCode's agent passes strings
 * through verbatim, so the server would receive the literal placeholder
 * instead of the secret. */
function unexpandedPlaceholder(entry: Record<string, unknown>): boolean {
  return /\$\{[^}]*\}|\{(env|file):[^}]*\}/.test(JSON.stringify(entry));
}

function stdioEntry(command: unknown, args: unknown, env: unknown): Normalized {
  if (typeof command !== 'string' || !command.trim()) return { skip: 'names no command or URL' };
  const argv = strings(args);
  const environment = stringRecord(env);
  if (!argv || !environment) return { skip: 'has arguments or environment that are not plain strings' };
  return { entry: { command, ...(argv.length ? { args: argv } : {}), ...(Object.keys(environment).length ? { env: environment } : {}) } };
}

function remoteEntry(url: unknown, sse: boolean, headers: unknown): Normalized {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { skip: 'has a URL that is not http(s)' };
  const table = stringRecord(headers);
  if (!table) return { skip: 'has headers that are not plain strings' };
  return { entry: { ...(sse ? { type: 'sse' } : {}), url, ...(Object.keys(table).length ? { headers: table } : {}) } };
}

const STDIO_TYPES = new Set(['stdio', 'local']);
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamable_http', 'streamablehttp', 'remote']);

/** One vendor entry in mcp.json's shape, or the reason it does not carry over. */
export function normalize(dialect: Dialect, raw: unknown): Normalized {
  if (!isRecord(raw)) return { skip: 'is not an object' };
  if (raw.disabled === true || raw.enabled === false) return { skip: 'is disabled there' };
  // A working directory changes what a relative command or path resolves
  // to, and mcp.json has no field for one.
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) return { skip: 'depends on a working directory mcp.json cannot express' };
  let result: Normalized;
  if (dialect === 'goose') {
    // builtin/platform/frontend extensions are Goose's own code, not MCP
    // servers anyone else can start.
    if (raw.type === 'stdio') {
      // env_keys name secrets held in Goose's keyring, not in the file.
      if (Array.isArray(raw.env_keys) && raw.env_keys.length) return { skip: 'keeps its secrets in the Goose keyring' };
      result = stdioEntry(raw.cmd, raw.args, raw.envs);
    } else if (raw.type === 'streamable_http' || raw.type === 'sse') {
      result = remoteEntry(raw.uri, raw.type === 'sse', raw.headers);
    } else {
      return { skip: `is a Goose ${String(raw.type ?? 'unknown')} extension, not a portable MCP server` };
    }
  } else if (dialect === 'opencode') {
    if (raw.type === 'local') {
      const argv = strings(raw.command);
      if (!argv?.length) return { skip: 'names no command' };
      result = stdioEntry(argv[0], argv.slice(1), raw.environment);
    } else if (raw.type === 'remote') {
      result = remoteEntry(raw.url, false, raw.headers);
    } else {
      return { skip: `has transport type "${String(raw.type)}"` };
    }
  } else {
    if (dialect === 'codex' && typeof raw.bearer_token_env_var === 'string') {
      return { skip: 'reads its bearer token from an environment variable at launch' };
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
    if (type && !STDIO_TYPES.has(type) && !HTTP_TYPES.has(type) && type !== 'sse') {
      return { skip: `has transport type "${raw.type as string}", which ClikCode's agent does not speak` };
    }
    const headers = dialect === 'codex' ? raw.http_headers ?? raw.headers : raw.headers;
    if (dialect === 'gemini' && typeof raw.httpUrl === 'string') {
      result = remoteEntry(raw.httpUrl, false, headers);
    } else if (typeof raw.url === 'string' || typeof raw.serverUrl === 'string') {
      // Gemini and Qwen document a bare `url` as SSE; `httpUrl` is streamable.
      const sse = type === 'sse' || (dialect === 'gemini' && !type);
      result = remoteEntry(raw.url ?? raw.serverUrl, sse, headers);
    } else {
      result = stdioEntry(raw.command, raw.args, raw.env);
    }
  }
  if ('skip' in result) return result;
  if (unexpandedPlaceholder(result.entry)) return { skip: 'uses ${VAR}-style placeholders the vendor expands and ClikCode would not' };
  // The same parser the agent loads with: what passes here will be started.
  if (!parseMcpServerEntry('probe', result.entry)) return { skip: 'is not a server ClikCode\'s agent could start' };
  return result;
}

/** Same command and arguments, or same URL: the same server. */
function identity(entry: Record<string, unknown>): string {
  return typeof entry.url === 'string' ? `url:${entry.url}` : `cmd:${JSON.stringify([entry.command, entry.args ?? []])}`;
}

async function readServerTable(path: string, source: VendorSource): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return undefined; }
  if (!text.trim()) return undefined;
  let root: unknown;
  try {
    if (source.format === 'toml') root = parseToml(text);
    else if (source.format === 'yaml') root = (await import('yaml')).parse(text);
    else root = JSON.parse(source.format === 'jsonc' ? stripJsonc(text) : text);
  } catch {
    // A vendor file this cannot read is that vendor's business; the others
    // still import.
    return undefined;
  }
  let table: unknown = root;
  for (const key of source.key) table = isRecord(table) ? table[key] : undefined;
  return isRecord(table) ? table : undefined;
}

/** Where this account's copy of one vendor file might be.
 *
 * A profile is either a fake HOME or the vendor's own config root
 * (`CODEX_HOME`, `QWEN_HOME`). Both shapes are checked: a missing path adds
 * nothing, and a name found in either one counts as already there. */
export function vendorConfigCandidates(
  source: VendorSource, home: string, profile?: { env: string; path: string },
): string[] {
  // An isolated profile is all the harness reads: the user's own file is not
  // seen there, so a name in it is not a name this profile has.
  if (!profile) return [join(home, ...source.homeRelative)];
  const files: string[] = [];
  if (profile.env === 'HOME') files.push(join(profile.path, ...source.homeRelative));
  else {
    files.push(join(profile.path, ...source.homeRelative));
    if (source.homeRelative.length > 1) files.push(join(profile.path, ...source.homeRelative.slice(1)));
    if (source.rootRelative) files.push(join(profile.path, ...source.rootRelative));
  }
  return [...new Set(files)];
}

/** Names already configured for this harness, when ClikCode knows the file.
 * `known` is false for a harness whose MCP file has not been observed.
 * `unreadable` is a file that exists but could not be parsed: the caller must
 * not add into it, because it cannot tell whether the name is already there. */
/** Names in one vendor file. A missing file or a missing server table is no
 * names. A file that exists but does not parse is unreadable. */
async function namesInVendorFile(path: string, source: VendorSource): Promise<Set<string> | 'missing' | 'unreadable'> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return 'missing'; }
  if (!text.trim()) return 'missing';
  let root: unknown;
  try {
    if (source.format === 'toml') root = parseToml(text);
    else if (source.format === 'yaml') root = (await import('yaml')).parse(text);
    else root = JSON.parse(source.format === 'jsonc' ? stripJsonc(text) : text);
  } catch { return 'unreadable'; }
  let table: unknown = root;
  for (const key of source.key) {
    if (!isRecord(table) || !(key in table)) return new Set();
    table = table[key];
  }
  return isRecord(table) ? new Set(Object.keys(table)) : 'unreadable';
}

export async function vendorMcpServerNames(
  command: string, home: string, profile?: { env: string; path: string },
): Promise<{ known: boolean; names: Set<string>; unreadable?: string }> {
  const sources = SOURCES.filter((source) => source.command === command);
  const names = new Set<string>();
  if (!sources.length) return { known: false, names };
  for (const source of sources) {
    for (const path of vendorConfigCandidates(source, home, profile)) {
      const found = await namesInVendorFile(path, source);
      if (found === 'missing') continue;
      if (found === 'unreadable') return { known: true, names, unreadable: path };
      for (const name of found) names.add(name);
    }
  }
  return { known: true, names };
}

/** The files to read for one source: the user's own, then each isolated
 * ClikCode account profile for that vendor, whose directory is either a
 * whole fake HOME or the vendor's own config root. */
async function candidatePaths(source: VendorSource, home: string, stateDir: string): Promise<string[]> {
  const paths = [join(home, ...source.homeRelative)];
  const profiles = join(stateDir, 'profiles', source.command);
  const ids = await readdir(profiles).catch(() => [] as string[]);
  for (const id of ids.sort()) {
    paths.push(join(profiles, id, ...source.homeRelative));
    if (source.rootRelative) paths.push(join(profiles, id, ...source.rootRelative));
  }
  return [...new Set(paths)];
}

/** Runs the import unless it has already run for this state directory. */
export async function importVendorMcpServers(
  stateDir: string, home: string = homedir(),
): Promise<McpImportResult> {
  const markerPath = join(stateDir, IMPORT_MARKER_FILE);
  if (await readFile(markerPath, 'utf8').then(() => true, () => false)) return { ran: false, imported: [], skipped: [] };

  const configPath = mcpConfigFilePath(stateDir);
  let root: Record<string, unknown> = {};
  const existingText = await readFile(configPath, 'utf8').catch(() => undefined);
  if (existingText?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existingText); } catch { parsed = undefined; }
    // Not marked as run: once the user fixes the file, the import still happens.
    if (!isRecord(parsed)) return { ran: false, imported: [], skipped: [], problem: `${configPath} is not a JSON object` };
    root = parsed;
  }
  const existing = isRecord(root[MCP_SERVERS_KEY]) ? { ...root[MCP_SERVERS_KEY] as Record<string, unknown> } : {};

  const taken = new Map<string, string>(); // name -> where it came from
  const identities = new Map<string, string>(); // identity -> name
  for (const [name, raw] of Object.entries(existing)) {
    taken.set(name, 'mcp.json');
    if (isRecord(raw)) identities.set(identity(raw), name);
  }
  const imported: ImportedServer[] = [];
  const skipped: SkippedServer[] = [];
  const added: Record<string, Record<string, unknown>> = {};

  for (const source of SOURCES) {
    for (const path of await candidatePaths(source, home, stateDir)) {
      const table = await readServerTable(path, source);
      if (!table) continue;
      for (const [name, raw] of Object.entries(table)) {
        const from = source.vendor;
        if (name === CONVERSATIONS_MCP_NAME) {
          skipped.push({ name, from, reason: 'is ClikCode\'s own; its agent has these tools built in' });
          continue;
        }
        const normalized = normalize(source.dialect, raw);
        if ('skip' in normalized) {
          skipped.push({ name, from, reason: normalized.skip });
          continue;
        }
        const id = identity(normalized.entry);
        const owner = taken.get(name);
        if (owner) {
          // Same server seen again (the usual fan-out case) is not news.
          if (identities.get(id) !== name) {
            skipped.push({ name, from, reason: owner === 'mcp.json' ? 'mcp.json already has a server by that name' : `conflicts with ${owner}'s definition, which was kept` });
          }
          continue;
        }
        const alias = identities.get(id);
        if (alias) {
          skipped.push({ name, from, reason: `same server as "${alias}"` });
          continue;
        }
        taken.set(name, from);
        identities.set(id, name);
        added[name] = normalized.entry;
        imported.push({ name, from });
      }
    }
  }

  if (imported.length) {
    // Re-read just before writing so a server added a moment ago by
    // `clikcode mcp add` in another process is not lost; its name still wins.
    const latestText = await readFile(configPath, 'utf8').catch(() => undefined);
    let latest: Record<string, unknown> = root;
    if (latestText?.trim() && latestText !== existingText) {
      try { const parsed: unknown = JSON.parse(latestText); if (isRecord(parsed)) latest = parsed; } catch { /* keep the earlier read */ }
    }
    const latestServers = isRecord(latest[MCP_SERVERS_KEY]) ? latest[MCP_SERVERS_KEY] as Record<string, unknown> : {};
    const merged: Record<string, unknown> = { ...latestServers };
    for (const [name, entry] of Object.entries(added)) if (!(name in merged)) merged[name] = entry;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ ...latest, [MCP_SERVERS_KEY]: merged }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // The copied env and headers are often API keys; the vendor files they
    // came from are private to the user, and this one must be too.
    await chmod(configPath, 0o600).catch(() => undefined);
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(markerPath, `${JSON.stringify({ ranAt: new Date().toISOString(), imported, skipped }, null, 2)}\n`, 'utf8');
  return { ran: true, imported, skipped };
}

/** The one line a user sees, only when something was imported. */
export function importNotice(result: McpImportResult): string | undefined {
  if (!result.imported.length) return undefined;
  const list = result.imported.map((server) => `${server.name} (${server.from})`).join(', ');
  return `Imported ${result.imported.length} MCP server${result.imported.length === 1 ? '' : 's'} from your harness configs into mcp.json: ${list}`;
}

/** JSON with comments and trailing commas, as opencode and Kilo write it.
 * A scanner rather than a regex, so `//` inside a URL string survives. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Enough TOML for an MCP server table: tables, dotted and quoted keys,
 * strings, numbers, booleans, arrays and inline tables. There is no TOML
 * dependency in ClikCode, and this is read-only -- a statement it cannot
 * parse is skipped rather than failing the file, since only `mcp_servers`
 * matters here. */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  let i = 0;
  const peek = (offset = 0): string => text[i + offset] ?? '';
  const skipSpace = (newlines: boolean): void => {
    for (;;) {
      const char = peek();
      if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) i++;
      else if (char === '#') { while (i < text.length && peek() !== '\n') i++; }
      else return;
    }
  };
  const fail = (): never => { throw new Error(`TOML parse error at ${i}`); };

  const basicString = (): string => {
    let value = '';
    i++;
    while (peek() !== '"') {
      if (i >= text.length || peek() === '\n') fail();
      if (peek() === '\\') {
        const next = peek(1);
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (next === 'u' || next === 'U') {
          const length = next === 'u' ? 4 : 8;
          value += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + length), 16));
          i += 2 + length;
          continue;
        }
        value += escapes[next] ?? fail();
        i += 2;
        continue;
      }
      value += peek();
      i++;
    }
    i++;
    return value;
  };
  const delimited = (quote: string): string => {
    const end = text.indexOf(quote, i + quote.length);
    if (end < 0) fail();
    const value = text.slice(i + quote.length, end);
    i = end + quote.length;
    return quote.length === 3 ? value.replace(/^\r?\n/, '') : value;
  };
  const key = (): string => {
    if (peek() === '"') return basicString();
    if (peek() === "'") return delimited("'");
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!match) fail();
    i += match![0].length;
    return match![0];
  };
  const keyPath = (): string[] => {
    const path = [key()];
    for (;;) {
      skipSpace(false);
      if (peek() !== '.') return path;
      i++;
      skipSpace(false);
      path.push(key());
    }
  };
  const table = (base: Record<string, unknown>, path: readonly string[]): Record<string, unknown> => {
    let node = base;
    for (const part of path) {
      let next = node[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isRecord(next)) { next = {}; node[part] = next; }
      node = next as Record<string, unknown>;
    }
    return node;
  };
  const value = (): unknown => {
    if (text.startsWith('"""', i)) return delimited('"""');
    if (text.startsWith("'''", i)) return delimited("'''");
    if (peek() === '"') return basicString();
    if (peek() === "'") return delimited("'");
    if (peek() === '[') {
      i++;
      const items: unknown[] = [];
      for (;;) {
        skipSpace(true);
        if (peek() === ']') { i++; return items; }
        items.push(value());
        skipSpace(true);
        if (peek() === ',') i++;
        else if (peek() !== ']') fail();
      }
    }
    if (peek() === '{') {
      i++;
      const inline: Record<string, unknown> = {};
      skipSpace(false);
      if (peek() === '}') { i++; return inline; }
      for (;;) {
        skipSpace(false);
        const path = keyPath();
        if (peek() !== '=') fail();
        i++;
        skipSpace(false);
        table(inline, path.slice(0, -1))[path[path.length - 1]!] = value();
        skipSpace(false);
        if (peek() === ',') { i++; continue; }
        if (peek() === '}') { i++; return inline; }
        fail();
      }
    }
    // Booleans, numbers and dates; anything else bare is not a TOML value.
    const match = /^[-+0-9A-Za-z_:.]+/.exec(text.slice(i));
    if (!match) fail();
    i += match![0].length;
    if (match![0] === 'true') return true;
    if (match![0] === 'false') return false;
    const number = Number(match![0].replace(/_/g, ''));
    return Number.isNaN(number) ? match![0] : number;
  };

  while (i < text.length) {
    skipSpace(true);
    if (i >= text.length) break;
    const start = i;
    try {
      if (text.startsWith('[[', i)) {
        i += 2; skipSpace(false);
        const path = keyPath();
        if (!text.startsWith(']]', i)) fail();
        i += 2;
        const parent = table(root, path.slice(0, -1));
        const last = path[path.length - 1]!;
        const list = Array.isArray(parent[last]) ? parent[last] as unknown[] : (parent[last] = []) as unknown[];
        current = {};
        list.push(current);
      } else if (peek() === '[') {
        i++; skipSpace(false);
        const path = keyPath();
        if (peek() !== ']') fail();
        i++;
        current = table(root, path);
      } else {
        const path = keyPath();
        if (peek() !== '=') fail();
        i++;
        skipSpace(false);
        table(current, path.slice(0, -1))[path[path.length - 1]!] = value();
      }
      skipSpace(false);
      if (i < text.length && peek() !== '\n') fail();
    } catch {
      // Resume at the next line; the statement is lost, the file is not.
      i = Math.max(i, start + 1);
      while (i < text.length && peek() !== '\n') i++;
    }
  }
  return root;
}
