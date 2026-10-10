import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { FileCheckpointStore } from './file-checkpoints.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { SUBAGENT_MAX_STEPS } from './subagent.js';
import { ScriptedModelClient, type ScriptEntry } from './testing.js';
import type { GatewayHarnessTurnInput, ModelClient, ModelStepRequest, ModelStepResult } from './model-client.js';

let root: string;
let cwd: string;
let stateDir: string;
let sessionCounter = 0;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-subagent-')));
  cwd = path.join(root, 'work');
  stateDir = path.join(root, 'state');
  await Promise.all([cwd, stateDir, path.join(root, 'home')].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'the answer is 42\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const PARENT_PROMPT = 'do the thing';

/** One model client, as in production, but each conversation follows its own
 * script, chosen by its opening prompt. Parallel sub-agents interleave their
 * steps, so one shared script could not say which step belongs to whom. */
class RoutedModelClient implements ModelClient {
  readonly clients = new Map<string, ScriptedModelClient>();

  constructor(routes: Record<string, { script: ScriptEntry[]; fallback?: ScriptEntry }>) {
    for (const [prompt, route] of Object.entries(routes)) this.clients.set(prompt, new ScriptedModelClient(route.script, route.fallback));
  }

  step(request: ModelStepRequest): Promise<ModelStepResult> {
    const first = request.items.find((item) => item.type === 'text' && item.role === 'user');
    // The parent's first message also carries the <environment> note.
    const prompt = first?.type === 'text' ? first.text.replace(/^<environment>[\s\S]*?<\/environment>\n\n/, '') : '';
    const client = this.clients.get(prompt);
    if (!client) throw new Error(`No script for prompt: ${prompt}`);
    return client.step(request);
  }

  requests(prompt: string): ModelStepRequest[] {
    return this.clients.get(prompt)!.requests;
  }
}

function turn(client: ModelClient, overrides: Partial<GatewayHarnessTurnInput> = {}): { input: GatewayHarnessTurnInput; events: HarnessActivityEvent[] } {
  const events: HarnessActivityEvent[] = [];
  return {
    events,
    input: {
      sessionId: `p${++sessionCounter}`, cwd, stateDir, homeDir: path.join(root, 'home'), userConfigDir: path.join(root, 'config'),
      prompt: PARENT_PROMPT, permissionMode: 'bypass', modelClient: client,
      onActivity: (event) => events.push(event),
      ...overrides,
    },
  };
}

function toolResults(request: ModelStepRequest): string[] {
  return request.items.flatMap((item) => item.type === 'tool_result' ? [item.output] : []);
}

function withoutTrace(output: string): string {
  return output.replace(/\n\n\[Sub-agent tool trace: [^\]]+\]$/, '');
}

function traceFile(output: string): string {
  const match = /\[Sub-agent tool trace: ([^\]]+)\]$/.exec(output);
  if (!match) throw new Error('Missing sub-agent trace');
  return match[1];
}

