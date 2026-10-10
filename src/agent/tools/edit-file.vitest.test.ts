import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from '../file-checkpoints.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';
import { editFileTool } from './edit-file.js';
import { multiEditTool } from './multi-edit.js';
import { writeFileTool } from './write-file.js';

describe('edit_file and multi_edit', () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'edit-file-')));
    const stateDir = path.join(root, 'state');
    ctx = {
      cwd: root, addDirs: [], sessionId: `edit-${Math.random()}`, turnId: 'turn-1', stateDir, homeDir: stateDir,
      checkpoints: new FileCheckpointStore(stateDir),
    } as ToolContext;
    ctx = { ...ctx, session: sessionState(stateDir, ctx.sessionId) } as ToolContext;
    await writeFile(path.join(root, 'a.ts'), 'import { calcTotal } from "./x";\nexport const t = calcTotal(1) + calcTotal(2);\n');
  });
  afterEach(async () => {
    disposeSessionState(ctx.stateDir, ctx.sessionId);
    await rm(root, { recursive: true, force: true });
  });

  // An exact unique match is the guard: the text seen in a grep line is
  // enough, which saves the model a read step per file in a multi-file change.
  it('edits a file never read, from the exact text alone', async () => {
    const result = await editFileTool.run({ path: 'a.ts', old_string: 'calcTotal', new_string: 'total', replace_all: true }, ctx);
    expect(result.output).toBe('Edited a.ts.');
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('import { total } from "./x";\nexport const t = total(1) + total(2);\n');
    await multiEditTool.run({ path: 'a.ts', edits: [{ old_string: '"./x"', new_string: '"./y"' }, { old_string: 'total(2)', new_string: 'total(3)' }] }, ctx);
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toContain('from "./y"');
  });

  it('still refuses text that is not there or not unique, changing nothing', async () => {
    await expect(editFileTool.run({ path: 'a.ts', old_string: 'calcTotal(', new_string: 'total(' }, ctx)).rejects.toThrow(/matches 2 places/);
    await expect(editFileTool.run({ path: 'a.ts', old_string: 'nowhere', new_string: 'x' }, ctx)).rejects.toThrow(/not found/);
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toContain('calcTotal(1)');
  });

  it('write_file still needs a read before replacing an existing file', async () => {
    expect(await writeFileTool.run({ path: 'a.ts', content: 'x\n' }, ctx)).toMatchObject({ isError: true });
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toContain('calcTotal');
  });
});
