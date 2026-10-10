/** Language servers for the agent's `lsp` tool: which server a file needs
 * (only ones already on PATH, never installed), one running server per
 * (language, workspace root) kept for the life of the process, and the
 * document sync and diagnostics wait every query goes through. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBinaryPath } from '../../harness/transport/native/binary.js';
import { spawnPortable, terminatePortable } from '../../harness/transport/spawn.js';
import { LspConnection } from './client.js';

interface ServerCandidate { command: string; args: string[] }

export interface LanguageSpec {
  id: string;
  /** Named in the "nothing installed" line. */
  label: string;
  extensions: readonly string[];
  languageId(extension: string): string;
  /** Tried in order; the first on PATH is used. */
  servers: readonly ServerCandidate[];
  /** The nearest ancestor holding one of these is the workspace root. */
  rootMarkers: readonly string[];
  install: string;
}

const C_HEADERS = new Set(['.c', '.h']);

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: 'typescript', label: 'TypeScript/JavaScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    languageId: (extension) => ({ '.tsx': 'typescriptreact', '.jsx': 'javascriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' } as Record<string, string>)[extension] ?? 'typescript',
    servers: [{ command: 'typescript-language-server', args: ['--stdio'] }, { command: 'vtsls', args: ['--stdio'] }],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: 'install typescript-language-server (npm i -g typescript-language-server typescript) or vtsls',
  },
  {
    id: 'python', label: 'Python', extensions: ['.py', '.pyi'], languageId: () => 'python',
    servers: [{ command: 'pyright-langserver', args: ['--stdio'] }, { command: 'pylsp', args: [] }],
    rootMarkers: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
    install: 'install pyright (npm i -g pyright) or python-lsp-server (pip install python-lsp-server)',
  },
  {
    id: 'go', label: 'Go', extensions: ['.go'], languageId: () => 'go',
    servers: [{ command: 'gopls', args: [] }],
    rootMarkers: ['go.work', 'go.mod'],
    install: 'install gopls (go install golang.org/x/tools/gopls@latest)',
  },
  {
    id: 'rust', label: 'Rust', extensions: ['.rs'], languageId: () => 'rust',
    servers: [{ command: 'rust-analyzer', args: [] }],
    rootMarkers: ['Cargo.toml'],
    install: 'install rust-analyzer (rustup component add rust-analyzer)',
  },
  {
    id: 'cpp', label: 'C/C++',
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.ipp'],
    languageId: (extension) => C_HEADERS.has(extension) ? 'c' : 'cpp',
    servers: [{ command: 'clangd', args: [] }],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt'],
    install: 'install clangd (e.g. apt install clangd, brew install llvm)',
  },
];

export function languageFor(file: string): LanguageSpec | undefined {
  const extension = path.extname(file).toLowerCase();
  return LANGUAGES.find((language) => language.extensions.includes(extension));
}

/** The nearest ancestor of `file` with one of the language's markers, else
 * the nearest with `.git`, else `fallback` when the file is inside it, else
 * the file's own directory. */
export async function workspaceRoot(file: string, language: LanguageSpec, fallback: string): Promise<string> {
  const exists = (candidate: string): Promise<boolean> => fs.access(candidate).then(() => true, () => false);
  let gitRoot: string | undefined;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    for (const marker of language.rootMarkers) if (await exists(path.join(dir, marker))) return dir;
    if (!gitRoot && await exists(path.join(dir, '.git'))) gitRoot = dir;
    if (path.dirname(dir) === dir) break;
  }
  if (gitRoot) return gitRoot;
  const relative = path.relative(fallback, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? fallback : path.dirname(file);
}

export class ServerMissingError extends Error {}

/** The first of the language's servers on PATH. Looked up on each start, so
 * a server installed mid-session is found without a restart. */
async function findServer(language: LanguageSpec): Promise<ServerCandidate & { binary: string }> {
  for (const candidate of language.servers) {
    const binary = await resolveBinaryPath(candidate.command);
    if (binary) return { ...candidate, binary };
  }
  throw new ServerMissingError(`No ${language.label} language server on PATH: ${language.install}.`);
}

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Diagnostic { range: Range; severity?: number; message: string; source?: string; code?: string | number }

interface OpenDocument { version: number; text: string; sentAt: number }

