import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool } from './tools/bash.js';
import { FileCheckpointStore } from './file-checkpoints.js';
import { disposeSessionState, sessionState } from './session-state.js';
import type { ToolContext } from './tool-contract.js';

describe.skipIf(process.platform === 'win32')('bash changes are undoable', () => {
  let base: string;
  let repo: string;
  let store: FileCheckpointStore;
  let ctx: ToolContext;
  const sessionId = `shell-changes-${process.pid}-${Math.random().toString(36).slice(2)}`;

  const sh = (command: string, cwd = repo): string => execFileSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' });
  const read = (name: string, dir = repo): Promise<string> => fs.readFile(path.join(dir, name), 'utf8');
  const run = (command: string) => bashTool.run({ command }, ctx);
  const undo = async () => {
    await store.seal(sessionId, 't1');
    return store.undoTurn(sessionId, { roots: [ctx.cwd] });
  };

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-shell-changes-')));
    repo = path.join(base, 'repo');
    await fs.mkdir(repo);
    sh('git init -q && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false');
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(repo, name), `export const oldName = '${name}';\n`);
    await fs.writeFile(path.join(repo, 'gone.txt'), 'delete me\n');
    sh('git add -A && git commit -qm init');
    store = new FileCheckpointStore(path.join(base, 'state'));
    ctx = {
      cwd: repo, addDirs: [], sessionId, turnId: 't1', stateDir: path.join(base, 'state'), homeDir: base,
      checkpoints: store, session: sessionState(path.join(base, 'state'), sessionId),
    } as ToolContext;
  });
  afterEach(async () => {
    disposeSessionState(path.join(base, 'state'), sessionId, 'test over');
    await fs.rm(base, { recursive: true, force: true });
  });

  it('a sed -i across three files is shown and undone', async () => {
    const result = await run('sed -i s/oldName/newName/ a.ts b.ts c.ts');
    expect(result.output).toContain('[changed 3 files: a.ts, b.ts, c.ts]');
    expect(result.diff?.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result.diff?.[0]?.lines.some((line) => line.kind === 'added' && line.text.includes('newName'))).toBe(true);
    expect(await read('b.ts')).toContain('newName');
    const undone = await undo();
    expect(undone.failed).toEqual([]);
    expect(undone.restored.sort()).toEqual(['a.ts', 'b.ts', 'c.ts'].map((name) => path.join(repo, name)));
    for (const name of ['a.ts', 'b.ts', 'c.ts']) expect(await read(name)).toBe(`export const oldName = '${name}';\n`);
  });

  it('works the same with the command sandboxed', async () => {
    ctx = { ...ctx, sandbox: 'workspace' };
    const result = await run('sed -i s/oldName/newName/ a.ts b.ts');
    expect(result.output).toContain('[changed 2 files: a.ts, b.ts]');
    expect((await undo()).failed).toEqual([]);
    expect(await read('a.ts')).toBe("export const oldName = 'a.ts';\n");
  });

  it('a command that creates and deletes files is undone both ways', async () => {
    const result = await run('mkdir -p sub && echo hi > sub/new.txt && rm gone.txt');
    expect(result.output).toMatch(/\[changed 2 files: -gone\.txt, \+sub\/new\.txt\]/);
    const undone = await undo();
    expect(undone.failed).toEqual([]);
    expect(await read('gone.txt')).toBe('delete me\n');
    await expect(fs.stat(path.join(repo, 'sub/new.txt'))).rejects.toThrow();
  });

  it('a file already dirty goes back to its dirty content, not HEAD', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'uncommitted work\n');
    await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
    const result = await run('echo more >> a.ts && echo also >> scratch.txt');
    expect(result.output).toContain('[changed 2 files: a.ts, scratch.txt]');
    const undone = await undo();
    expect(undone.failed).toEqual([]);
    expect(await read('a.ts')).toBe('uncommitted work\n');
    expect(await read('scratch.txt')).toBe('untracked\n');
  });

  it('keeps a file tool edit made earlier in the turn as the pre-image', async () => {
    await store.snapshot(sessionId, 't1', path.join(repo, 'a.ts'));
    await fs.writeFile(path.join(repo, 'a.ts'), 'edited by edit_file\n');
    await run('echo shell >> a.ts');
    await undo();
    expect(await read('a.ts')).toBe("export const oldName = 'a.ts';\n");
  });

  it('a command that changes nothing adds no line and no checkpoint', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'dirty\n');
    const result = await run('cat a.ts');
    expect(result.output).toBe('dirty');
    expect(result.diff).toBeUndefined();
    expect(await store.listTurns(sessionId)).toEqual([]);
  });

  it('records at most the cap and says the rest are not undoable', async () => {
    const result = await run('for i in $(seq 1 205); do echo $i > f$i.txt; done');
    expect(result.output).toMatch(/\[changed 205 files: .*… 197 more; 5 of them not recorded for \/redo/);
    expect(result.diff?.length).toBe(10);
    const [turn] = await store.listTurns(sessionId);
    expect(turn?.files.length).toBe(200);
  });

  it('a directory that is not a git repository is skipped cleanly', async () => {
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain);
    await fs.writeFile(path.join(plain, 'x.txt'), 'x\n');
    ctx = { ...ctx, cwd: plain };
    const result = await run('sed -i s/x/y/ x.txt && echo done');
    expect(result.output).toBe('done');
    expect(result.diff).toBeUndefined();
    expect(await read('x.txt', plain)).toBe('y\n');
    expect(await store.listTurns(sessionId)).toEqual([]);
  });

  it('a file unhidden by a .gitignore edit is not taken as created', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), 'build/\n');
    await fs.mkdir(path.join(repo, 'build'));
    await fs.writeFile(path.join(repo, 'build/out.js'), 'built\n');
    sh('git add .gitignore && git commit -qm ignore');
    // ctime must be clearly before the command starts.
    await fs.utimes(path.join(repo, 'build/out.js'), new Date(0), new Date(0));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await run(': > .gitignore');
    expect(result.output).toContain('[changed 1 file: .gitignore]');
    await undo();
    expect(await read('build/out.js')).toBe('built\n');
  });
});
