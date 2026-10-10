/** Language-server diagnostics and code navigation, from servers already
 * installed on PATH (lsp/servers.ts). Positions are 1-based here and 0-based
 * (UTF-16) on the wire. */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineTool, type ToolContext } from '../tool-contract.js';
import { displayPath, resolveForRead, ToolInputError } from './fs-helpers.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { fileUri, languageFor, runningServerFor, serverFor, ServerMissingError, type Diagnostic, type LanguageServer, type Range } from '../lsp/servers.js';

type Operation = 'diagnostics' | 'definition' | 'references' | 'hover' | 'document_symbols' | 'workspace_symbols';
interface LspArgs { operation: Operation; file?: string; line?: number; character?: number; query?: string }

const POSITION_OPERATIONS: ReadonlySet<Operation> = new Set(['definition', 'references', 'hover']);
const DIAGNOSTICS_WAIT_MS = 5_000;
const AFTER_EDIT_WAIT_MS = 2_500;
const MAX_DIAGNOSTICS = 50;
const MAX_LOCATIONS = 100;
const MAX_SYMBOLS = 300;
const MAX_HOVER_CHARS = 4_000;
const MAX_CHANGED_FILES = 20;
const AFTER_EDIT_ERRORS = 5;

const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

type Shown = Pick<ToolContext, 'cwd'>;

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function more(total: number, shown: number, what: string): string[] {
  return total > shown ? [`… ${total - shown} more ${what}`] : [];
}

/** `path:line:col severity message [source code]`, errors first, then by place. */
export function formatDiagnostics(byFile: ReadonlyMap<string, readonly Diagnostic[]>, ctx: Shown, max = MAX_DIAGNOSTICS): string[] {
  const rows = [...byFile].flatMap(([file, items]) => items.map((item) => ({ file, item })));
  rows.sort((a, b) => (a.item.severity ?? 1) - (b.item.severity ?? 1) || a.file.localeCompare(b.file) || a.item.range.start.line - b.item.range.start.line || a.item.range.start.character - b.item.range.start.character);
  const lines = rows.slice(0, max).map(({ file, item }) => {
    const tag = [item.source, item.code].filter((part) => part !== undefined && part !== '').join(' ');
    return `${displayPath(file, ctx)}:${item.range.start.line + 1}:${item.range.start.character + 1} ${SEVERITY[item.severity ?? 1] ?? 'error'} ${oneLine(item.message)}${tag ? ` [${tag}]` : ''}`;
  });
  return [...lines, ...more(rows.length, lines.length, 'diagnostics')];
}

interface Location { uri: string; range: Range }

/** Location | Location[] | LocationLink[] | null, as one list. */
export function toLocations(result: unknown): Location[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  return items.flatMap((item: Record<string, unknown>) => {
    if (typeof item?.targetUri === 'string') return [{ uri: item.targetUri, range: (item.targetSelectionRange ?? item.targetRange) as Range }];
    if (typeof item?.uri === 'string' && item.range) return [{ uri: item.uri, range: item.range as Range }];
    return [];
  });
}

function uriPath(uri: string): string {
  try { return uri.startsWith('file:') ? fileURLToPath(uri) : uri; } catch { return uri; }
}

/** Reads each file once per call; a file that cannot be read shows no text. */
function lineReader(): (file: string, line: number) => Promise<string> {
  const cache = new Map<string, Promise<string[]>>();
  return async (file, line) => {
    if (!cache.has(file)) cache.set(file, fs.readFile(file, 'utf8').then((text) => text.split(/\r?\n/), () => []));
    return (await cache.get(file)!)[line]?.trim().slice(0, 200) ?? '';
  };
}

/** `path:line:col  text of that line`. */
export async function formatLocations(locations: readonly Location[], ctx: Shown, max = MAX_LOCATIONS): Promise<string[]> {
  const read = lineReader();
  const lines = await Promise.all(locations.slice(0, max).map(async ({ uri, range }) => {
    const file = uriPath(uri);
    const text = await read(file, range.start.line);
    return `${displayPath(file, ctx)}:${range.start.line + 1}:${range.start.character + 1}${text ? `  ${text}` : ''}`;
  }));
  return [...lines, ...more(locations.length, lines.length, 'locations')];
}

