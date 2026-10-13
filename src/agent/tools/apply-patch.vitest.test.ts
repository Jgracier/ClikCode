import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from '../file-checkpoints.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';
import { applyPatchTool } from './apply-patch.js';
import { defaultTools } from './registry.js';

const patch = (...sections: string[]): string => `*** Begin Patch\n${sections.join('\n')}\n*** End Patch`;

describe('apply_patch', () => {
  let root: string;
  let ctx: ToolContext;
  const read = (file: string): Promise<string> => readFile(path.join(root, file), 'utf8');
  const exists = (file: string): Promise<boolean> => stat(path.join(root, file)).then(() => true, () => false);

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'apply-patch-')));
    const stateDir = path.join(root, '.state');
    await mkdir(stateDir);
    ctx = {
      cwd: root, addDirs: [], sessionId: `patch-${Math.random()}`, turnId: 'turn-1', stateDir, homeDir: stateDir,
      checkpoints: new FileCheckpointStore(stateDir),
    } as ToolContext;
    ctx = { ...ctx, session: sessionState(stateDir, ctx.sessionId) } as ToolContext;
    await writeFile(path.join(root, 'a.ts'), 'const a = 1;\nfunction f() {\n  return a;\n}\nconst z = 9;\n');
    await writeFile(path.join(root, 'old.txt'), 'bye\n');
  });
  afterEach(async () => {
    disposeSessionState(ctx.stateDir, ctx.sessionId);
    await rm(root, { recursive: true, force: true });
  });

  it('is offered to the model beside edit_file', () => {
    expect(defaultTools().map((tool) => tool.name)).toContain('apply_patch');
    expect(applyPatchTool.class).toBe('write');
  });

  it('adds, updates, moves and deletes in one patch, and reports a diff', async () => {
    const result = await applyPatchTool.run({
      patch: patch(
        '*** Add File: sub/new.txt', '+hello', '+world',
        '*** Update File: a.ts', '@@ function f() {', '-  return a;', '+  return a + 1;', ' }',
        '*** Delete File: old.txt',
      ),
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(await read('sub/new.txt')).toBe('hello\nworld\n');
    expect(await read('a.ts')).toBe('const a = 1;\nfunction f() {\n  return a + 1;\n}\nconst z = 9;\n');
    expect(await exists('old.txt')).toBe(false);
    expect(result.diff?.length).toBeGreaterThan(0);
    await applyPatchTool.run({ patch: patch('*** Update File: sub/new.txt', '*** Move to: moved.txt', '@@', ' hello', '-world', '+there') }, ctx);
    expect(await exists('sub/new.txt')).toBe(false);
    expect(await read('moved.txt')).toBe('hello\nthere\n');
  });

  it('changes nothing when any part does not apply', async () => {
    await expect(applyPatchTool.run({
      patch: patch('*** Add File: made.txt', '+x', '*** Update File: a.ts', '@@', '-no such line', '+y'),
    }, ctx)).rejects.toThrow(/not found/);
    expect(await exists('made.txt')).toBe(false);
    expect(await read('a.ts')).toContain('const a = 1;');
  });

  it('refuses a malformed patch, an existing file to add, and a path outside the workspace', async () => {
    await expect(applyPatchTool.run({ patch: '*** Update File: a.ts' }, ctx)).rejects.toThrow(/Begin Patch/);
    await expect(applyPatchTool.run({ patch: patch('*** Add File: a.ts', '+x') }, ctx)).rejects.toThrow(/already exists/);
    await expect(applyPatchTool.run({ patch: patch('*** Delete File: ../outside.txt') }, ctx)).rejects.toThrow(/Refused|outside|not/i);
  });

  it('goes through the snapshots /undo restores from, and lists its paths for approval', async () => {
    expect(applyPatchTool.paths!({ patch: patch('*** Delete File: old.txt', '*** Add File: n.txt', '+1') } as never)).toEqual(['old.txt', 'n.txt']);
    await applyPatchTool.run({ patch: patch('*** Delete File: old.txt', '*** Add File: n.txt', '+1', '*** Update File: a.ts', '@@', '-const a = 1;', '+const a = 2;') }, ctx);
    await ctx.checkpoints.seal(ctx.sessionId, 'turn-1');
    const undone = await ctx.checkpoints.undoTurn(ctx.sessionId, { roots: [root] });
    expect(undone.failed).toEqual([]);
    expect(await read('old.txt')).toBe('bye\n');
    expect(await exists('n.txt')).toBe(false);
    expect(await read('a.ts')).toContain('const a = 1;');
  });

  it('keeps a CRLF file CRLF', async () => {
    await writeFile(path.join(root, 'w.txt'), 'one\r\ntwo\r\n');
    await applyPatchTool.run({ patch: patch('*** Update File: w.txt', '@@', ' one', '-two', '+2') }, ctx);
    expect(await read('w.txt')).toBe('one\r\n2\r\n');
  });
});