const INITIALIZE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
/** After the first publish for a file, further ones (a server that sends
 * syntax errors first, semantic ones after) still count if they come this soon. */
const DIAGNOSTICS_SETTLE_MS = 400;

export function fileUri(file: string): string {
  return pathToFileURL(file).href;
}

/** One running server for one (language, root). */
export class LanguageServer {
  readonly documents = new Map<string, OpenDocument>();
  /** Latest diagnostics per uri, and when each arrived. */
  readonly diagnostics = new Map<string, { items: Diagnostic[]; at: number; version?: number }>();
  /** Work-done progress the server has begun and not ended: indexing. */
  private readonly progress = new Map<string | number, string>();
  private readonly waiters = new Set<() => void>();
  lastUsed = Date.now();

  private constructor(
    readonly language: LanguageSpec,
    readonly root: string,
    readonly name: string,
    readonly connection: LspConnection,
    private readonly child: import('node:child_process').ChildProcess,
  ) {
    connection.onNotification((method, params) => this.onNotification(method, params));
  }

  static async start(language: LanguageSpec, root: string): Promise<LanguageServer> {
    const server = await findServer(language);
    const child = spawnPortable(server.binary, server.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const folders = [{ uri: fileUri(root), name: path.basename(root) || root }];
    const connection = new LspConnection(child, server.command, folders);
    const instance = new LanguageServer(language, root, server.command, connection, child);
    try {
      await connection.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'clikcode' },
        rootUri: fileUri(root),
        rootPath: root,
        workspaceFolders: folders,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          window: { workDoneProgress: true },
          workspace: { workspaceFolders: true, configuration: true, symbol: {} },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { versionSupport: true },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      }, INITIALIZE_TIMEOUT_MS);
    } catch (error) {
      terminatePortable(child, 'SIGKILL');
      throw error;
    }
    connection.notify('initialized', {});
    return instance;
  }

  get running(): boolean { return !this.connection.closed; }

  /** Indexing still under way, in the server's own words when it gave any. */
  get busy(): string | undefined {
    const titles = [...this.progress.values()];
    return titles.length ? titles.find(Boolean) ?? 'working' : undefined;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics, version } = params as { uri: string; diagnostics?: Diagnostic[]; version?: number };
      this.diagnostics.set(uri, { items: Array.isArray(diagnostics) ? diagnostics : [], at: Date.now(), ...(typeof version === 'number' ? { version } : {}) });
      for (const wake of [...this.waiters]) wake();
    } else if (method === '$/progress') {
      const { token, value } = params as { token: string | number; value?: { kind?: string; title?: string } };
      if (value?.kind === 'begin') this.progress.set(token, value.title ?? '');
      else if (value?.kind === 'end') this.progress.delete(token);
    }
  }

  /** Opens the file, or sends its new text if it changed on disk since the
   * server last saw it. Returns whether anything was sent. */
  async sync(file: string): Promise<boolean> {
    const uri = fileUri(file);
    const text = await fs.readFile(file, 'utf8');
    const open = this.documents.get(uri);
    if (open?.text === text) return false;
    if (!open) {
      this.documents.set(uri, { version: 1, text, sentAt: Date.now() });
      this.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.language.languageId(path.extname(file).toLowerCase()), version: 1, text } });
    } else {
      open.version++;
      open.text = text;
      open.sentAt = Date.now();
      this.connection.notify('textDocument/didChange', { textDocument: { uri, version: open.version }, contentChanges: [{ text }] });
    }
    return true;
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    this.lastUsed = Date.now();
    return this.connection.request<T>(method, params, REQUEST_TIMEOUT_MS, signal);
  }

  /** Diagnostics for these (synced) files, waiting up to `timeoutMs` for the
   * server to publish for the text it was last sent. `complete` is false when
   * some file's wait ran out (the server is slow or still indexing). */
  async waitForDiagnostics(files: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<{ byFile: Map<string, Diagnostic[]>; complete: boolean }> {
    const uris = files.map(fileUri);
    const current = (uri: string): boolean => {
      const published = this.diagnostics.get(uri);
      const document = this.documents.get(uri);
      if (!published || !document) return false;
      return published.at >= document.sentAt && (published.version === undefined || published.version >= document.version);
    };
    const fresh = (): boolean => uris.every(current);
    const deadline = Date.now() + timeoutMs;
    const wait = (ms: number): Promise<void> => new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    while (!fresh() && Date.now() < deadline && this.running && !signal?.aborted) await wait(deadline - Date.now());
    const complete = fresh();
    if (complete) {
      // A second publish (semantic after syntax) often follows the first closely.
      for (let last = Date.now(); Date.now() - last < DIAGNOSTICS_SETTLE_MS && Date.now() < deadline && !signal?.aborted;) {
        const before = Math.max(...uris.map((uri) => this.diagnostics.get(uri)?.at ?? 0));
        await wait(Math.min(DIAGNOSTICS_SETTLE_MS, deadline - Date.now()));
        const after = Math.max(...uris.map((uri) => this.diagnostics.get(uri)?.at ?? 0));
        if (after === before) break;
        last = after;
      }
    }
    return { byFile: new Map(files.map((file, index) => [file, this.diagnostics.get(uris[index])?.items ?? []])), complete };
  }

  /** Polite shutdown, then a kill if the server does not leave in time. */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    try { await this.connection.request('shutdown', null, SHUTDOWN_TIMEOUT_MS); } catch { /* fail-open-ok: killed below */ }
    this.connection.notify('exit', null);
    await new Promise<void>((resolve) => {
      if (!this.running) return resolve();
      const timer = setTimeout(() => { this.kill(); resolve(); }, SHUTDOWN_TIMEOUT_MS);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  kill(): void { terminatePortable(this.child, 'SIGKILL'); }
}

/** More than this many at once, the least recently used one is stopped. */
const MAX_SERVERS = 6;
const servers = new Map<string, Promise<LanguageServer>>();
/** The same servers once started: what a synchronous caller can reach. */
const settled = new Map<string, LanguageServer>();
let exitHookInstalled = false;

/** `exit` handlers must be synchronous: whatever is still running is killed. */
function killAllNow(): void {
  for (const server of settled.values()) server.kill();
}

function key(language: LanguageSpec, root: string): string {
  return `${language.id}\0${root}`;
}

/** The running server for this file's language and root, started on first
 * use. A server that died is started again. */
export async function serverFor(file: string, fallbackRoot: string): Promise<LanguageServer> {
  const language = languageFor(file);
  if (!language) throw new ServerMissingError(`No language server is known for ${path.extname(file) || 'files without an extension'}; supported: ${LANGUAGES.map((entry) => entry.label).join(', ')}.`);
  const root = await workspaceRoot(file, language, fallbackRoot);
  const id = key(language, root);
  const existing = servers.get(id);
  if (existing) {
    const server = await existing.catch(() => undefined);
    if (server?.running) { server.lastUsed = Date.now(); return server; }
    if (servers.get(id) === existing) { servers.delete(id); settled.delete(id); }
  }
  if (!exitHookInstalled) { exitHookInstalled = true; process.once('exit', killAllNow); }
  await evictIfFull();
  const starting = LanguageServer.start(language, root);
  servers.set(id, starting);
  try {
    const server = await starting;
    settled.set(id, server);
    return server;
  } catch (error) {
    if (servers.get(id) === starting) servers.delete(id);
    throw error;
  }
}

/** The server for this file only if one is already running: an edit never
 * starts a server just to check itself. */
export async function runningServerFor(file: string, fallbackRoot: string): Promise<LanguageServer | undefined> {
  if (!settled.size) return undefined;
  const language = languageFor(file);
  if (!language) return undefined;
  const server = settled.get(key(language, await workspaceRoot(file, language, fallbackRoot)));
  return server?.running ? server : undefined;
}

async function evictIfFull(): Promise<void> {
  if (settled.size < MAX_SERVERS) return;
  const [id, oldest] = [...settled.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
  settled.delete(id);
  servers.delete(id);
  await oldest.shutdown();
}

/** Stops every server this process started. The worker calls it on shutdown. */
export async function shutdownLanguageServers(): Promise<void> {
  const all = await Promise.all([...servers.values()].map((pending) => pending.catch(() => undefined)));
  servers.clear();
  settled.clear();
  await Promise.all(all.map((server) => server?.shutdown()));
}