describe('task sub-agents', () => {
  it('runs a coding agent through local tools, one approval, and the parent undo checkpoint', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 'work-1', name: 'agent', args: { prompt: 'Change the answer in a.txt to 43', description: 'Update answer' } }] },
        { text: 'The answer is now 43.' },
      ] },
      'Change the answer in a.txt to 43': { script: [
        { toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'a.txt' } }] },
        { toolCalls: [{ id: 'edit-1', name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '43' } }] },
        { text: 'Updated a.txt and checked its content.' },
      ] },
    });
    const approvals: Array<{ title: string; preview?: unknown }> = [];
    const { input, events } = turn(client, { permissionMode: 'ask', onApproval: async (title, _detail, _rule, preview) => {
      approvals.push({ title, preview });
      return true;
    } });
    const result = await runGatewayHarnessTurn(input);
    expect(result.stopReason).toBe('completed');
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 43\n');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].title).toMatch(/edit/i);
    expect(approvals[0].preview).toBeDefined();
    expect(events.find((event) => event.id === 'work-1')).toMatchObject({ agent: true });
    expect(events.filter((event) => event.parentId === 'work-1').map((event) => event.id)).toContain('work-1/edit-1');
    const child = client.requests('Change the answer in a.txt to 43')[0];
    expect(child.tools.map((tool) => tool.name)).toContain('bash');
    expect(child.tools.map((tool) => tool.name)).not.toContain('agent');
    expect(toolResults(client.requests(PARENT_PROMPT)[1])[0]).toContain('Updated a.txt');
    const checkpoints = new FileCheckpointStore(stateDir);
    expect((await checkpoints.listTurns(input.sessionId)).map((entry) => entry.files)).toEqual([[path.join(cwd, 'a.txt')]]);
    const undo = await checkpoints.undoTurn(input.sessionId, { roots: [cwd] });
    expect(undo.failed).toEqual([]);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
  });

  it('keeps an interrupted coding agent\'s edit and undo checkpoint', async () => {
    const controller = new AbortController();
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ id: 'work-abort', name: 'agent', args: { prompt: 'Edit then stop' } }] }] },
      'Edit then stop': { script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '43' } }] },
        { before: () => controller.abort(), text: 'not completed' },
      ] },
    });
    const { input } = turn(client, { signal: controller.signal });
    await expect(runGatewayHarnessTurn(input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 43\n');
    const checkpoints = new FileCheckpointStore(stateDir);
    expect(await checkpoints.listTurns(input.sessionId)).toHaveLength(1);
    expect((await checkpoints.undoTurn(input.sessionId, { roots: [cwd] })).failed).toEqual([]);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
  });

  it('keeps a coding agent\'s background shell available to the parent', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ name: 'agent', args: { prompt: 'Start a background process' } }] },
        { toolCalls: [{ name: 'kill_bash', args: { id: 'bash_1' } }] },
        { text: 'Stopped the process.' },
      ] },
      'Start a background process': { script: [
        { toolCalls: [{ name: 'bash', args: { command: 'node -e "setTimeout(function(){},3000)"', run_in_background: true } }] },
        { text: 'Started bash_1.' },
      ] },
    });
    const result = await runGatewayHarnessTurn(turn(client).input);
    expect(result.stopReason).toBe('completed');
    expect(toolResults(client.requests(PARENT_PROMPT)[2])).toContain('Stopped bash_1.');
  });

  it('runs a read-only sub-agent in its own durable conversation', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 't1', name: 'task', args: { prompt: 'What does a.txt say?', description: 'Read a.txt' } }] },
        { text: 'It says 42.' },
      ] },
      'What does a.txt say?': { script: [
        { text: 'Looking at the file.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
        { text: 'a.txt:1 says the answer is 42.' },
      ] },
    });
    const { input, events } = turn(client);
    const result = await runGatewayHarnessTurn(input);

    expect(result).toMatchObject({ text: 'It says 42.', stopReason: 'completed' });
    // The answer, without the narration that preceded the read.
    const [taskOutput] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(withoutTrace(taskOutput)).toBe('a.txt:1 says the answer is 42.');
    const records = (await fs.readFile(traceFile(taskOutput), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.item?.type)).toContain('tool_call');
    expect(records.map((record) => record.item?.type)).toContain('tool_result');
    expect(records.some((record) => record.item?.output?.includes('the answer is 42'))).toBe(true);

    const child = client.requests('What does a.txt say?');
    expect(child[0].tools.map((tool) => tool.name).sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file', 'web_fetch', 'web_search']);
    expect(child[0].system).toMatch(/^You are a sub-agent/);
    expect(child[0].system.length).toBeLessThan(1000);
    // A fresh conversation: nothing of the parent's leaks in.
    expect(child[0].items).toEqual([{ type: 'text', role: 'user', text: 'What does a.txt say?' }]);
    expect(toolResults(child[1])[0]).toMatch(/the answer is 42/);

    const taskRow = events.filter((event) => event.id === 't1');
    expect(taskRow.map((event) => event.kind)).toEqual(['tool-start', 'tool-done']);
    expect(taskRow[0]).toMatchObject({ label: 'Agent Read a.txt', agent: true });
    const nested = events.filter((event) => event.parentId === 't1');
    expect(nested.map((event) => [event.kind, event.id])).toEqual([['tool-start', 't1/c1'], ['tool-done', 't1/c1']]);

    // The child trace belongs to the parent's session, not a loose session.
    expect(await fs.readdir(path.join(stateDir, 'sessions'))).toEqual([input.sessionId]);
  });

  it('runs several task calls of one step in parallel', async () => {
    let active = 0;
    let peak = 0;
    const slowAnswer = (answer: string): ScriptEntry => ({
      text: answer,
      before: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
      },
    });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: ['one', 'two', 'three'].map((name) => ({ id: name, name: 'task', args: { prompt: `question ${name}` } })) },
        { text: 'done' },
      ] },
      'question one': { script: [slowAnswer('answer one')] },
      'question two': { script: [slowAnswer('answer two')] },
      'question three': { script: [slowAnswer('answer three')] },
    });
    await runGatewayHarnessTurn(turn(client).input);
    expect(peak).toBe(3);
    expect(toolResults(client.requests(PARENT_PROMPT)[1]).map(withoutTrace)).toEqual(['answer one', 'answer two', 'answer three']);
  });

  it('cannot start a sub-agent of its own', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'go deeper' } }] }, { text: 'done' }] },
      'go deeper': { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'deeper still' } }] }, { text: 'I did it myself.' }] },
    });
    await runGatewayHarnessTurn(turn(client).input);
    const child = client.requests('go deeper');
    expect(child[0].tools.map((tool) => tool.name)).not.toContain('task');
    expect(toolResults(child[1])[0]).toMatch(/Unknown tool "task"/);
    expect(client.clients.has('deeper still') && client.requests('deeper still').length).toBeFalsy();
    expect(toolResults(client.requests(PARENT_PROMPT)[1]).map(withoutTrace)).toEqual(['I did it myself.']);
  });

  it('stops with the parent when the turn is aborted mid-task', async () => {
    const controller = new AbortController();
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'long job' } }] }] },
      'long job': { script: [
        { toolCalls: [{ name: 'list_dir', args: {} }] },
        { before: () => controller.abort(), text: 'never seen' },
      ] },
    });
    const { input } = turn(client, { signal: controller.signal });
    await expect(runGatewayHarnessTurn(input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(client.requests('long job')).toHaveLength(2);
    const files = await fs.readdir(path.join(stateDir, 'sessions', input.sessionId, 'tool-output'));
    expect(files).toHaveLength(1);
    const trace = await fs.readFile(path.join(stateDir, 'sessions', input.sessionId, 'tool-output', files[0]), 'utf8');
    expect(trace).toContain('"name":"list_dir"');
    expect(trace).toContain('"type":"tool_result"');
  });

  it("adds the sub-agent's usage to the parent's, as it is spent", async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ name: 'task', args: { prompt: 'count' } }], usage: { input: 100, output: 10, costMicroUsd: 7 } },
        { text: 'done', usage: { input: 100, output: 10, costMicroUsd: 7 } },
      ] },
      count: { script: [
        { toolCalls: [{ name: 'list_dir', args: {} }], usage: { input: 50, output: 5, costMicroUsd: 3 } },
        { text: 'counted', usage: { input: 60, output: 6, costMicroUsd: 3 } },
      ] },
    });
    const reports: { input?: number; output?: number; costMicroUsd?: number; contextTokens?: number }[] = [];
    const result = await runGatewayHarnessTurn(turn(client, { onUsage: (report) => reports.push(report) }).input);
    expect(result.usage).toEqual({ input: 310, output: 31, costMicroUsd: 20 });
    expect(reports.map((report) => report.input)).toEqual([100, 150, 210, 310]);
    // Rolled-up reports keep describing the parent's context, not the sub-agent's.
    expect(reports[1].contextTokens).toBe(reports[0].contextTokens);
  });

  it('stops at its step cap and says the answer is partial', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'endless' } }] }, { text: 'done' }] },
      endless: { script: [{ text: 'Found part of it.', toolCalls: [{ name: 'list_dir', args: {} }] }], fallback: { toolCalls: [{ name: 'list_dir', args: {} }] } },
    });
    const result = await runGatewayHarnessTurn(turn(client).input);
    expect(result.stopReason).toBe('completed');
    expect(client.requests('endless')).toHaveLength(SUBAGENT_MAX_STEPS);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).toMatch(/^Found part of it\./);
    expect(output).toMatch(new RegExp(`${SUBAGENT_MAX_STEPS}-step limit`));
    expect(output).not.toMatch(/Send another message/);
  });

  it("puts a sub-agent's approvals through the parent's approver", async () => {
    const outside = path.join(root, 'home', 'secret.txt');
    await fs.writeFile(outside, 'x');
    const asked: string[] = [];
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'peek' } }] }, { text: 'done' }] },
      peek: { script: [{ toolCalls: [{ name: 'read_file', args: { path: outside } }] }, { text: 'was refused' }] },
    });
    await runGatewayHarnessTurn(turn(client, { permissionMode: 'ask', onApproval: async (title) => { asked.push(title); return false; } }).input);
    expect(asked).toHaveLength(1);
    expect(toolResults(client.requests('peek')[1])[0]).toMatch(/declined/);
    expect(toolResults(client.requests(PARENT_PROMPT)[1]).map(withoutTrace)).toEqual(['was refused']);
  });
});

