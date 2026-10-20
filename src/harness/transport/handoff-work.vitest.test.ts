/** Work a vendor process runs past its turn, answered for by ClikCode: a conversation that moves to
 * another account or provider leaves the process to it (retire) instead of waiting on it or killing
 * it, and each piece's end -- a command's output, an agent cut off by the usage limit with its task --
 * is told to the conversation's account of the moment. Driven by a real child speaking ACP. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { agentResult, endsWithLimitRefusal, limitSentence, VendorTasks, type EndedWork } from './handoff-work.js';
import { formatEndedWork } from '../../worker/handed-off-work.js';

const LIMIT = "You've hit your session limit · resets 7:50am (America/Denver)";

describe('the vendor saying an account is out', () => {
  it('is read from an agent that stopped on it', () => {
    expect(limitSentence(`Agent "Open B5" failed: Agent terminated early due to an API error: ${LIMIT}`)).toBe(LIMIT);
    expect(limitSentence("You've hit your usage limit. Upgrade to Pro or try again at 10:35 AM.")).toMatch(/^You've hit your usage limit/);
    expect(limitSentence('Agent "Open B5" failed: the build broke')).toBeUndefined();
  });

  it('ends a reply only in the vendor\'s own form, reset time and all', () => {
    expect(endsWithLimitRefusal(`Only the games agent is still running.${LIMIT}`)).toBe(LIMIT);
    expect(endsWithLimitRefusal(`Done.\n\n${LIMIT}${LIMIT}\n`)).toBeDefined();
    // A model writing about limits, or quoting the refusal before going on, is not refused.
    expect(endsWithLimitRefusal("I raised the rate limit; you've hit your limit of patience, I know.")).toBeUndefined();
    expect(endsWithLimitRefusal(`The log said "${LIMIT}" and then the retry worked.`)).toBeUndefined();
  });
});

describe('Claude\'s background tasks', () => {
  it('keep a backgrounded agent with its task, and say how it ended', () => {
    const tasks = new VendorTasks();
    tasks.call('t1', { description: 'Open B5', prompt: 'Check the games endpoints', run_in_background: true });
    tasks.frame({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 't1', task_type: 'local_agent', description: 'Open B5', is_backgrounded: true });
    tasks.frame({ type: 'system', subtype: 'task_started', task_id: 'a2', tool_use_id: 't2', task_type: 'local_agent', description: 'inline', is_backgrounded: false });
    tasks.frame({ type: 'system', subtype: 'task_started', task_id: 'a3', task_type: 'local_bash', description: 'child', owned_by_subagent: true });
    expect(tasks.running()).toEqual([{ id: 'a1', kind: 'agent', label: 'Open B5', prompt: 'Check the games endpoints' }]);
    const ended = tasks.frame({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'failed', summary: LIMIT, output_file: '/tmp/a1.output' });
    expect(ended).toMatchObject({ work: { id: 'a1', prompt: 'Check the games endpoints' }, status: 'failed', summary: LIMIT, outputFile: '/tmp/a1.output' });
    expect(tasks.running().map((work) => work.id)).toEqual([]);
  });

  it('read an agent\'s answer from its transcript, not the API error after it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-agent-result-'));
    try {
      const file = join(dir, 'agent.jsonl');
      await writeFile(file, [
        { type: 'assistant', message: { model: 'sonnet', content: [{ type: 'text', text: 'All 12 endpoints answer.' }] } },
        { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] } },
      ].map((line) => JSON.stringify(line)).join('\n'));
      expect(await agentResult(file)).toBe('All 12 endpoints answer.');
      expect(await agentResult(join(dir, 'missing.jsonl'))).toBe('');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('what the conversation\'s account is told', () => {
  it('a result to use, or an agent\'s task to start again', () => {
    const text = formatEndedWork([
      { id: '41', kind: 'command', label: 'npm test', outcome: 'finished', tail: 'Tests 12 passed\n' },
      { id: 'a1', kind: 'agent', label: 'Open B5', prompt: 'Check the games endpoints', outcome: 'cut-off', tail: LIMIT, limit: LIMIT },
    ]);
    expect(text).toContain('[background command 41 finished] npm test\nTests 12 passed');
    expect(text).toContain(`[background agent a1 was cut off: ${LIMIT}] Open B5`);
    expect(text).toContain('Start it again here, with the same task:\nCheck the games endpoints');
  });
});

describe.skipIf(process.platform !== 'linux')('a process the conversation leaves with work running', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-handoff-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** An agent like claude-agent-acp: a prompt starts a background command (its output in a file,
   * as Claude's are) and a background agent, and answers at once. The agent later ends as `agentEnd`
   * says; then the vendor says something of its own. */
  const agent = (output: string, agentEnd: { status: string; summary: string }): string => `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const sdk = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        spawn('sh', ['-c', 'sleep 2; echo all checks passed'], { stdio: ['ignore', fs.openSync(${JSON.stringify(output)}, 'w'), 'ignore'] });
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Agent', kind: 'think', status: 'pending', rawInput: { description: 'Open B5', prompt: 'Check the games endpoints', run_in_background: true } } } });
        sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 't1', task_type: 'local_agent', description: 'Open B5', subagent_type: 'general-purpose', is_backgrounded: true });
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } });
        setTimeout(() => {
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }, 300);
        setTimeout(() => {
          sdk({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: ${JSON.stringify(agentEnd.status)}, summary: ${JSON.stringify(agentEnd.summary)}, output_file: '/nonexistent' });
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Following up on the agent.' } } } });
        }, 1200);
      }
    } });
  `;

  const open = (output: string, agentEnd: { status: string; summary: string }, ended: EndedWork[], said: string[]) => {
    const session = createAcpSession({
      workEnded: (work) => { ended.push(...work); },
      outOfTurn: (words) => { said.push(words.text); },
    });
    const turn = session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent(output, agentEnd)], cwd: process.cwd(), prompt: 'start the checks', environment: {}, permissionMode: 'ask',
    });
    return { session, turn };
  };

  it('keeps its work running, tells each end, says nothing into the conversation, and closes when empty', async () => {
    const output = join(dir, 'checks.output');
    const ended: EndedWork[] = [];
    const said: string[] = [];
    const { session, turn } = open(output, { status: 'failed', summary: `Agent terminated early due to an API error: ${LIMIT}` }, ended, said);
    try {
      expect((await turn).text).toBe('started');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
      expect(await session.retire()).toBe(true);
      expect(session.retiredWork).toEqual({ agents: 1, terminals: 1 });
      // The agent, cut off by the limit: its task comes with it, to be started again.
      await vi.waitFor(() => expect(ended.some((work) => work.kind === 'agent')).toBe(true), { timeout: 5_000 });
      expect(ended.find((work) => work.kind === 'agent')).toMatchObject({ id: 'a1', label: 'Open B5', prompt: 'Check the games endpoints', outcome: 'cut-off', limit: LIMIT });
      // The command ran on to its end, and its output is told.
      await vi.waitFor(() => expect(ended.some((work) => work.kind === 'command')).toBe(true), { timeout: 10_000 });
      expect(ended.find((work) => work.kind === 'command')).toMatchObject({ label: 'sleep 2; echo all checks passed', outcome: 'finished', outputFile: output });
      expect(ended.find((work) => work.kind === 'command')?.tail).toContain('all checks passed');
      // Its follow-up was not the conversation's.
      expect(said).toEqual([]);
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
      expect(session.retiredWork).toEqual({ agents: 0, terminals: 0 });
    } finally { await session.close(); }
  }, 30_000);

  it('in use, tells only an agent the usage limit cut off, and leaves the rest to the vendor', async () => {
    const ended: EndedWork[] = [];
    const said: string[] = [];
    const { session, turn } = open(join(dir, 'a.output'), { status: 'failed', summary: `Agent terminated early due to an API error: ${LIMIT}` }, ended, said);
    try {
      await turn;
      await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 5_000 });
      expect(ended[0]).toMatchObject({ kind: 'agent', outcome: 'cut-off', limit: LIMIT, prompt: 'Check the games endpoints' });
      // What it says of it is still the conversation's.
      await vi.waitFor(() => expect(said.join('')).toContain('Following up'), { timeout: 5_000 });
    } finally { await session.close(); }
  }, 20_000);

  it('in use, does not tell an agent that finished: the vendor answers it itself', async () => {
    const ended: EndedWork[] = [];
    const { session, turn } = open(join(dir, 'b.output'), { status: 'completed', summary: 'Agent "Open B5" completed' }, ended, []);
    try {
      await turn;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(ended).toEqual([]);
    } finally { await session.close(); }
  }, 20_000);
});
