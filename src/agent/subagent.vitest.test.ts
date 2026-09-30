import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
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

describe('task sub-agents', () => {
  it('runs a read-only sub-agent in its own conversation and returns only its answer', async () => {
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
    expect(toolResults(client.requests(PARENT_PROMPT)[1])).toEqual(['a.txt:1 says the answer is 42.']);

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

    // Only the parent's conversation is on disk.
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
    expect(toolResults(client.requests(PARENT_PROMPT)[1])).toEqual(['answer one', 'answer two', 'answer three']);
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
    expect(toolResults(client.requests(PARENT_PROMPT)[1])).toEqual(['I did it myself.']);
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
    await expect(runGatewayHarnessTurn(turn(client, { signal: controller.signal }).input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(client.requests('long job')).toHaveLength(2);
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
    expect(toolResults(client.requests(PARENT_PROMPT)[1])).toEqual(['was refused']);
  });
});