describe('coding sub-agents in their own worktree', () => {
  const execFileAsync = promisify(execFile);
  const git = async (...args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd })).stdout.trim();
  let savedTmp: string | undefined;

  beforeEach(async () => {
    // The worktrees are made under the temp dir: this test's own, removed with it.
    savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, 'tmp');
    await fs.mkdir(process.env.TMPDIR);
  });

  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });

  async function initRepo(): Promise<void> {
    await git('init', '-q', '-b', 'main');
    await git('add', '-A');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base');
  }

  function branchOf(output: string): string {
    const match = /on branch (clikcode\/\S+) \(from/.exec(output);
    if (!match) throw new Error(`No branch in: ${output}`);
    return match[1];
  }

  it('runs several isolated agents of one step in parallel, each on its own branch', async () => {
    await initRepo();
    let active = 0;
    let peak = 0;
    const slowEdit = (to: string): ScriptEntry => ({
      toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: to } }],
      before: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
      },
    });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [
          { id: 'w1', name: 'agent', args: { prompt: 'make it 43', description: 'Make 43', isolation: 'worktree' } },
          { id: 'w2', name: 'agent', args: { prompt: 'make it 44', description: 'Make 44', isolation: 'worktree' } },
        ] },
        { text: 'done' },
      ] },
      'make it 43': { script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, slowEdit('43'), { text: 'Changed to 43.' }] },
      'make it 44': { script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, slowEdit('44'), { text: 'Changed to 44.' }] },
    });
    const { input } = turn(client);
    expect((await runGatewayHarnessTurn(input)).stopReason).toBe('completed');
    expect(peak).toBe(2);

    const [first, second] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(first).toMatch(/^Changed to 43\./);
    expect(second).toMatch(/^Changed to 44\./);
    expect(first).toMatch(/a\.txt \| 2 \+-/);
    // The user's tree is untouched; each branch holds its own agent's edit.
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
    expect(await git('show', `${branchOf(first)}:a.txt`)).toBe('the answer is 43');
    expect(await git('show', `${branchOf(second)}:a.txt`)).toBe('the answer is 44');
    // Not in the parent's undo: the branch is the record.
    expect(await new FileCheckpointStore(stateDir).listTurns(input.sessionId)).toEqual([]);
    // The checkouts are gone; only the branches remain.
    expect((await git('worktree', 'list')).split('\n')).toHaveLength(1);
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
    // The child was told where it works.
    expect(client.requests('make it 43')[0].system).toContain(`on branch ${branchOf(first)}`);
  });

  it('removes the worktree and branch of an agent that changed nothing', async () => {
    await initRepo();
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'look only', isolation: 'worktree' } }] }, { text: 'done' }] },
      'look only': { script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'Nothing to change.' }] },
    });
    await runGatewayHarnessTurn(turn(client).input);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).toMatch(/no changes were made; its worktree and branch were removed/);
    expect(await git('branch', '--list', 'clikcode/*')).toBe('');
    expect((await git('worktree', 'list')).split('\n')).toHaveLength(1);
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
  });

  it('commits a cancelled isolated agent\'s edit to its branch', async () => {
    await initRepo();
    const controller = new AbortController();
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'edit then stop', isolation: 'worktree' } }] }] },
      'edit then stop': { script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '45' } }] },
        { before: () => controller.abort(), text: 'not completed' },
      ] },
    });
    await expect(runGatewayHarnessTurn(turn(client, { signal: controller.signal }).input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    // The cancelled turn returns at once; the sub-agent winds down after it.
    await vi.waitFor(async () => expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]));
    const branch = await git('branch', '--list', '--format=%(refname:short)', 'clikcode/*');
    expect(await git('show', `${branch}:a.txt`)).toBe('the answer is 45');
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
  });

  it('refuses isolation outside a git repository, in one line', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'never runs', isolation: 'worktree' } }] }, { text: 'done' }] },
      'never runs': { script: [{ text: 'ran' }] },
    });
    await runGatewayHarnessTurn(turn(client).input);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).toMatch(/needs a git repository/);
    expect(output.split('\n')).toHaveLength(1);
    expect(client.requests('never runs')).toHaveLength(0);
  });
});
