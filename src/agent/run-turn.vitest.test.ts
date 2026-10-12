import { changed } from './line-diff.test-support.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { ConversationStore } from './conversation.js';
import { retryDelaySeconds, runGatewayHarnessTurn, stepRecovery } from './run-turn.js';
import { MAX_REQUEST_ITEMS } from './context.js';
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

  it('settles a step\'s reasoning once, at its place: nothing re-opens it below the answer', async () => {
    const order: string[] = [];
    const h = harness([{
      before: (request) => {
        request.onReasoningDelta?.('Weighing the options. ');
        request.onReasoningDelta?.('Choosing the first.');
        request.onTextDelta('The answer.');
      },
      text: 'The answer.',
    }], {
      onActivity: (event) => { if (event.kind === 'thinking') order.push(`thinking:${event.id}`); },
      onResponseDelta: (text) => { order.push(`text:${text}`); },
    });
    await runGatewayHarnessTurn(h.input);
    const firstText = order.findIndex((item) => item.startsWith('text:'));
    // Every reasoning frame of the item came before the answer's first word,
    // and under one id (a client merges them into one row).
    expect(order.slice(firstText).filter((item) => item.startsWith('thinking:'))).toEqual([]);
    expect(new Set(order.filter((item) => item.startsWith('thinking:'))).size).toBe(1);
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

  it('classifies its rows the way every harness\'s are: grep is a search', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'needle\n');
    const h = harness([{ toolCalls: [{ id: 'g', name: 'grep', args: { pattern: 'needle' } }, { id: 'r', name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn(h.input);
    const started = (id: string) => h.events.find((event) => event.kind === 'tool-start' && event.id === id);
    expect([started('g')?.category, started('r')?.category]).toEqual(['search', 'read']);
  });

  it('reports a command\'s exit code and how long each call ran', async () => {
    const h = harness([{ toolCalls: [{ id: 'x', name: 'bash', args: { command: 'exit 3' } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn(h.input);
    const done = h.events.find((event) => event.kind === 'tool-error' && event.id === 'x');
    expect(done).toMatchObject({ label: '$ exit 3', category: 'run', exitCode: 3 });
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tells the model an empty path is a mistake in the call to correct, not a permission it lacks', async () => {
    const h = harness([{ toolCalls: [{ name: 'read_file', args: { path: '' } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn(h.input);
    const result = h.client.requests[1].items.at(-1);
    const output = result?.type === 'tool_result' ? result.output : '';
    expect(output).toMatch(/^Invalid arguments: A non-empty path is required\. Correct the call and try again\./);
    expect(output).not.toMatch(/Permission denied|Do not retry/);
    // A real refusal still says so.
    const denied = harness([{ toolCalls: [{ name: 'read_file', args: { path: '~/.ssh/id_rsa' } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn(denied.input);
    const refused = denied.client.requests[1].items.at(-1);
    expect(refused?.type === 'tool_result' && refused.output).toMatch(/^Permission denied/);
  });

  it('is not cut off by a step count: a long run of distinct work finishes on its own', async () => {
    const h = harness([], {}, (_request, index) => index < 89
      ? { toolCalls: [{ name: 'list_dir', args: { path: '.' }, id: `walk${index}` }] }
      : { text: 'All ninety steps done.' });
    const result = await runGatewayHarnessTurn(h.input);
    expect(result).toMatchObject({ steps: 90, stopReason: 'completed', text: 'All ninety steps done.' });
  });

  it('detects no progress: tells the model after 3 identical failures with nothing changed, then stops', async () => {
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
    expect(notice.type === 'text' && notice.text).toMatch(/failed 3 times in a row with identical arguments and nothing changed/);
    // The tool call the model tried to sneak into the final reply never ran.
    expect(h.events.filter((event) => event.kind === 'tool-start')).toHaveLength(3);
  });

  it('is not a stall when work happened between the failures: edit, rerun, edit, rerun is the normal loop', async () => {
    const failing = { name: 'read_file', args: { path: 'out.txt' } };
    const write = (n: number) => ({ name: 'write_file', args: { path: `fix${n}.txt`, content: `${n}\n` } });
    const h = harness([
      { toolCalls: [failing] }, { toolCalls: [failing] }, { toolCalls: [write(1)] },
      { toolCalls: [failing] }, { toolCalls: [failing] }, { toolCalls: [write(2)] },
      { toolCalls: [failing] }, { text: 'Done after three rounds.' },
    ]);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result).toMatchObject({ stopReason: 'completed', text: 'Done after three rounds.' });
    expect(h.events.filter((event) => event.kind === 'tool-start')).toHaveLength(7);
    expect(h.client.requests.every((request) => request.toolChoice !== 'none')).toBe(true);
  });

  it('a successful read forgets only its own failures', async () => {
    await fs.writeFile(path.join(cwd, 'ok.txt'), 'fine\n');
    const missing = { name: 'read_file', args: { path: 'missing.txt' } };
    const present = { name: 'read_file', args: { path: 'ok.txt' } };
    const h = harness([
      { toolCalls: [missing] }, { toolCalls: [present] }, { toolCalls: [missing] }, { toolCalls: [present] }, { toolCalls: [missing] },
      { text: 'Still failing.', toolCalls: [missing] },
    ]);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result).toMatchObject({ stopReason: 'no-progress' });
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

  it('asks for a client before each step and uses the one it is given', async () => {
    const next = new ScriptedModelClient([{ text: 'next account' }]);
    let calls = 0;
    const h = harness(
      [{ toolCalls: [{ name: 'list_dir', args: {} }] }],
      { modelClientForStep: async () => (++calls === 1 ? undefined : next) },
    );
    const result = await runGatewayHarnessTurn(h.input);
    expect(h.client.requests).toHaveLength(1);
    expect(next.requests).toHaveLength(1);
    expect(result.text).toBe('next account');
    expect(result.stopReason).toBe('completed');
  });

  it('stops before the next step when the step says the account left this route', async () => {
    let calls = 0;
    const h = harness(
      [{ toolCalls: [{ name: 'list_dir', args: {} }] }, { text: 'never' }],
      { modelClientForStep: async () => (++calls === 1 ? undefined : 'switch') },
    );
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('account-switch');
    expect(result.steps).toBe(1);
    expect(h.client.requests).toHaveLength(1);
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

    // An approver that answers no (a script's, or the user's): the model is told the action was not
    // approved -- never that "the user declined" when nobody was asked -- and the file is not written.
    const refused = harness([{ toolCalls: [write] }, { text: 'ok' }], { permissionMode: 'ask', onApproval: async () => false });
    await runGatewayHarnessTurn(refused.input);
    const notApproved = refused.client.requests[1].items.at(-1);
    expect(notApproved?.type === 'tool_result' && notApproved.output).toMatch(/not approved.*no one was available/);
    await expect(fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).rejects.toThrow();

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

  it('tells a Notification hook when it asks for approval and when it ends on a question', async () => {
    const notes: Array<{ message: string; notificationType: string; sessionId: string }> = [];
    const notification = async (info: { message: string; notificationType: string; sessionId: string }) => { notes.push(info); };
    const approving = harness([{ toolCalls: [{ name: 'write_file', args: { path: 'n.txt', content: 'x' } }] }, { text: 'ok' }], {
      permissionMode: 'ask', onApproval: async () => true, hooks: { notification },
    });
    await runGatewayHarnessTurn(approving.input);
    expect(notes).toEqual([{ sessionId: approving.input.sessionId, cwd, message: 'ClikCode needs your permission to use Write', notificationType: 'permission_prompt' }]);
    notes.length = 0;
    const asking = harness([{ toolCalls: [{ name: 'ask_user', args: { question: 'Which database?' } }] }], { hooks: { notification } });
    await runGatewayHarnessTurn(asking.input);
    expect(notes).toMatchObject([{ notificationType: 'idle_prompt', message: expect.stringContaining('Which database?') }]);
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

  it("does not compact a long history that fits the window the model client reports", async () => {
    // ~250k tokens already in the conversation (a switch onto a Gateway model seeds it): past the
    // 128k default's threshold, well inside the 1M window this client reports.
    const phases: string[] = [];
    const h = harness([{ text: 'answered' }], { onPhase: (phase) => phases.push(phase) });
    Object.assign(h.client, { contextHints: { contextWindow: 1_000_000 } });
    const store = path.join(stateDir, 'sessions', h.input.sessionId);
    await fs.mkdir(store, { recursive: true });
    const turn = 'x'.repeat(10_000);
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ kind: 'item', at: '2026-10-10T00:00:00.000Z', item: { type: 'text', role: i % 2 ? 'assistant' : 'user', text: turn } }));
    await fs.writeFile(path.join(store, 'harness.jsonl'), `${lines.join('\n')}\n`);
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('completed');
    expect(phases).not.toContain('compacting context');
    expect(h.client.requests).toHaveLength(1);
  });

  describe('a long conversation of small items', () => {
    // Tokens are nowhere near the window; only the entry count is. Eliding old results shortens
    // items without removing them, so the Gateway's bound on a request's item count is reached by
    // item count alone unless the loop summarizes on it.
    const seed = async (h: Harness, count: number) => {
      const store = path.join(stateDir, 'sessions', h.input.sessionId);
      await fs.mkdir(store, { recursive: true });
      const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ kind: 'item', at: '2026-10-10T00:00:00.000Z', item: { type: 'text', role: i % 2 ? 'assistant' : 'user', text: `m${i}` } }));
      await fs.writeFile(path.join(store, 'harness.jsonl'), `${lines.join('\n')}\n`);
    };

    it(`is summarized once it passes ${MAX_REQUEST_ITEMS} items, so no request nears the Gateway's bound`, async () => {
      const phases: string[] = [];
      const h = harness([], { onPhase: (phase) => phases.push(phase) }, (request) => (request.tools.length === 0 ? { text: 'SUMMARY of the long history' } : { text: 'answered' }));
      Object.assign(h.client, { contextHints: { contextWindow: 1_000_000 } });
      await seed(h, MAX_REQUEST_ITEMS + 100);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result.stopReason).toBe('completed');
      expect(phases).toContain('compacting context');
      const real = h.client.requests.find((request) => request.tools.length > 0)!;
      expect(real.items.length).toBeLessThan(50);
      expect(real.items.some((item) => item.type === 'summary')).toBe(true);
    });

    it('is left alone below that count', async () => {
      const phases: string[] = [];
      const h = harness([{ text: 'answered' }], { onPhase: (phase) => phases.push(phase) });
      Object.assign(h.client, { contextHints: { contextWindow: 1_000_000 } });
      await seed(h, MAX_REQUEST_ITEMS - 100);
      await runGatewayHarnessTurn(h.input);
      expect(phases).not.toContain('compacting context');
      expect(h.client.requests).toHaveLength(1);
    });
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
    ], {
      onPhase: (phase) => phases.push(phase),
      hooks: { preCompact: async ({ trigger }) => { phases.push(`PreCompact ${trigger}`); } },
    }, { text: 'finished' });
    const result = await runGatewayHarnessTurn(h.input);
    expect(result.stopReason).toBe('completed');
    expect(phases).toContain('compacting context');
    expect(phases[phases.indexOf('compacting context') + 1]).toBe('PreCompact auto');
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

    // The backoff runs on the real timers in production; here the clock is driven and the jitter fixed
    // (0.5 is the middle of it), so each wait is exactly the backoff's step.
    const driven = async <T,>(work: Promise<T>): Promise<T> => {
      let settled = false;
      void work.then(() => { settled = true; }, () => { settled = true; });
      // Time moves only when the turn is actually waiting on a timer; otherwise real file I/O gets the turn.
      // Advancing blindly outran that I/O on a busy machine.
      for (let guard = 0; !settled && guard < 500_000; guard++) {
        if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1000);
        else await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return work;
    };
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(Math, 'random').mockReturnValue(0.5); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('is sent again on a transient failure, with a growing wait, and the turn completes', async () => {
      const phases: string[] = [];
      const h = harness([{ error: gatewayError('MODEL_ERROR') }, { error: gatewayError('incomplete_stream') }, { text: 'PONG' }], { onPhase: (phase) => phases.push(phase) });
      const result = await driven(runGatewayHarnessTurn(h.input));
      expect(result).toMatchObject({ text: 'PONG', stopReason: 'completed' });
      expect(h.client.requests).toHaveLength(3);
      expect(phases.filter((phase) => phase.startsWith('retrying'))).toEqual(['retrying in 1s', 'retrying in 2s']);
    });

    it('keeps retrying for the whole patience budget, then reports the failure', async () => {
      const phases: string[] = [];
      const h = harness([], { onPhase: (phase) => phases.push(phase) }, { error: gatewayError('MODEL_RATE_LIMITED') });
      const result = await driven(runGatewayHarnessTurn(h.input));
      expect(result).toMatchObject({ isError: true, stopReason: 'model-error', text: 'gateway: MODEL_RATE_LIMITED' });
      const waits = phases.filter((phase) => phase.startsWith('retrying')).map((phase) => Number(/in (\d+)s/.exec(phase)?.[1]));
      expect(waits.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 30, 30]);
      expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(300);
      expect(h.client.requests).toHaveLength(waits.length + 1);
    });

    it('honours a longer Retry-After than the backoff, and never a shorter one than the backoff', async () => {
      const phases: string[] = [];
      const h = harness([{ error: gatewayError('MODEL_ERROR', { retryAfter: 20 }) }, { error: gatewayError('MODEL_ERROR', { retryAfter: 0 }) }, { text: 'ok' }], { onPhase: (phase) => phases.push(phase) });
      await driven(runGatewayHarnessTurn(h.input));
      expect(phases.filter((phase) => phase.startsWith('retrying'))).toEqual(['retrying in 20s', 'retrying in 2s']);
    });

    it('stops waiting the moment the turn is cancelled', async () => {
      const controller = new AbortController();
      const h = harness([], { signal: controller.signal }, { error: gatewayError('MODEL_ERROR') });
      const turn = runGatewayHarnessTurn(h.input);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(turn).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    });

    it('retryDelaySeconds: backoff 1, 2, 4 ... capped at 30, jittered within 20%, and a server hint is a floor', () => {
      expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => retryDelaySeconds(attempt, undefined, () => 0.5))).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
      expect(retryDelaySeconds(3, undefined, () => 0)).toBeCloseTo(3.2);
      expect(retryDelaySeconds(3, undefined, () => 1)).toBeCloseTo(4.8);
      expect(retryDelaySeconds(1, 45, () => 0.5)).toBe(45);
      expect(retryDelaySeconds(1, 9999, () => 0.5)).toBe(120);
      expect(retryDelaySeconds(2, 0, () => 0.5)).toBe(2);
    });

    it('treats the Gateway\'s item-count refusal as a reason to compact, not as the answer', () => {
      const refusal = Object.assign(new Error('Invalid request at items: items exceeds 2000 entries'), { statusCode: 400 });
      expect(stepRecovery(refusal)).toBe('compact');
      expect(stepRecovery(Object.assign(new Error('Invalid request at tools: bad schema'), { statusCode: 400 }))).toBeUndefined();
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

  describe('what a Gateway model streams, shown as a vendor CLI shows it', () => {
    it('opens a call\'s row while the call is written, named once its path has arrived', async () => {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n');
      const h = harness([
        {
          before: (request) => {
            request.onToolCallDelta?.({ id: 'c1', name: 'read_file', arguments: '' });
            request.onToolCallDelta?.({ id: 'c1', name: 'read_file', arguments: '{"path":"a.t' });
            request.onToolCallDelta?.({ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"' });
          },
          toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
        },
        { text: 'Done.' },
      ]);
      await runGatewayHarnessTurn(h.input);
      expect(h.events.map((event) => `${event.kind}:${event.id}:${event.label}`)).toEqual([
        'tool-start:c1:Read', 'tool-start:c1:Read a.txt', 'tool-done:c1:Read a.txt',
      ]);
      expect(h.events[0]!.category).toBe('read');
    });

    it('settles the row of a call that never ran when its step fails and is sent again', async () => {
      const failure = Object.assign(new Error('cut'), { code: 'incomplete_stream', kind: 'other', retryAfter: 0 });
      const h = harness([
        { before: (request) => request.onToolCallDelta?.({ id: 'lost', name: 'list_dir', arguments: '{"pa' }), error: failure },
        { text: 'PONG' },
      ]);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result.text).toBe('PONG');
      expect(h.events.filter((event) => event.id === 'lost').map((event) => event.kind)).toEqual(['tool-start', 'tool-error']);
    });

    it('carries on an answer cut off at the output limit, in the same paragraph', async () => {
      const h = harness([{ text: 'The answer begins and is cu', stopReason: 'length' }, { text: 't off no more.' }]);
      const result = await runGatewayHarnessTurn(h.input);
      expect(result).toMatchObject({ text: 'The answer begins and is cut off no more.', stopReason: 'completed', steps: 2 });
      expect(h.deltas.join('')).toBe('The answer begins and is cut off no more.');
      expect(h.client.requests[1]!.items.at(-1)).toMatchObject({ type: 'text', role: 'user', text: expect.stringMatching(/output limit/) });
    });

    it('stops carrying on after three cut-off replies and says the answer was cut', async () => {
      const usage: { stopReason?: string }[] = [];
      const h = harness([], { onUsage: (report) => usage.push(report) }, { text: 'more', stopReason: 'length' });
      const result = await runGatewayHarnessTurn(h.input);
      expect(h.client.requests).toHaveLength(4);
      expect(result.stopReason).toBe('completed');
      expect(usage.at(-1)?.stopReason).toBe('length');
    });

    it('tells the model a call cut off mid-arguments was cut by the output limit', async () => {
      const h = harness([
        { toolCalls: [{ id: 'w', name: 'write_file', args: {}, argumentsError: 'Unexpected end of JSON input' }], stopReason: 'length' },
        { text: 'ok' },
      ]);
      await runGatewayHarnessTurn(h.input);
      const answer = h.client.requests[1]!.items.find((item) => item.type === 'tool_result');
      expect(answer).toMatchObject({ isError: true, output: expect.stringMatching(/reached the output limit/) });
    });

    it('names the model that answers before its first word', async () => {
      const seen: string[] = [];
      const h = harness([{ servedModel: 'glm-5', contextWindow: 200_000, text: 'hi', before: () => { seen.push('step'); } }], {
        onUsage: (report) => seen.push(`usage ${report.servedModel} ${report.contextWindow}`),
        onResponseDelta: (text) => seen.push(`text ${text}`),
      });
      await runGatewayHarnessTurn(h.input);
      expect(seen.slice(0, 3)).toEqual(['step', 'usage glm-5 200000', 'text hi']);
    });
  });
});

