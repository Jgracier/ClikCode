import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from '../file-checkpoints.js';
import { resolveBinaryPath } from '../../harness/transport/native/binary.js';
import { shutdownLanguageServers } from '../lsp/servers.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';
import { editFileTool } from './edit-file.js';
import { formatDiagnostics, formatDocumentSymbols, formatLocations, formatWorkspaceSymbols, hoverText, lspTool, toLocations } from './lsp.js';
import { readFileTool } from './read-file.js';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lsp', 'fixtures', 'fake-lsp-server.mjs');
const range = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 1 } });

describe('lsp output formatting', () => {
  it('lists diagnostics as path:line:col severity message, errors first and capped', () => {
    const byFile = new Map([['/w/src/a.ts', [
      { range: range(9, 0), severity: 2, message: 'unused', source: 'ts', code: 6133 },
      { range: range(2, 4), severity: 1, message: 'Type error\n  more detail' },
      { range: range(0, 0), severity: 1, message: 'first' },
    ]]]);
    expect(formatDiagnostics(byFile, { cwd: '/w' })).toEqual([
      'src/a.ts:1:1 error first',
      'src/a.ts:3:5 error Type error more detail',
      'src/a.ts:10:1 warning unused [ts 6133]',
    ]);
    expect(formatDiagnostics(byFile, { cwd: '/w' }, 1)).toEqual(['src/a.ts:1:1 error first', '… 2 more diagnostics']);
  });

  it('takes Location, Location[] and LocationLink[] alike', () => {
    expect(toLocations({ uri: 'file:///a', range: range(1, 1) })).toHaveLength(1);
    expect(toLocations([{ targetUri: 'file:///b', targetRange: range(0, 0), targetSelectionRange: range(4, 2) }])).toEqual([{ uri: 'file:///b', range: range(4, 2) }]);
    expect(toLocations(null)).toEqual([]);
  });

  it('shows each location with the text of its line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-format-'));
    await writeFile(path.join(dir, 'x.go'), 'package x\n\n  func Hello() {}\n');
    const lines = await formatLocations([{ uri: `file://${dir}/x.go`, range: range(2, 7) }, { uri: 'file:///gone/y.go', range: range(0, 0) }], { cwd: dir });
    expect(lines).toEqual(['x.go:3:8  func Hello() {}', '/gone/y.go:1:1']);
    await rm(dir, { recursive: true, force: true });
  });

  it('renders hover contents of every shape', () => {
    expect(hoverText({ contents: { kind: 'markdown', value: '`x: number`' } })).toBe('`x: number`');
    expect(hoverText({ contents: ['a', { language: 'ts', value: 'b' }] })).toBe('a\n\nb');
    expect(hoverText({ contents: { kind: 'markdown', value: '```ts\nconst x: number\n```\n\ndocs' } })).toBe('const x: number\n\ndocs');
    expect(hoverText(null)).toBe('');
  });

  it('outlines document symbols by nesting and lists workspace symbols with places', () => {
    expect(formatDocumentSymbols([{ name: 'A', kind: 5, range: range(0, 0), selectionRange: range(0, 6), children: [{ name: 'run', kind: 6, detail: '(): void', range: range(1, 2) }] }]))
      .toEqual(['class A  :1', '  method run (): void  :2']);
    expect(formatDocumentSymbols([{ name: 'f', kind: 12, location: { uri: 'file:///w/a', range: range(3, 0) } }])).toEqual(['function f  :4']);
    expect(formatWorkspaceSymbols([{ name: 'f', kind: 12, containerName: 'pkg', location: { uri: 'file:///w/a.go', range: range(3, 5) } }], { cwd: '/w' })).toEqual(['function f (pkg)  a.go:4:6']);
  });
});

function contextFor(cwd: string, stateDir: string, sessionId: string): ToolContext {
  return {
    cwd, addDirs: [], sessionId, turnId: 'turn-1', stateDir, homeDir: stateDir,
    checkpoints: new FileCheckpointStore(stateDir), session: sessionState(stateDir, sessionId),
  } as ToolContext;
}