/** MarkupContent | MarkedString | MarkedString[], as text. */
export function hoverText(result: unknown): string {
  const contents = (result as { contents?: unknown } | null)?.contents;
  const part = (value: unknown): string => typeof value === 'string' ? value
    : value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string' ? (value as { value: string }).value : '';
  const text = (Array.isArray(contents) ? contents.map(part) : [part(contents)]).filter(Boolean).join('\n\n').trim();
  return text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS)}…` : text;
}

interface SymbolNode { name: string; kind: number; detail?: string; range?: Range; selectionRange?: Range; location?: Location; containerName?: string; children?: SymbolNode[] }

function kindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'symbol';
}

/** DocumentSymbol[] as an indented outline, or SymbolInformation[] flat:
 * `kind name  :line`. */
export function formatDocumentSymbols(result: unknown, max = MAX_SYMBOLS): string[] {
  const out: string[] = [];
  let total = 0;
  const walk = (nodes: readonly SymbolNode[], depth: number): void => {
    for (const node of nodes) {
      total++;
      const range = node.selectionRange ?? node.range ?? node.location?.range;
      if (out.length < max) out.push(`${'  '.repeat(depth)}${kindName(node.kind)} ${node.name}${node.detail ? ` ${oneLine(node.detail, 80)}` : ''}${range ? `  :${range.start.line + 1}` : ''}`);
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(Array.isArray(result) ? result as SymbolNode[] : [], 0);
  return [...out, ...more(total, out.length, 'symbols')];
}

/** `kind name (container)  path:line:col`. */
export function formatWorkspaceSymbols(result: unknown, ctx: Shown, max = MAX_LOCATIONS): string[] {
  const nodes = Array.isArray(result) ? result as SymbolNode[] : [];
  const lines = nodes.slice(0, max).map((node) => {
    const where = node.location?.uri ? `${displayPath(uriPath(node.location.uri), ctx)}${node.location.range ? `:${node.location.range.start.line + 1}:${node.location.range.start.character + 1}` : ''}` : '';
    return `${kindName(node.kind)} ${node.name}${node.containerName ? ` (${node.containerName})` : ''}${where ? `  ${where}` : ''}`;
  });
  return [...lines, ...more(nodes.length, lines.length, 'symbols')];
}

/** Files the file tools changed in this turn (the undo checkpoint's list). */
async function changedThisTurn(ctx: ToolContext): Promise<string[]> {
  const sessionId = ctx.checkpoint?.sessionId ?? ctx.sessionId;
  const turnId = ctx.checkpoint?.turnId ?? ctx.turnId;
  const turn = (await ctx.checkpoints.listTurns(sessionId).catch(() => [])).find((entry) => entry.turnId === turnId);
  const files = await Promise.all((turn?.files ?? []).map(async (file) => (await fs.stat(file).catch(() => undefined))?.isFile() && languageFor(file) ? file : undefined));
  return files.filter((file): file is string => Boolean(file));
}

function stillWorking(server: LanguageServer, waitedMs: number): string {
  return `[${server.name} ${server.busy ? `is still indexing (${server.busy})` : `did not report within ${waitedMs / 1000}s`}; this is what it has so far.]`;
}

async function diagnostics(files: readonly string[], ctx: ToolContext): Promise<string> {
  const groups = new Map<LanguageServer, string[]>();
  const problems: string[] = [];
  for (const file of files) {
    try {
      const server = await serverFor(file, ctx.cwd);
      groups.set(server, [...groups.get(server) ?? [], file]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!problems.includes(message)) problems.push(message);
    }
  }
  const byFile = new Map<string, Diagnostic[]>();
  const notes: string[] = [];
  await Promise.all([...groups].map(async ([server, group]) => {
    for (const file of group) await server.sync(file);
    const result = await server.waitForDiagnostics(group, DIAGNOSTICS_WAIT_MS, ctx.signal);
    for (const [file, items] of result.byFile) byFile.set(file, items);
    if (!result.complete) notes.push(stillWorking(server, DIAGNOSTICS_WAIT_MS));
  }));
  const lines = formatDiagnostics(byFile, ctx);
  const checked = byFile.size;
  const summary = checked ? (lines.length ? [] : [`No diagnostics in ${checked === 1 ? displayPath([...byFile.keys()][0]!, ctx) : `${checked} files`}.`]) : [];
  return [...lines, ...summary, ...notes, ...problems].join('\n');
}

function position(args: LspArgs, text: string): { line: number; character: number } {
  if (args.line === undefined) throw new ToolInputError(`${args.operation} needs line (1-based).`);
  const lines = text.split(/\r?\n/);
  if (args.line > lines.length) throw new ToolInputError(`line ${args.line} is past the end of the file (${lines.length} lines).`);
  const lineText = lines[args.line - 1] ?? '';
  // No character: the first non-blank one on the line.
  const character = args.character !== undefined ? args.character - 1 : Math.max(0, lineText.search(/\S/));
  return { line: args.line - 1, character: Math.min(character, lineText.length) };
}

export const lspTool = defineTool<LspArgs>({
  name: 'lsp',
  class: 'read',
  description: 'Ask the language server for a file (TypeScript/JS, Python, Go, Rust, C/C++; installed servers only): diagnostics (a file, or the files changed this turn when no file is given), definition, references, hover, document_symbols, or workspace_symbols (with query). Line and character are 1-based.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['diagnostics', 'definition', 'references', 'hover', 'document_symbols', 'workspace_symbols'] },
      file: { type: 'string', description: 'File path. Required except for diagnostics.' },
      line: { type: 'integer', minimum: 1, description: '1-based line, for definition, references and hover.' },
      character: { type: 'integer', minimum: 1, description: '1-based column of the symbol; defaults to the first non-blank one.' },
      query: { type: 'string', description: 'Symbol name to search for, for workspace_symbols.' },
    },
  },
  label: (args) => formatToolRow('LSP', `${args.operation.replace('_', ' ')}${args.file ? ` ${args.file}${args.line ? `:${args.line}${args.character ? `:${args.character}` : ''}` : ''}` : ''}${args.query ? ` ${args.query}` : ''}`),
  paths: (args) => args.file ? [args.file] : [],
  async run(args, ctx) {
    try {
      if (args.operation === 'diagnostics' && !args.file) {
        const files = await changedThisTurn(ctx);
        if (!files.length) return { output: 'No source files were changed this turn; name a file to check.' };
        const output = await diagnostics(files.slice(0, MAX_CHANGED_FILES), ctx);
        return { output: files.length > MAX_CHANGED_FILES ? `${output}\n[Checked the first ${MAX_CHANGED_FILES} of ${files.length} changed files.]` : output };
      }
      if (!args.file) throw new ToolInputError(`${args.operation} needs file.`);
      const resolved = resolveForRead(args.file, ctx);
      const stat = await fs.stat(resolved.real).catch(() => undefined);
      if (!stat?.isFile()) return { output: `File not found: ${args.file}`, isError: true };
      const file = resolved.real;
      if (args.operation === 'diagnostics') return { output: await diagnostics([file], ctx) };
      if (args.operation === 'workspace_symbols' && !args.query?.trim()) throw new ToolInputError('workspace_symbols needs query.');
      const server = await serverFor(file, ctx.cwd);
      await server.sync(file);
      const textDocument = { uri: fileUri(file) };
      const at = POSITION_OPERATIONS.has(args.operation) ? position(args, server.documents.get(textDocument.uri)!.text) : undefined;
      const shown = displayPath(file, ctx);
      let lines: string[];
      switch (args.operation) {
        case 'definition':
          lines = await formatLocations(toLocations(await server.request('textDocument/definition', { textDocument, position: at }, ctx.signal)), ctx);
          if (!lines.length) lines = [`No definition found at ${shown}:${args.line}.`];
          break;
        case 'references':
          lines = await formatLocations(toLocations(await server.request('textDocument/references', { textDocument, position: at, context: { includeDeclaration: true } }, ctx.signal)), ctx);
          if (!lines.length) lines = [`No references found at ${shown}:${args.line}.`];
          break;
        case 'hover':
          lines = [hoverText(await server.request('textDocument/hover', { textDocument, position: at }, ctx.signal)) || `Nothing to show at ${shown}:${args.line}.`];
          break;
        case 'document_symbols':
          lines = formatDocumentSymbols(await server.request('textDocument/documentSymbol', { textDocument }, ctx.signal));
          if (!lines.length) lines = [`No symbols in ${shown}.`];
          break;
        default:
          lines = formatWorkspaceSymbols(await server.request('workspace/symbol', { query: args.query }, ctx.signal), ctx);
          if (!lines.length) lines = [`No symbols match "${args.query}".`];
      }
      if (server.busy) lines.push(`[${server.name} is still indexing (${server.busy}); results may be incomplete.]`);
      return { output: lines.join('\n') };
    } catch (error) {
      if (error instanceof ServerMissingError || error instanceof ToolInputError) return { output: error.message, isError: true };
      if (ctx.signal?.aborted) throw error;
      return { output: `Language server error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  },
});

