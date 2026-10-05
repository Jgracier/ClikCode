import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGatewayHarnessTurn } from '../run-turn.js';
import { disposeSessionState } from '../session-state.js';
import { ScriptedModelClient } from '../testing.js';
import { gateNotebookTool, NOTEBOOK_TOOL, resetNotebookScans, workspaceHasNotebooks } from './notebook-gate.js';

let root: string;
let cwd: string;
let stateDir: string;

beforeEach(async () => {
  resetNotebookScans();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-gate-')));
  cwd = path.join(root, 'repo');
  stateDir = path.join(root, 'state');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(cwd, 'src', 'a.py'), 'print(1)\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOTEBOOK = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['x = 1'], outputs: [], execution_count: null }] });
const tools = [{ name: 'read_file' }, { name: NOTEBOOK_TOOL }];

describe('the notebook_edit gate', () => {
  it('finds a nested notebook, but not one under node_modules or a dot directory', async () => {
    await fs.mkdir(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'node_modules', 'pkg', 'demo.ipynb'), NOTEBOOK);
    await fs.mkdir(path.join(cwd, '.ipynb_checkpoints'));
    await fs.writeFile(path.join(cwd, '.ipynb_checkpoints', 'x.ipynb'), NOTEBOOK);
    expect(await workspaceHasNotebooks([cwd])).toBe(false);
    resetNotebookScans();
    await fs.mkdir(path.join(cwd, 'analysis', 'deep'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'analysis', 'deep', 'Explore.IPYNB'), NOTEBOOK);
    expect(await workspaceHasNotebooks([cwd])).toBe(true);
  });

  it('caches per directory identity and rescans when the top level changes', async () => {
    expect(await workspaceHasNotebooks([cwd])).toBe(false);
    // A nested change leaves the cached answer standing (the conversation
    // check covers notebooks made during the session)...
    await fs.writeFile(path.join(cwd, 'src', 'nested.ipynb'), NOTEBOOK);
    expect(await workspaceHasNotebooks([cwd])).toBe(false);
    // ...a change to the directory's own listing is a new identity.
    await fs.writeFile(path.join(cwd, 'top.ipynb'), NOTEBOOK);
    expect(await workspaceHasNotebooks([cwd])).toBe(true);
  });

  it('offers the tool when the conversation mentions a notebook', () => {
    expect(gateNotebookTool(tools, [], false).map((tool) => tool.name)).toEqual(['read_file']);
    expect(gateNotebookTool(tools, [], true).map((tool) => tool.name)).toEqual(['read_file', NOTEBOOK_TOOL]);
    const made = [{ type: 'tool_call' as const, id: '1', name: 'write_file', args: { path: 'new.ipynb', content: NOTEBOOK } }];
    expect(gateNotebookTool(tools, made, false).map((tool) => tool.name)).toEqual(['read_file', NOTEBOOK_TOOL]);
  });

  it('leaves notebook_edit out of a turn in a workspace without notebooks, and offers it once one is written', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'write_file', args: { path: 'made.ipynb', content: NOTEBOOK } }] },
      { toolCalls: [{ name: NOTEBOOK_TOOL, args: { path: 'made.ipynb', cell_id: 'c1', new_source: 'x = 2' } }] },
      { text: 'Done.' },
    ]);
    try {
      const result = await runGatewayHarnessTurn({
        sessionId: 'gate', cwd, stateDir, homeDir: path.join(root, 'home'), userConfigDir: path.join(root, 'config'),
        permissionMode: 'bypass', modelClient: client, prompt: 'Make a notebook.',
      });
      expect(result.stopReason).toBe('completed');
    } finally {
      disposeSessionState(stateDir, 'gate');
    }
    const offered = client.requests.map((request) => request.tools.some((tool) => tool.name === NOTEBOOK_TOOL));
    expect(offered).toEqual([false, true, true]);
    expect(JSON.parse(await fs.readFile(path.join(cwd, 'made.ipynb'), 'utf8')).cells[0].source).toEqual(['x = 2']);
  });
});