describe.skipIf(process.platform === 'win32')('the lsp tool with a fake server on PATH', () => {
  let root: string;
  let ctx: ToolContext;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'lsp-tool-')));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'gopls'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`);
    await chmod(path.join(bin, 'gopls'), 0o755);
    process.env.PATH = bin;
    const work = path.join(root, 'work');
    await mkdir(work);
    await writeFile(path.join(work, 'go.mod'), 'module x\n');
    await writeFile(path.join(work, 'a.go'), 'def helper\n  def inner\nuse helper ERROR\nWARN here\n');
    await writeFile(path.join(work, 'b.go'), 'call helper\n');
    ctx = contextFor(work, path.join(root, 'state'), `lsp-${Math.random()}`);
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_LSP_SILENT;
    await shutdownLanguageServers();
    disposeSessionState(ctx.stateDir, ctx.sessionId);
    await rm(root, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown>) => (await lspTool.run(args, ctx));

  it('reports a file\'s diagnostics', async () => {
    const result = await run({ operation: 'diagnostics', file: 'a.go' });
    expect(result.output).toBe('a.go:3:12 error found ERROR: use helper ERROR second line [fake 1]\na.go:4:1 warning found WARN: WARN here second line [fake 2]');
  });

  it('answers definition, references, hover and symbols with 1-based positions', async () => {
    // The fake server knows only open files.
    await run({ operation: 'diagnostics', file: 'a.go' });
    expect((await run({ operation: 'definition', file: 'b.go', line: 1, character: 6 })).output).toBe('a.go:1:5  def helper');
    expect((await run({ operation: 'references', file: 'a.go', line: 3, character: 5 })).output.split('\n').sort())
      .toEqual(['a.go:1:5  def helper', 'a.go:3:5  use helper ERROR', 'b.go:1:6  call helper'].sort());
    expect((await run({ operation: 'hover', file: 'a.go', line: 1, character: 5 })).output).toBe('**helper**: thing');
    expect((await run({ operation: 'document_symbols', file: 'a.go' })).output).toBe('function helper  :1\n  method inner  :2');
    expect((await run({ operation: 'workspace_symbols', file: 'a.go', query: 'helper' })).output).toBe('function helper (mod)  a.go:1:5');
  });

  it('sends a changed file\'s new text before the next query', async () => {
    await run({ operation: 'diagnostics', file: 'a.go' });
    await writeFile(path.join(ctx.cwd, 'a.go'), 'def helper\n');
    expect((await run({ operation: 'diagnostics', file: 'a.go' })).output).toBe('No diagnostics in a.go.');
  });

  it('checks the files changed this turn when no file is named', async () => {
    expect((await run({ operation: 'diagnostics' })).output).toContain('No source files were changed this turn');
    await ctx.checkpoints.snapshot(ctx.sessionId, ctx.turnId, path.join(ctx.cwd, 'b.go'));
    await writeFile(path.join(ctx.cwd, 'b.go'), 'call helper ERROR\n');
    expect((await run({ operation: 'diagnostics' })).output).toBe('b.go:1:13 error found ERROR: call helper ERROR second line [fake 1]');
  });

  it('appends only the errors an edit introduced, once the file\'s server is running', async () => {
    const edit = async (file: string, from: string, to: string): Promise<string> => {
      await readFileTool.run({ path: file }, ctx);
      return (await editFileTool.run({ path: file, old_string: from, new_string: to }, ctx)).output;
    };
    // No server yet: the edit neither starts one nor waits.
    expect(await edit('b.go', 'call', 'call ERROR')).toBe('Edited b.go.');
    await run({ operation: 'diagnostics', file: 'b.go' });
    // The known error is not repeated by an edit elsewhere.
    expect(await edit('b.go', 'call ERROR helper\n', 'call ERROR helper\nmore\n')).toBe('Edited b.go.');
    expect(await edit('b.go', 'more', 'more ERROR')).toBe('Edited b.go.\n\ngopls reports new errors:\nb.go:2:6 error found ERROR: more ERROR second line [fake 1]');
    // A file the server had not opened shows all its errors, never warnings.
    expect(await edit('a.go', 'WARN here', 'WARN ERROR')).toBe('Edited a.go.\n\ngopls reports errors in this file:\na.go:3:12 error found ERROR: use helper ERROR second line [fake 1]\na.go:4:6 error found ERROR: WARN ERROR second line [fake 1]');
  });

  it('says what to install when no server is on PATH, and refuses unknown file types', async () => {
    await writeFile(path.join(ctx.cwd, 'x.py'), 'x = 1\n');
    await writeFile(path.join(ctx.cwd, 'notes.txt'), 'hi\n');
    expect(await run({ operation: 'hover', file: 'x.py', line: 1 })).toEqual({ output: 'No Python language server on PATH: install pyright (npm i -g pyright) or python-lsp-server (pip install python-lsp-server).', isError: true });
    expect((await run({ operation: 'hover', file: 'notes.txt', line: 1 })).output).toMatch(/^No language server is known for \.txt/);
    expect((await run({ operation: 'hover', file: 'a.go' })).output).toBe('hover needs line (1-based).');
  });

  it('returns what it has when the server does not publish in time', async () => {
    process.env.FAKE_LSP_SILENT = '1';
    const result = await run({ operation: 'diagnostics', file: 'a.go' });
    expect(result.output).toBe('[gopls is still indexing (Indexing); this is what it has so far.]');
  }, 15_000);
});

/** Real servers, when installed. Not installed here: skipped. */
const typescriptServer = await resolveBinaryPath('typescript-language-server');
const pythonServer = await resolveBinaryPath('pyright-langserver');

describe('real language servers', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await shutdownLanguageServers();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!typescriptServer)('typescript-language-server: diagnostics and definition', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'lsp-ts-')));
    dirs.push(dir);
    const typescript = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
    await mkdir(path.join(dir, 'node_modules'));
    await symlink(typescript, path.join(dir, 'node_modules', 'typescript'));
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    await writeFile(path.join(dir, 'lib.ts'), 'export function double(n: number): number {\n  return n * 2;\n}\n');
    await writeFile(path.join(dir, 'main.ts'), "import { double } from './lib';\nconst x: string = double(2);\n");
    const ctx = contextFor(dir, path.join(dir, '.state'), `lsp-ts-${Math.random()}`);
    const diagnostics = await lspTool.run({ operation: 'diagnostics', file: 'main.ts' }, ctx);
    expect(diagnostics.output).toMatch(/^main\.ts:2:7 error Type 'number' is not assignable to type 'string'\./);
    const definition = await lspTool.run({ operation: 'definition', file: 'main.ts', line: 2, character: 19 }, ctx);
    expect(definition.output).toBe('lib.ts:1:17  export function double(n: number): number {');
    const references = await lspTool.run({ operation: 'references', file: 'lib.ts', line: 1, character: 17 }, ctx);
    expect(references.output.split('\n')).toHaveLength(3);
    expect((await lspTool.run({ operation: 'document_symbols', file: 'lib.ts' }, ctx)).output).toBe('function double  :1');
    expect((await lspTool.run({ operation: 'workspace_symbols', file: 'lib.ts', query: 'double' }, ctx)).output).toContain('function double  lib.ts:1:');
    expect((await lspTool.run({ operation: 'hover', file: 'main.ts', line: 2, character: 19 }, ctx)).output).toBe('(alias) double(n: number): number\nimport double');
  }, 60_000);

  it.skipIf(!pythonServer)('pyright-langserver: diagnostics and hover', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'lsp-py-')));
    dirs.push(dir);
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    await writeFile(path.join(dir, 'm.py'), 'def double(n: int) -> int:\n    return n * 2\n\nvalue: str = double(2)\n');
    const ctx = contextFor(dir, path.join(dir, '.state'), `lsp-py-${Math.random()}`);
    const diagnostics = await lspTool.run({ operation: 'diagnostics', file: 'm.py' }, ctx);
    expect(diagnostics.output).toMatch(/^m\.py:4:14 error .*"int".*"str"/);
    const hover = await lspTool.run({ operation: 'hover', file: 'm.py', line: 4, character: 14 }, ctx);
    expect(hover.output).toContain('def double(n: int) -> int');
  }, 60_000);

});
