import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { defaultTools } from './tools/registry.js';
import { defineTool } from './tool-contract.js';
import { FileCheckpointStore } from './file-checkpoints.js';
import { runAgentLoop } from './run-turn.js';
import { sessionAgents } from './background-agents.js';
import { readAgentRecords } from './agent-registry.js';
import { formatShellNotifications, sessionState } from './session-state.js';
import { ScriptedModelClient, type ScriptEntry } from './testing.js';
import type { AgentTurnInput, ModelClient, ModelStepRequest, ModelStepResult } from './model-client.js';

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

function turn(client: ModelClient, overrides: Partial<AgentTurnInput> = {}): { input: AgentTurnInput; events: HarnessActivityEvent[] } {
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
    const result = await runAgentLoop(input);
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

  it('hands a steer typed during a foreground sub-agent to that sub-agent, and the main agent still hears it afterward', async () => {
    let steer: ((text: string) => Promise<boolean>) | undefined;
    let landed: Promise<boolean> | undefined;
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 'fg-1', name: 'agent', args: { prompt: 'Work for a moment' } }] },
        { text: 'Heard it.' },
      ] },
      'Work for a moment': { script: [
        // The sub-agent's first step runs while the user types: its call is open.
        { before: () => { landed = steer!('use tabs'); }, toolCalls: [{ id: 'k-1', name: 'read_file', args: { path: 'a.txt' } }] },
        { text: 'Done.' },
      ] },
    });
    const { input } = turn(client, { onSteerReady: (port) => { if (port) steer = (text) => port.offer(text, { id: 't', text, submittedAt: '' }); } });
    await runAgentLoop(input);
    await landed;
    // The sub-agent saw it, before its next step...
    const childSaw = client.requests('Work for a moment').flatMap((request) => request.items).some((item) => item.type === 'text' && item.role === 'user' && item.text.includes('use tabs'));
    expect(childSaw).toBe(true);
    // ...and the main agent was told after the call returned.
    const parentSaw = client.requests(PARENT_PROMPT).at(-1)!.items.some((item) => item.type === 'text' && item.role === 'user' && item.text.includes('use tabs'));
    expect(parentSaw).toBe(true);
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
    await expect(runAgentLoop(input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
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
    const result = await runAgentLoop(turn(client).input);
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
    const result = await runAgentLoop(input);

    expect(result).toMatchObject({ text: 'It says 42.', stopReason: 'completed' });
    // The answer, without the narration that preceded the read.
    const [taskOutput] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(withoutTrace(taskOutput)).toBe('a.txt:1 says the answer is 42.');
    const records = (await fs.readFile(traceFile(taskOutput), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.item?.type)).toContain('tool_call');
    expect(records.map((record) => record.item?.type)).toContain('tool_result');
    expect(records.some((record) => record.item?.output?.includes('the answer is 42'))).toBe(true);

    const child = client.requests('What does a.txt say?');
    expect(child[0].tools.map((tool) => tool.name).sort()).toEqual(['glob', 'grep', 'list_dir', 'load_tools', 'read_context', 'read_file']);
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

  it('runs a sub-agent to its answer when the conversation leaves this route mid-task; the parent stops at its next step', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 't1', name: 'task', args: { prompt: 'What does a.txt say?', description: 'Read a.txt' } }] },
        { text: 'It says 42.' },
      ] },
      'What does a.txt say?': { script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
        { toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'a.txt' } }] },
        { text: 'a.txt:1 says the answer is 42.' },
      ] },
    });
    // Checked before each model step. The parent's first step goes through;
    // from then on the conversation has left this route.
    let checks = 0;
    const { input, events } = turn(client, { modelClientForStep: async () => (++checks >= 2 ? 'switch' as const : undefined) });
    const result = await runAgentLoop(input);

    expect(result.stopReason).toBe('account-switch');
    // The sub-agent was not cut off: both its reads ran and it gave its answer.
    expect(events.filter((event) => event.parentId === 't1' && event.kind === 'tool-done')).toHaveLength(2);
    expect(client.requests('What does a.txt say?')).toHaveLength(3);
    expect(events.find((event) => event.id === 't1' && event.kind === 'tool-done')).toBeDefined();
    // The parent made no further model call after the switch.
    expect(client.requests(PARENT_PROMPT)).toHaveLength(1);
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
    await runAgentLoop(turn(client).input);
    expect(peak).toBe(3);
    expect(toolResults(client.requests(PARENT_PROMPT)[1]).map(withoutTrace)).toEqual(['answer one', 'answer two', 'answer three']);
  });

  it('cannot start a sub-agent of its own', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'go deeper' } }] }, { text: 'done' }] },
      'go deeper': { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'deeper still' } }] }, { text: 'I did it myself.' }] },
    });
    await runAgentLoop(turn(client).input);
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
    await expect(runAgentLoop(input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
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
    const result = await runAgentLoop(turn(client, { onUsage: (report) => reports.push(report) }).input);
    expect(result.usage).toEqual({ input: 310, output: 31, costMicroUsd: 20 });
    expect(reports.map((report) => report.input)).toEqual([100, 150, 210, 310]);
    // Rolled-up reports keep describing the parent's context, not the sub-agent's.
    expect(reports[1].contextTokens).toBe(reports[0].contextTokens);
  });

  it('is not cut off at a step count: a long investigation finishes and answers', async () => {
    const steps = 45;
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'long' } }] }, { text: 'done' }] },
      long: { script: [], fallback: (_request: unknown, index: number) => (index < steps - 1 ? { toolCalls: [{ name: 'list_dir', args: { path: '.' }, id: `l${index}` }] } : { text: 'Found it after a long search.' }) },
    });
    const result = await runAgentLoop(turn(client).input);
    expect(result.stopReason).toBe('completed');
    expect(client.requests('long')).toHaveLength(steps);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).toMatch(/^Found it after a long search\./);
    expect(output).not.toMatch(/step limit|partial/);
  });

  it("puts a sub-agent's approvals through the parent's approver", async () => {
    const outside = path.join(root, 'home', 'secret.txt');
    await fs.writeFile(outside, 'x');
    const asked: string[] = [];
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'task', args: { prompt: 'peek' } }] }, { text: 'done' }] },
      peek: { script: [{ toolCalls: [{ name: 'read_file', args: { path: outside } }] }, { text: 'was refused' }] },
    });
    await runAgentLoop(turn(client, { permissionMode: 'ask', onApproval: async (title) => { asked.push(title); return false; } }).input);
    expect(asked).toHaveLength(1);
    expect(toolResults(client.requests('peek')[1])[0]).toMatch(/declined/);
    expect(toolResults(client.requests(PARENT_PROMPT)[1]).map(withoutTrace)).toEqual(['was refused']);
  });
  it('runs SubagentStop, not Stop, when a sub-agent would finish, and lets it send the sub-agent back', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ id: 't-stop', name: 'task', args: { prompt: 'look closer' } }] }, { text: 'parent done' }] },
      'look closer': { script: [{ text: 'first answer' }, { text: 'checked again' }] },
    });
    const seen: Array<Record<string, unknown>> = [];
    let stops = 0;
    const { input } = turn(client, { hooks: {
      stop: async () => { stops += 1; },
      subagentStop: async (info) => {
        seen.push({ ...info });
        return info.stopHookActive ? undefined : { continueWith: 'verify it' };
      },
    } });
    const result = await runAgentLoop(input);
    expect(result.text).toBe('parent done');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ sessionId: input.sessionId, cwd, agentType: 'research', stopHookActive: false });
    expect(String(seen[0].agentId)).toMatch(new RegExp(`^${input.sessionId}\\.task\\.`));
    expect(String(seen[0].agentTranscriptPath)).toMatch(/\.jsonl$/);
    const nudge = client.requests('look closer')[1]!.items.at(-1);
    expect(nudge?.type === 'text' && nudge.text).toBe('[SubagentStop hook] verify it');
    expect(withoutTrace(toolResults(client.requests(PARENT_PROMPT)[1])[0]!)).toMatch(/checked again$/);
    // The parent's own Stop hook ran once, for the parent.
    expect(stops).toBe(1);
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
    expect((await runAgentLoop(input)).stopReason).toBe('completed');
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
    await runAgentLoop(turn(client).input);
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
    await expect(runAgentLoop(turn(client, { signal: controller.signal }).input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
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
    await runAgentLoop(turn(client).input);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).toMatch(/Git worktree isolation requires/);
    expect(output).toContain('Pass that repository as repo');
    expect(output.split('\n')).toHaveLength(1);
    expect(client.requests('never runs')).toHaveLength(0);
  });

  async function initChildRepo(name: string): Promise<string> {
    const dir = path.join(cwd, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'a.txt'), 'the answer is 42\n');
    const inChild = (...args: string[]) => execFileAsync('git', args, { cwd: dir });
    await inChild('init', '-q', '-b', 'main');
    await inChild('add', '-A');
    await inChild('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base');
    return dir;
  }

  it('works in the repository named by `repo` when the session sits in a folder of repositories', async () => {
    const child = await initChildRepo('app');
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'edit the child', description: 'Edit child', repo: 'app' } }] }, { text: 'done' }] },
      'edit the child': { script: [
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '48' } }] },
        { text: 'Changed.' },
      ] },
    });
    await runAgentLoop(turn(client).input);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    const branch = branchOf(output);
    const inChild = async (...args: string[]) => (await execFileAsync('git', args, { cwd: child })).stdout.trim();
    expect(await inChild('show', `${branch}:a.txt`)).toBe('the answer is 48');
    expect(await fs.readFile(path.join(child, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
  });

  it('does not direct an agent into an unrelated repository when isolation cannot start', async () => {
    const child = await initChildRepo('app');
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'never runs', background: true, isolation: 'worktree' } }] }, { text: 'done' }] },
      'never runs': { script: [{ text: 'ran' }] },
    });
    await runAgentLoop(turn(client).input);
    const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
    expect(output).not.toContain(child);
    expect(output).toContain("Do not choose an unrelated repository");
    expect(client.requests('never runs')).toHaveLength(0);
  });

  it('refuses a `repo` outside the session directories', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-outside-'));
    try {
      const client = new RoutedModelClient({
        [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'never runs', repo: outside } }] }, { text: 'done' }] },
        'never runs': { script: [{ text: 'ran' }] },
      });
      await runAgentLoop(turn(client).input);
      const [output] = toolResults(client.requests(PARENT_PROMPT)[1]);
      expect(output).toMatch(/outside this session's working directory/);
      expect(client.requests('never runs')).toHaveLength(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('runs a background agent while the parent works, and the turn ends with its result', async () => {
    await initRepo();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 'bg', name: 'agent', args: { prompt: 'slow edit', description: 'Slow edit', background: true, isolation: 'worktree' } }] },
        // The agent is still held: the parent carries on meanwhile.
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }], before: () => release() },
        { text: 'I will wait for it.' },
        { text: 'It changed a.txt to 47 on its branch.' },
      ] },
      'slow edit': { script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }], before: () => released },
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '47' } }] },
        { text: 'Changed to 47.' },
      ] },
    });
    const { input, events } = turn(client);
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe('completed');
    const parent = client.requests(PARENT_PROMPT);
    expect(toolResults(parent[1])[0]).toMatch(/^Started agent_1 in the background/);
    expect(toolResults(parent[2])[1]).toMatch(/the answer is 42/);
    // Its result arrived as a message after the parent's own answer.
    const note = parent[3].items.at(-1);
    expect(note).toMatchObject({ type: 'text', role: 'user' });
    expect(note?.type === 'text' && note.text).toMatch(/^\[background agent agent_1 finished\] Slow edit\nChanged to 47\./);
    expect(events.some((event) => event.id === 'bg' && event.kind === 'tool-done')).toBe(true);
    const branch = await git('branch', '--list', '--format=%(refname:short)', 'clikcode/*');
    expect(await git('show', `${branch}:a.txt`)).toBe('the answer is 47');
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('the answer is 42\n');
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
  });

  it('lets a background agent finish when the conversation switches away mid-turn, and keeps its result', async () => {
    await initRepo();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ id: 'bg', name: 'agent', args: { prompt: 'slow edit', description: 'Slow edit', background: true, isolation: 'worktree' } }] },
        { text: 'unused: the conversation switched before this step' },
      ] },
      'slow edit': { script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }], before: () => released },
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '47' } }] },
        { text: 'Changed to 47.' },
      ] },
    });
    // The parent's first step goes through; at its second the conversation
    // has left this route, while the agent is still held.
    let checks = 0;
    const { input, events } = turn(client, { modelClientForStep: async () => {
      checks += 1;
      if (checks === 2) setTimeout(() => release(), 50);
      return checks >= 2 ? 'switch' as const : undefined;
    } });
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe('account-switch');
    // The agent was not stopped: it made its edit and gave its answer.
    expect(client.requests('slow edit')).toHaveLength(3);
    const done = events.find((event) => event.id === 'bg' && event.kind === 'tool-done');
    expect(done?.kind).toBe('tool-done');
    expect(done?.output?.join('\n')).toMatch(/Agent: Slow edit/);
    const branch = await git('branch', '--list', '--format=%(refname:short)', 'clikcode/*');
    expect(await git('show', `${branch}:a.txt`)).toBe('the answer is 47');
    // The parent made no model call after the switch.
    expect(client.requests(PARENT_PROMPT)).toHaveLength(1);
  });

  it('gives a running background agent a follow-up and waits for its result', async () => {
    await initRepo();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: [{ name: 'agent', args: { prompt: 'edit a.txt', background: true, isolation: 'worktree' } }] },
        { toolCalls: [{ name: 'agent_send', args: { id: 'agent_1', message: 'Make it 46 instead.' } }] },
        { toolCalls: [{ name: 'agent_wait', args: { id: 'agent_1' } }], before: () => release() },
        { text: 'done' },
      ] },
      'edit a.txt': { script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }], before: () => released },
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '46' } }] },
        { text: 'Made it 46.' },
      ] },
    });
    await runAgentLoop(turn(client).input);
    // The instruction reached the agent before its second step.
    const second = client.requests('edit a.txt')[1].items;
    expect(second.some((item) => item.type === 'text' && item.role === 'user' && item.text === 'Make it 46 instead.')).toBe(true);
    const parent = client.requests(PARENT_PROMPT);
    expect(toolResults(parent[2])[1]).toMatch(/^Sent to agent_1/);
    const waited = toolResults(parent[3])[2];
    expect(waited).toMatch(/^\[agent_1 finished\] edit a\.txt\nMade it 46\./);
    expect(waited).toMatch(/on branch clikcode\//);
    // Delivered by the wait, so not again as a message.
    expect(parent[3].items.some((item) => item.type === 'text' && /background agent agent_1 finished/.test(item.text))).toBe(false);
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
  });

  it('serializes mutations across background agents sharing a directory', async () => {
    let active = 0;
    let maximum = 0;
    const completed: string[] = [];
    const mutate = defineTool<{ who: string }>({
      name: 'record_mutation', class: 'write', description: 'record a mutation',
      parameters: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
      label: (args) => args.who,
      async run(args) {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed.push(args.who);
        active--;
        return { output: 'recorded' };
      },
    });
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [
        { toolCalls: ['one', 'two'].map((prompt) => ({ name: 'agent', args: { prompt, background: true } })) },
        { toolCalls: [{ name: 'record_mutation', args: { who: 'parent' } }] },
      ], fallback: { text: 'done' } },
      one: { script: [{ toolCalls: [{ name: 'record_mutation', args: { who: 'one' } }] }, { text: 'done' }] },
      two: { script: [{ toolCalls: [{ name: 'record_mutation', args: { who: 'two' } }] }, { text: 'done' }] },
    });
    expect(await runAgentLoop(turn(client, { tools: [...defaultTools(), mutate] }).input)).toMatchObject({ stopReason: 'completed' });
    expect(completed.sort()).toEqual(['one', 'parent', 'two']);
    expect(maximum).toBe(1);
  });

  it('runs a background task without Git when worktree isolation was not requested', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'background research', background: true } }] }, { text: 'waiting' }, { text: 'done' }] },
      'background research': { script: [{ text: 'research complete' }] },
    });
    const h = turn(client);
    expect(await runAgentLoop(h.input)).toMatchObject({ stopReason: 'completed' });
    expect(client.requests('background research')).toHaveLength(1);
    expect(toolResults(client.requests(PARENT_PROMPT)[1])[0]).toContain('sharing this working directory');
  });

  it('refuses a background agent outside a git repository at once', async () => {
    const client = new RoutedModelClient({
      [PARENT_PROMPT]: { script: [{ toolCalls: [{ name: 'agent', args: { prompt: 'never runs', background: true, isolation: 'worktree' } }] }, { text: 'done' }] },
      'never runs': { script: [{ text: 'ran' }] },
    });
    await runAgentLoop(turn(client).input);
    expect(toolResults(client.requests(PARENT_PROMPT)[1])[0]).toMatch(/is not inside a git repository/);
    expect(client.requests('never runs')).toHaveLength(0);
  });

  /** A background agent gated on `gate`, after it has made an edit. */
  const gatedAgent = (gate: Promise<void>, started: () => void): RoutedModelClient => new RoutedModelClient({
    [PARENT_PROMPT]: { script: [
      { toolCalls: [{ name: 'agent', args: { prompt: 'edit and hang', background: true, isolation: 'worktree' } }] },
      { text: 'waiting' },
    ] },
    'edit and hang': { script: [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: '42', new_string: '48' } }] },
      { before: async () => { started(); await gate; }, text: 'all done' },
    ] },
  });

  it('a cancelled turn does NOT stop a background agent: it finishes, and its result is queued for the model', async () => {
    await initRepo();
    const controller = new AbortController();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    const client = gatedAgent(gate, () => { reachedGate(); });
    const { input } = turn(client, { signal: controller.signal });
    const loop = runAgentLoop(input);
    await atGate;
    controller.abort();
    await expect(loop).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    const session = sessionState(stateDir, input.sessionId);
    const agents = sessionAgents(session, stateDir);
    // The turn is over; the agent is not.
    expect(agents.running()).toBe(1);
    expect((await fs.readdir(path.join(root, 'tmp'))).length).toBe(1);
    open();
    await agents.settled();
    expect(agents.running()).toBe(0);
    const branch = await git('branch', '--list', '--format=%(refname:short)', 'clikcode/*');
    expect(await git('show', `${branch}:a.txt`)).toBe('the answer is 48');
    // Nobody was listening: the model hears of it as a notification.
    expect(session.notifications.map((note) => note.kind)).toEqual(['agent']);
    expect(formatShellNotifications(session.notifications)).toMatch(/\[background agent agent_1 finished\] edit and hang/);
    expect(readAgentRecords(stateDir, input.sessionId)).toMatchObject([{ id: 'agent_1', status: 'finished' }]);
  });

  it('an explicit stop ends the agent, keeping its work on its branch', async () => {
    await initRepo();
    const controller = new AbortController();
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    // Never opens: only the stop ends it.
    const client = gatedAgent(new Promise<void>(() => undefined), () => { reachedGate(); });
    const { input } = turn(client, { signal: controller.signal });
    const loop = runAgentLoop(input);
    await atGate;
    controller.abort();
    await expect(loop).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    const agents = sessionAgents(sessionState(stateDir, input.sessionId), stateDir);
    expect(agents.runningAgents().map((agent) => agent.id)).toEqual(['agent_1']);
    expect(await agents.stop('agent_1', 'stopped by you')).toBe(true);
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
    const branch = await git('branch', '--list', '--format=%(refname:short)', 'clikcode/*');
    expect(await git('show', `${branch}:a.txt`)).toBe('the answer is 48');
    expect(readAgentRecords(stateDir, input.sessionId)).toMatchObject([{ id: 'agent_1', status: 'stopped' }]);
  });
});
