import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/types.js';
import { ConversationStore } from './conversation.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { disposeSessionState } from './session-state.js';
import { ScriptedModelClient, type ScriptEntry } from './testing.js';
import { defineTool, type GatewayHarnessTurnInput, type ToolDefinition } from './types.js';

let root: string;
let cwd: string;
let stateDir: string;
let homeDir: string;
let sessionCounter = 0;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-loop-')));
  cwd = path.join(root, 'work');
  stateDir = path.join(root, 'state');
  homeDir = path.join(root, 'home');
  await Promise.all([cwd, stateDir, homeDir].map((dir) => fs.mkdir(dir, { recursive: true })));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface Harness {
  input: GatewayHarnessTurnInput;
  events: HarnessActivityEvent[];
  deltas: string[];
  client: ScriptedModelClient;
}

function harness(script: ScriptEntry[], overrides: Partial<GatewayHarnessTurnInput> = {}, fallback?: ScriptEntry): Harness {
  const events: HarnessActivityEvent[] = [];
  const deltas: string[] = [];
  const client = new ScriptedModelClient(script, fallback);
  const sessionId = `s${++sessionCounter}`;
  return {
    events, deltas, client,
    input: {
      sessionId, cwd, stateDir, homeDir, userConfigDir: path.join(root, 'config'), prompt: 'do the thing',
      permissionMode: 'bypass', modelClient: client,
      onActivity: (event) => events.push(event),
      onResponseDelta: (text) => deltas.push(text),
      ...overrides,
    },
  };
}