/** For edit_file, write_file and multi_edit: errors the edit introduced, if
 * this file's server is already running. Nothing (and no wait) otherwise, and
 * never a reason for the edit itself to fail. */
export async function errorsAfterEdit(file: string, ctx: ToolContext): Promise<string> {
  try {
    const server = await runningServerFor(file, ctx.cwd);
    if (!server) return '';
    const uri = fileUri(file);
    const before = new Set((server.documents.has(uri) ? server.diagnostics.get(uri)?.items ?? [] : []).filter(isError).map(errorKey));
    if (!await server.sync(file)) return '';
    const result = await server.waitForDiagnostics([file], AFTER_EDIT_WAIT_MS, ctx.signal);
    const introduced = (result.byFile.get(file) ?? []).filter((item) => isError(item) && !before.has(errorKey(item)));
    if (!introduced.length) return '';
    const lines = formatDiagnostics(new Map([[file, introduced]]), ctx, AFTER_EDIT_ERRORS);
    return `\n\n${server.name} reports new errors:\n${lines.join('\n')}`;
  } catch {
    return ''; // fail-open-ok: the edit is done; a server problem is the lsp tool's to report.
  }
}

function isError(item: Diagnostic): boolean {
  return (item.severity ?? 1) === 1;
}

/** Same error, even if lines moved above it. */
function errorKey(item: Diagnostic): string {
  return `${item.source ?? ''}\0${item.code ?? ''}\0${item.message}`;
}
