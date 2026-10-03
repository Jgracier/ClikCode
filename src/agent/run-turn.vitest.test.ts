import { changed } from './line-diff.test-support.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { ConversationStore } from './conversation.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { disposeSessionState, formatShellNotifications, sessionState } from './session-state.js';
import { ScriptedModelClient, type ScriptEntry } from './testing.js';
import { type GatewayHarnessTurnInput } from './model-client.js';
import { defineTool, type ToolDefinition } from './tool-contract.js';

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
    expect(changed(h.events[3].diff)).toEqual({ removed: ['world'], added: ['there'] });
    // The whole file was diffed, so its lines are numbered.
    expect(h.events[3].diff![0]!.lines.find((line) => line.kind === 'added')).toEqual({ kind: 'added', text: 'there', line: 2 });
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

  it('gives calls that share an id distinct ids, so every result reaches its own call', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'B\n');
    const h = harness([
      { toolCalls: [{ id: 'dup', name: 'read_file', args: { path: 'a.txt' } }, { id: 'dup', name: 'read_file', args: { path: 'b.txt' } }] },
      { text: 'ok' },
    ]);
    await runGatewayHarnessTurn(h.input);
    const items = h.client.requests[1].items;
    const calls = items.filter((item) => item.type === 'tool_call').map((item) => item.type === 'tool_call' && item.id);
    const results = items.filter((item) => item.type === 'tool_result');
    expect(new Set(calls).size).toBe(2);
    expect(results.map((item) => item.type === 'tool_result' && item.id)).toEqual(calls);
    expect(results.map((item) => item.type === 'tool_result' && item.output.includes('B'))).toEqual([false, true]);
  });

  it('reports a command\'s exit code and how long each call ran', async () => {
    const h = harness([{ toolCalls: [{ id: 'x', name: 'bash', args: { command: 'exit 3' } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn(h.input);
    const done = h.events.find((event) => event.kind === 'tool-error' && event.id === 'x');
    expect(done).toMatchObject({ label: '$ exit 3', category: 'run', exitCode: 3 });
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
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
    // The tools stay declared -- the history holds tool calls, which Anthropic
    // refuses without them -- and the model is told not to call one.
    expect(last.tools.length).toBeGreaterThan(0);
    expect(last.toolChoice).toBe('none');
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

  describe('background shells', () => {
    /** Resolves on the session's next shell notification: the same hook the worker uses. */
    const nextNotification = (sessionId: string): Promise<void> => new Promise((resolve) => {
      sessionState(stateDir, sessionId).onNotification = () => resolve();
    });

    it('queue a notification with the exit code and unread tail when they finish, and call the listener', async () => {
      const gate = path.join(cwd, 'gate');
      const h = harness([
        { toolCalls: [{ name: 'bash', args: { command: `while [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.02; done; echo started; echo secret-free-tail; exit 3`, run_in_background: true } }] },
        { text: 'started it' },
      ]);
      const exited = nextNotification(h.input.sessionId);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result.text).toBe('started it');
      const told = h.client.requests[1].items.at(-1);
      expect(told?.type === 'tool_result' && told.output).toMatch(/You will be told when it exits/);
      await fs.writeFile(gate, '');
      await exited;
      const state = sessionState(stateDir, h.input.sessionId);
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]).toMatchObject({ shellId: 'bash_1', exitCode: 3 });
      expect(formatShellNotifications(state.notifications)).toMatch(/^\[background shell bash_1 exited \(code 3\)\] while .*; exit 3\nstarted\nsecret-free-tail$/);
      disposeSessionState(stateDir, h.input.sessionId);
    });

    it('are handed to the model at the top of the next step, once', async () => {
      let exited!: Promise<void>;
      const h = harness([
        { toolCalls: [{ name: 'bash', args: { command: 'echo built', run_in_background: true } }] },
        { toolCalls: [{ name: 'list_dir', args: {} }], before: () => exited },
        { text: 'saw it' },
      ]);
      exited = nextNotification(h.input.sessionId);
      const events: string[] = [];
      await runGatewayHarnessTurn({ ...h.input, onActivity: (event) => events.push(`${event.kind}:${event.label}`) });
      const third = h.client.requests[2].items;
      const notices = third.filter((item) => item.type === 'text' && item.text.startsWith('[background shell bash_1 exited (code 0)]'));
      expect(notices).toHaveLength(1);
      expect(events).toContain('tool-done:bash_1 exited: echo built');
      expect(sessionState(stateDir, h.input.sessionId).notifications).toHaveLength(0);
      disposeSessionState(stateDir, h.input.sessionId);
    });

    it('keep the turn going when one finishes during what would have been the last step', async () => {
      let exited!: Promise<void>;
      const h = harness([
        { toolCalls: [{ name: 'bash', args: { command: `while [ ! -e gate ]; do sleep 0.02; done; echo done`, run_in_background: true } }] },
        { text: 'waiting for it', before: async () => { await fs.writeFile(path.join(cwd, 'gate'), ''); await exited; } },
        { text: 'it finished' },
      ]);
      exited = nextNotification(h.input.sessionId);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result).toMatchObject({ steps: 3, text: 'waiting for it\n\nit finished' });
      const last = h.client.requests[2].items.at(-1);
      expect(last?.type === 'text' && last.text).toMatch(/^\[background shell bash_1 exited \(code 0\)\] while .*; echo done\ndone$/);
      disposeSessionState(stateDir, h.input.sessionId);
    });

    it('stopped by kill_bash are not reported back; disposing reports the ones it kills', async () => {
      const h = harness([
        { toolCalls: [{ name: 'bash', args: { command: 'sleep 30', run_in_background: true } }] },
        { toolCalls: [{ name: 'kill_bash', args: { id: 'bash_1' } }] },
        { toolCalls: [{ name: 'bash', args: { command: 'sleep 31', run_in_background: true } }] },
        { text: 'ok' },
      ]);
      await runGatewayHarnessTurn(h.input);
      const state = sessionState(stateDir, h.input.sessionId);
      const killed = state.shells.get('bash_1')!;
      if (killed.exitCode === undefined) await new Promise((resolve) => killed.child.once('close', resolve));
      expect(state.notifications).toHaveLength(0);
      const undelivered = disposeSessionState(stateDir, h.input.sessionId, 'the worker stopped');
      expect(undelivered).toEqual([expect.objectContaining({ shellId: 'bash_2', command: 'sleep 31', reason: 'the worker stopped' })]);
    });
  });

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
    const prompts: { title: string; detail?: string; added?: string[] }[] = [];
    const declined = harness([{ toolCalls: [write] }, { text: 'ok' }], {
      permissionMode: 'ask', onApproval: async (title, detail, _rule, preview) => {
        prompts.push({ title, detail, added: preview?.diff?.[0]?.lines.filter((line) => line.kind === 'added').map((line) => line.text) });
        return false;
      },
    });
    await runGatewayHarnessTurn(declined.input);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].detail).toContain(path.join(cwd, 'new.txt'));
    expect(prompts[0].added).toEqual(['x']);
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

  it('honours a switch from ask to bypass made while the turn is running', async () => {
    // The user answers the first prompt, then sets /permissions bypass mid-turn.
    let mode: 'ask' | 'bypass' = 'ask';
    const prompts: string[] = [];
    const h = harness([
      { toolCalls: [{ name: 'write_file', args: { path: 'first.txt', content: '1\n' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'second.txt', content: '2\n' } }] },
      { text: 'done' },
    ], {
      permissionMode: 'ask',
      currentPermissionMode: async () => mode,
      onApproval: async (title) => { prompts.push(title); mode = 'bypass'; return true; },
    });
    await runGatewayHarnessTurn(h.input);
    expect(prompts).toHaveLength(1);
    expect(await fs.readFile(path.join(cwd, 'second.txt'), 'utf8')).toBe('2\n');
  });

  it('applies an "always" answer to the rest of the turn, the same step included', async () => {
    const prompts: string[] = [];
    const h = harness([
      { toolCalls: [{ id: 'a', name: 'bash', args: { command: 'true 1' } }, { id: 'b', name: 'bash', args: { command: 'true 1 again' } }] },
      { toolCalls: [{ id: 'c', name: 'bash', args: { command: 'true 1 later' } }] },
      { text: 'done' },
    ], {
      permissionMode: 'ask',
      onApproval: async (title, _detail, rule) => { prompts.push(`${title} ${rule}`); return 'always'; },
    });
    await runGatewayHarnessTurn(h.input);
    expect(prompts).toEqual(['Approve command Bash(true 1:*)']);
    expect(h.events.filter((event) => event.kind === 'tool-done')).toHaveLength(3);
  });

  it('keeps the mode the turn started with when the current mode cannot be read', async () => {
    const prompts: string[] = [];
    const h = harness([{ toolCalls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' } }] }, { text: 'ok' }], {
      permissionMode: 'ask',
      currentPermissionMode: async () => { throw new Error('index unreadable'); },
      onApproval: async (title) => { prompts.push(title); return true; },
    });
    await runGatewayHarnessTurn(h.input);
    expect(prompts).toHaveLength(1);
  });

  it('ends the turn on an ask_user question, whose answer is the next message', async () => {
    const h = harness([
      { toolCalls: [{ name: 'ask_user', args: { question: 'Which database?', options: ['Postgres', 'SQLite'] } }] },
      { text: 'should not run' },
    ]);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('Which database?\n\n1. Postgres\n2. SQLite\n\nReply with a number, or in your own words.');
    expect(h.client.requests).toHaveLength(1);
  });

  it('refuses a prompt a UserPromptSubmit hook blocks, and adds the context one returns', async () => {
    const blocked = harness([{ text: 'never' }], { hooks: { userPromptSubmit: async () => ({ block: 'no deploys on Friday' }) } });
    const refused = await runGatewayHarnessTurn(blocked.input);
    expect(refused).toMatchObject({ isError: true, text: 'Your message was blocked by a UserPromptSubmit hook: no deploys on Friday' });
    expect(blocked.client.requests).toHaveLength(0);

    const enriched = harness([{ text: 'ok' }], {
      hooks: { userPromptSubmit: async () => ({ context: 'branch: main' }), sessionStart: async () => ({ context: 'on-call: ana' }) },
    });
    await runGatewayHarnessTurn(enriched.input);
    const first = enriched.client.requests[0]!.items.find((item) => item.type === 'text' && item.role === 'user');
    expect(first?.type === 'text' && first.text).toMatch(/<hook-context>\non-call: ana\n\nbranch: main\n<\/hook-context>/);
  });

  it('lets a Stop hook send the agent back to work, a bounded number of times', async () => {
    let asked = 0;
    const h = harness([{ text: 'done' }, { text: 'ran the tests' }, { text: 'x' }, { text: 'y' }, { text: 'z' }], {
      hooks: { stop: async ({ stopHookActive }) => { asked += 1; return stopHookActive && asked > 1 ? undefined : { continueWith: 'run the tests first' }; } },
    });
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('completed');
    expect(result.text).toContain('ran the tests');
    const nudge = h.client.requests[1]!.items.at(-1);
    expect(nudge?.type === 'text' && nudge.text).toBe('[Stop hook] run the tests first');
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

  it('adds deferred MCP schemas once the model loads them, and keeps them on later turns', async () => {
    const mcp = Array.from({ length: 30 }, (_, i) => defineTool({
      name: `mcp__big__t${i}`, description: 'x'.repeat(300), parameters: { type: 'object', properties: {} },
      class: 'read', mcp: { server: 'big', tool: `t${i}` }, label: () => `t${i}`, run: async () => ({ output: `ran t${i}` }),
    }));
    const h = harness([
      { toolCalls: [{ name: 'load_mcp_tools', args: { server: 'big', tools: ['t4'] } }] },
      { toolCalls: [{ name: 'mcp__big__t4', args: {} }] },
      { text: 'done' },
    ], { extraTools: mcp });
    await runGatewayHarnessTurn(h.input);
    const toolNames = h.client.requests.map((request) => request.tools.map((tool) => tool.name).filter((name) => name.startsWith('mcp__')));
    expect(toolNames).toEqual([[], ['mcp__big__t4'], ['mcp__big__t4']]);
    const later = harness([{ text: 'again' }], { extraTools: mcp, sessionId: h.input.sessionId, prompt: 'more' });
    await runGatewayHarnessTurn(later.input);
    expect(later.client.requests[0].tools.map((tool) => tool.name)).toContain('mcp__big__t4');
  });

  it('sizes tool output to a small window: read_file pages instead of losing its middle', async () => {
    await fs.writeFile(path.join(cwd, 'long.txt'), Array.from({ length: 2000 }, (_, i) => `line ${i} ${'z'.repeat(30)}`).join('\n'));
    const h = harness([
      { toolCalls: [{ id: 'r', name: 'read_file', args: { path: 'long.txt' } }], contextWindow: 16_384 },
      { toolCalls: [{ id: 'b', name: 'bash', args: { command: 'seq 1 20000' } }] },
      { text: 'ok' },
    ]);
    await runGatewayHarnessTurn(h.input);
    const results = h.client.requests[2].items.filter((item) => item.type === 'tool_result');
    const read = results[0].type === 'tool_result' ? results[0].output : '';
    expect(Buffer.byteLength(read)).toBeLessThanOrEqual(8 * 1024);
    expect(read).toMatch(/^1\tline 0 /);
    expect(read).toMatch(/\[Showing lines 1-\d+ of 2000\. Continue with offset=\d+\.\]$/);
    expect(read).not.toContain('truncated');
    // bash keeps its head, tail and where the full log went.
    const bash = results[1].type === 'tool_result' ? results[1].output : '';
    expect(Buffer.byteLength(bash)).toBeLessThanOrEqual(8 * 1024 + 300);
    expect(bash).toMatch(/^1\n2\n/);
    expect(bash).toMatch(/full output saved to .*\.log/);
    expect(bash).toMatch(/20000$/);
  });

  it('fails the turn when a tool result cannot be saved, rather than carrying on with disk and memory diverged', async () => {
    const sessionId = `s${++sessionCounter}`;
    const transcript = path.join(stateDir, 'sessions', sessionId, 'harness.jsonl');
    // The tool runs, then makes the transcript unwritable: its result is the
    // first thing that cannot be appended.
    const breaker = defineTool({
      name: 'breaker', description: 'breaks the transcript', parameters: { type: 'object', properties: {} },
      class: 'read', label: () => 'breaker',
      run: async () => { await fs.rm(transcript, { force: true }); await fs.mkdir(transcript); return { output: 'ran' }; },
    });
    const h = harness([{ toolCalls: [{ id: 'b1', name: 'breaker', args: {} }] }, { text: 'never reached' }], { sessionId, extraTools: [breaker] });
    await expect(runGatewayHarnessTurn(h.input)).rejects.toThrow(/could not save the results of 1 tool call/);
    expect(h.client.requests).toHaveLength(1);
  });

  it('resumes a session from its transcript', async () => {
    const first = harness([{ text: 'first answer' }]);
    await runGatewayHarnessTurn(first.input);
    const second = harness([{ text: 'second answer' }], { sessionId: first.input.sessionId, prompt: 'follow up' });
    await runGatewayHarnessTurn(second.input);
    expect(second.client.requests[0].items).toEqual([
      { type: 'text', role: 'user', text: expect.stringMatching(/^<environment>\nDate: [\d-]+\n[\s\S]*<\/environment>\n\ndo the thing$/) },
      { type: 'text', role: 'assistant', text: 'first answer' },
      // Same day, so no second note: the first one still holds.
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
    const raw = await fs.readFile(path.join(stateDir, 'sessions', h.input.sessionId, 'harness.jsonl'), 'utf8');
    const history = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; item?: { type: string; output?: string } })
      .flatMap((entry) => entry.kind === 'item' && entry.item ? [entry.item] : []);
    expect(history.filter((item) => item.type === 'tool_result')).toHaveLength(4);
    expect(history.every((item) => item.type !== 'tool_result' || !/elided/.test(item.output))).toBe(true);
  });

  describe('a model step that fails before saying anything', () => {
    const gatewayError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`gateway: ${code}`), { code, kind: 'other', retryAfter: 0, ...extra });

    it('is sent again on a transient failure, and the turn completes', async () => {
      const phases: string[] = [];
      const h = harness([{ error: gatewayError('MODEL_ERROR') }, { error: gatewayError('incomplete_stream') }, { text: 'PONG' }], { onPhase: (phase) => phases.push(phase) });
      const result = await runGatewayHarnessTurn(h.input);
      expect(result).toMatchObject({ text: 'PONG', stopReason: 'completed' });
      expect(h.client.requests).toHaveLength(3);
      expect(phases.filter((phase) => phase.startsWith('retrying'))).toEqual(['retrying in 0s', 'retrying in 0s']);
    });

    it('gives up after two retries and reports the failure', async () => {
      const h = harness([], {}, { error: gatewayError('MODEL_RATE_LIMITED') });
      const result = await runGatewayHarnessTurn(h.input);
      expect(result).toMatchObject({ isError: true, stopReason: 'model-error', text: 'gateway: MODEL_RATE_LIMITED' });
      expect(h.client.requests).toHaveLength(3);
    });

    it('is never resent once text has streamed', async () => {
      const h = harness([{ before: (request) => request.onTextDelta('Half an ans'), error: gatewayError('MODEL_ERROR') }, { text: 'never asked' }]);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result.isError).toBe(true);
      expect(h.client.requests).toHaveLength(1);
    });

    it('is the answer when the failure is about the account, not the moment', async () => {
      for (const code of ['AI_CREDIT_EXHAUSTED', 'NO_MODEL_AVAILABLE', 'VALIDATION_ERROR', 'CLIKCODE_DISABLED', 'MODEL_REJECTED_REQUEST']) {
        const h = harness([{ error: gatewayError(code) }, { text: 'never asked' }]);
        expect((await runGatewayHarnessTurn(h.input)).isError, code).toBe(true);
        expect(h.client.requests, code).toHaveLength(1);
      }
    });

    it('compacts and resends when the conversation no longer fits the model', async () => {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha\n');
      const phases: string[] = [];
      const read = (id: string) => ({ toolCalls: [{ id, name: 'read_file', args: { path: 'a.txt' } }] });
      const h = harness([
        read('r1'), read('r2'), read('r3'), read('r4'), read('r5'), read('r6'), read('r7'), read('r8'),
        { error: gatewayError('CONTEXT_TOO_LARGE') },
        (request) => (request.tools.length === 0 ? { text: 'SUMMARY: read a.txt eight times' } : { text: 'done' }),
      ], { onPhase: (phase) => phases.push(phase) }, { text: 'done' });
      const result = await runGatewayHarnessTurn(h.input);
      expect(result).toMatchObject({ text: 'done', stopReason: 'completed' });
      expect(phases).toContain('compacting context');
      const resent = h.client.requests.at(-1)!;
      expect(resent.items.some((item) => item.type === 'summary' || (item.type === 'tool_result' && /elided/.test(item.output)))).toBe(true);
    });
  });
});