describe('runGatewayHarnessTurn', () => {
  it('runs tool round trips and emits start/done in order with matching ids', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\nworld\n');
    const h = harness([
      { text: 'Looking.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'c2', name: 'edit_file', args: { path: 'a.txt', old_string: 'world', new_string: 'there' } }] },
      { text: 'Done.' },
    ]);
    const usage: unknown[] = [];
    const result = await runGatewayHarnessTurn({ ...h.input, onUsage: (report) => usage.push(report) });

    expect(result).toMatchObject({ text: 'Looking.\n\nDone.', steps: 3, stopReason: 'completed', nativeSessionId: h.input.sessionId });
    expect(result.isError).toBeUndefined();
    expect(result.usage).toEqual({ input: 300, output: 30 });
    expect(usage).toHaveLength(3);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('hello\nthere\n');

    expect(h.events.map((event) => `${event.kind}:${event.id}`)).toEqual(['tool-start:c1', 'tool-done:c1', 'tool-start:c2', 'tool-done:c2']);
    expect(h.events[1].output?.join('\n')).toContain('hello');
    expect(h.events[3].diff).toEqual({ removed: ['world'], added: ['there'] });
    // A blank line separates prose segments that had tool work between them.
    expect(h.deltas.join('')).toBe('Looking.\n\nDone.');

    // The second step saw the first tool's result, threaded by id.
    const second = h.client.requests[1].items;
    expect(second.map((item) => item.type)).toEqual(['text', 'text', 'tool_call', 'tool_result']);
    expect(second[3]).toMatchObject({ type: 'tool_result', id: 'c1', name: 'read_file' });

    const persisted = await new ConversationStore(stateDir, h.input.sessionId).load();
    expect(persisted.map((item) => item.type)).toEqual(['text', 'text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text']);
  });

  it('treats tool work with no prose as success', async () => {
    const h = harness([{ toolCalls: [{ name: 'list_dir', args: {} }] }, {}]);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result).toMatchObject({ text: '', steps: 2, stopReason: 'completed' });
    expect(result.isError).toBeUndefined();
  });

  it('runs consecutive read-class calls in parallel and others sequentially', async () => {
    let active = 0;
    let peakReads = 0;
    const order: string[] = [];
    const slow = (name: string, klass: ToolDefinition['class']): ToolDefinition => defineTool<{ tag: string }>({
      name, class: klass, description: name, label: (args) => `${name} ${args.tag}`,
      parameters: { type: 'object', required: ['tag'], properties: { tag: { type: 'string' } } },
      async run(args) {
        active++;
        if (klass === 'read') peakReads = Math.max(peakReads, active);
        order.push(`start:${args.tag}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`end:${args.tag}`);
        active--;
        return { output: args.tag };
      },
    });
    const h = harness([
      { toolCalls: [
        { name: 'slow_read', args: { tag: 'r1' } }, { name: 'slow_read', args: { tag: 'r2' } }, { name: 'slow_read', args: { tag: 'r3' } },
        { name: 'slow_meta', args: { tag: 'm1' } }, { name: 'slow_meta', args: { tag: 'm2' } },
      ] },
      { text: 'ok' },
    ], { tools: [slow('slow_read', 'read'), slow('slow_meta', 'meta')] });
    await runGatewayHarnessTurn(h.input);
    expect(peakReads).toBe(3);
    expect(order.slice(0, 3)).toEqual(['start:r1', 'start:r2', 'start:r3']);
    expect(order.slice(6)).toEqual(['start:m1', 'end:m1', 'start:m2', 'end:m2']);
    // Results go back in call order regardless of completion order.
    const results = h.client.requests[1].items.filter((item) => item.type === 'tool_result');
    expect(results.map((item) => item.type === 'tool_result' && item.output)).toEqual(['r1', 'r2', 'r3', 'm1', 'm2']);
  });

  it('feeds schema violations and unknown tools back to the model', async () => {
    const h = harness([
      { toolCalls: [
        { id: 'bad', name: 'read_file', args: { path: 7, extra: true } },
        { id: 'nope', name: 'teleport', args: {} },
      ] },
      { text: 'sorry' },
    ]);
    await runGatewayHarnessTurn(h.input);
    const results = h.client.requests[1].items.filter((item) => item.type === 'tool_result');
    expect(results[0]).toMatchObject({ id: 'bad', isError: true });
    expect(results[0].type === 'tool_result' && results[0].output).toMatch(/args\.path: expected string, got integer/);
    expect(results[0].type === 'tool_result' && results[0].output).toMatch(/args\.extra: unknown property/);
    expect(results[1].type === 'tool_result' && results[1].output).toMatch(/Unknown tool "teleport".*read_file/s);
    expect(h.events.filter((event) => event.kind === 'tool-error').map((event) => event.id)).toEqual(['bad', 'nope']);
  });

  it('stops at maxSteps', async () => {
    const h = harness([], { maxSteps: 3 }, (_request, index) => ({ toolCalls: [{ name: 'list_dir', args: { path: '.' }, id: `loop${index}` }] }));
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.steps).toBe(3);
    expect(result.stopReason).toBe('max-steps');
    expect(result.text).toMatch(/Stopped after 3 steps/);
  });

  it('detects no progress: tells the model after 3 identical failures, then stops', async () => {
    const failing = { name: 'read_file', args: { path: 'missing.txt' } };
    const h = harness([{ toolCalls: [failing] }, { toolCalls: [failing] }, { toolCalls: [failing] }, { text: 'I cannot find missing.txt.', toolCalls: [failing] }]);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result).toMatchObject({ steps: 4, stopReason: 'no-progress', isError: true, text: 'I cannot find missing.txt.' });
    const last = h.client.requests[3];
    expect(last.tools).toEqual([]);
    const notice = last.items[last.items.length - 1];
    expect(notice.type === 'text' && notice.text).toMatch(/failed 3 times with identical arguments/);
    // The tool call the model tried to sneak into the final reply never ran.
    expect(h.events.filter((event) => event.kind === 'tool-start')).toHaveLength(3);
  });

  it('abort mid-tool kills the whole process group and throws ERR_TURN_CANCELLED', async () => {
    const pidFile = path.join(cwd, 'child.pid');
    const controller = new AbortController();
    const h = harness([{ toolCalls: [{ name: 'bash', args: { command: `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait` } }] }], { signal: controller.signal });
    const steerStates: boolean[] = [];
    const turn = runGatewayHarnessTurn({ ...h.input, onSteerReady: (handler) => steerStates.push(!!handler) });
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pid = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0;
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await expect(turn).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(steerStates).toEqual([true, false]);
  }, 15_000);

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([{ text: 'never' }], { signal: controller.signal });
    await expect(runGatewayHarnessTurn(h.input)).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(h.client.requests).toHaveLength(0);
  });

  it('injects steering text as a user item before the next model step', async () => {
    let steer: ((text: string) => Promise<void>) | undefined;
    const h = harness([
      { toolCalls: [{ name: 'list_dir', args: {} }], before: async () => { await steer!('use tabs, not spaces'); } },
      { text: 'ok, tabs' },
    ]);
    const published: boolean[] = [];
    await runGatewayHarnessTurn({ ...h.input, onSteerReady: (handler) => { steer = handler; published.push(!!handler); } });
    const items = h.client.requests[1].items;
    expect(items[items.length - 1]).toEqual({ type: 'text', role: 'user', text: 'use tabs, not spaces' });
    expect(published).toEqual([true, false]);
    await expect(steer).toBeUndefined();
  });

  it('continues instead of finishing when steering arrives during the final step', async () => {
    let steer: ((text: string) => Promise<void>) | undefined;
    const h = harness([{ text: 'done', before: async () => { await steer!('one more thing'); } }, { text: 'handled' }]);
    const result = await runGatewayHarnessTurn({ ...h.input, onSteerReady: (handler) => { steer = handler; } });
    expect(result.steps).toBe(2);
    expect(result.text).toBe('done\n\nhandled');
  });

  it('classifies model failures from structured status', async () => {
    const quota = await runGatewayHarnessTurn(harness([{ error: Object.assign(new Error('slow down'), { statusCode: 429, retryAfter: 12 }) }]).input);
    expect(quota).toMatchObject({ isError: true, errorKind: 'quota', retryAfter: 12, text: 'slow down', stopReason: 'model-error' });
    const auth = await runGatewayHarnessTurn(harness([{ error: Object.assign(new Error('nope'), { statusCode: 401 }) }]).input);
    expect(auth.errorKind).toBe('auth');
    const other = await runGatewayHarnessTurn(harness([{ error: new Error('quota exceeded in prose only') }]).input);
    expect(other.errorKind).toBe('other');
  });

  it('asks before writes in ask mode, reports refusals to the model, and denies with no approver', async () => {
    const write = { name: 'write_file', args: { path: 'new.txt', content: 'x\n' } };
    const prompts: { title: string; detail?: string }[] = [];
    const declined = harness([{ toolCalls: [write] }, { text: 'ok' }], {
      permissionMode: 'ask', onApproval: async (title, detail) => { prompts.push({ title, detail }); return false; },
    });
    await runGatewayHarnessTurn(declined.input);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].detail).toContain(path.join(cwd, 'new.txt'));
    expect(prompts[0].detail).toContain('+ x');
    await expect(fs.access(path.join(cwd, 'new.txt'))).rejects.toThrow();
    const refusal = declined.client.requests[1].items.at(-1);
    expect(refusal?.type === 'tool_result' && refusal.output).toMatch(/user declined/);

    const unattended = harness([{ toolCalls: [write] }, { text: 'ok' }], { permissionMode: 'ask' });
    await runGatewayHarnessTurn(unattended.input);
    const denied = unattended.client.requests[1].items.at(-1);
    expect(denied?.type === 'tool_result' && denied.output).toMatch(/no approver is attached/);

    const approved = harness([{ toolCalls: [write] }, { text: 'ok' }], { permissionMode: 'ask', onApproval: async () => true });
    await runGatewayHarnessTurn(approved.input);
    expect(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).toBe('x\n');
  });

  it('plan mode hides write/exec tools and unlocks them once the plan is approved', async () => {
    const exits: string[] = [];
    const h = harness([
      { toolCalls: [{ name: 'write_file', args: { path: 'p.txt', content: '1' } }] },
      { toolCalls: [{ name: 'exit_plan_mode', args: { plan: '1. write p.txt' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'p.txt', content: '1' } }] },
      { text: 'done' },
    ], { planMode: true, permissionMode: 'bypass', onApproval: async (title) => title === 'Approve plan', onPlanModeExit: (plan) => exits.push(plan) });
    await runGatewayHarnessTurn(h.input);
    const names = (index: number): string[] => h.client.requests[index].tools.map((tool) => tool.name);
    expect(names(0)).not.toContain('write_file');
    expect(names(0)).not.toContain('bash');
    expect(names(0)).toContain('exit_plan_mode');
    expect(h.client.requests[0].system).toMatch(/Plan mode is ACTIVE/);
    const refused = h.client.requests[1].items.at(-1);
    expect(refused?.type === 'tool_result' && refused.output).toMatch(/plan mode is active/);
    expect(names(2)).toContain('write_file');
    expect(h.client.requests[2].system).not.toMatch(/Plan mode is ACTIVE/);
    expect(exits).toEqual(['1. write p.txt']);
    expect(await fs.readFile(path.join(cwd, 'p.txt'), 'utf8')).toBe('1');
    disposeSessionState(stateDir, h.input.sessionId);
  });

  it('lets a pre hook veto and a post hook rewrite, and routes todo_write to onPlan', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'secret-ish');
    const plans: unknown[] = [];
    const h = harness([
      { toolCalls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'list_dir', args: {} },
        { name: 'todo_write', args: { todos: [{ content: 'step', status: 'in_progress' }] } },
      ] },
      { text: 'ok' },
    ], {
      onPlan: (entries) => plans.push(entries),
      hooks: {
        preToolUse: (call) => call.name === 'list_dir' ? { deny: 'listing disabled' } : undefined,
        postToolUse: (call) => call.name === 'read_file' ? { output: 'REWRITTEN' } : undefined,
      },
    });
    await runGatewayHarnessTurn(h.input);
    const outputs = h.client.requests[1].items.flatMap((item) => item.type === 'tool_result' ? [item.output] : []);
    expect(outputs[0]).toBe('REWRITTEN');
    expect(outputs[1]).toMatch(/Blocked by a hook: listing disabled/);
    expect(plans).toEqual([[{ content: 'step', status: 'in_progress' }]]);
  });

  it('resumes a session from its transcript', async () => {
    const first = harness([{ text: 'first answer' }]);
    await runGatewayHarnessTurn(first.input);
    const second = harness([{ text: 'second answer' }], { sessionId: first.input.sessionId, prompt: 'follow up' });
    await runGatewayHarnessTurn(second.input);
    expect(second.client.requests[0].items).toEqual([
      { type: 'text', role: 'user', text: 'do the thing' },
      { type: 'text', role: 'assistant', text: 'first answer' },
      { type: 'text', role: 'user', text: 'follow up' },
    ]);
  });

  it('compacts when the reported context passes 80% of the window', async () => {
    await fs.writeFile(path.join(cwd, 'big.txt'), `${'line of filler text\n'.repeat(400)}`);
    const phases: string[] = [];
    const read = (id: string) => ({ toolCalls: [{ id, name: 'read_file', args: { path: 'big.txt' } }], usage: { input: 900, output: 10 }, contextWindow: 1000 });
    const h = harness([
      read('r1'), read('r2'), read('r3'), read('r4'),
      (request) => {
        // Either the summarization step or, if eliding sufficed, the next real step.
        return request.tools.length === 0 ? { text: 'SUMMARY: read big.txt four times' } : { text: 'finished' };
      },
    ], { onPhase: (phase) => phases.push(phase) }, { text: 'finished' });
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('completed');
    expect(phases).toContain('compacting context');
    const compactedRequest = h.client.requests.find((request, index) => index > 0 && request.items.some((item) => item.type === 'summary' || (item.type === 'tool_result' && /elided to save context/.test(item.output))));
    expect(compactedRequest).toBeDefined();
    // The transcript on disk keeps every original item.
    const history = await new ConversationStore(stateDir, h.input.sessionId).loadFullHistory();
    expect(history.filter((item) => item.type === 'tool_result')).toHaveLength(4);
    expect(history.every((item) => item.type !== 'tool_result' || !/elided/.test(item.output))).toBe(true);
  });
});
