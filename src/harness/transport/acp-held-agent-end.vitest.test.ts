/** The last agents of a parallel batch often end together: the vendor drops them from its task level a moment before
 * their `task_notification`, and may resolve the user's prompt in that gap on an interim "still running" answer. The
 * agents are still held, and the vendor's follow-up (its answer once they report) must land in a background turn --
 * not leak into the user's next turn, with the worker shown idle in between. */
import { expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { VendorBackgroundTurn } from './background-turn.js';

const agent = (): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  const say = (text) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      frame({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'call-a', task_type: 'local_agent', description: 'audit', is_backgrounded: true });
      frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', status: 'running', description: 'audit' }] });
      setTimeout(() => {
        frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        say('one agent still running');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }, 100);
      setTimeout(() => {
        frame({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'call-a', status: 'completed', summary: 'done' });
        say('COLLECTED 2');
        frame({ type: 'result', subtype: 'success' });
      }, 900);
    }
  } });
`;

it('keeps a held agent past the prompt and gives the vendor follow-up its own background turn', async () => {
  const turns: VendorBackgroundTurn[] = [];
  const session = createAcpSession({ commandWatchMs: 200, backgroundTurns: (turn) => turns.push(turn) });
  try {
    await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', agent()], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
    expect(turns).toHaveLength(1);
    expect(await session.backgroundWorkRunning()).toBe(true);
    turns[0]!.attach({});
    const done = await turns[0]!.finished;
    expect(done.text).toContain('COLLECTED 2');
    expect(await session.backgroundWorkRunning()).toBe(false);
  } finally { await session.close(); }
}, 20_000);

const twoAgents = (): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      for (const [task, call] of [['a1', 'call-a'], ['a2', 'call-b']]) frame({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: call, task_type: 'local_agent', description: task, is_backgrounded: true });
      setTimeout(() => { say('two agents running'); send({ id: m.id, result: { stopReason: 'end_turn' } }); }, 100);
      setTimeout(() => {
        frame({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'call-a', status: 'completed', summary: 'done' });
        say('a1 back, a2 still running');
        update({ sessionUpdate: 'usage_update', used: 1000, size: 200000 });
        frame({ type: 'result', subtype: 'success' });
      }, 400);
      setTimeout(() => {
        frame({ type: 'system', subtype: 'task_notification', task_id: 'a2', tool_use_id: 'call-b', status: 'completed', summary: 'done' });
        say('COLLECTED 2');
        update({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
        frame({ type: 'result', subtype: 'success' });
      }, 1200);
    }
  } });
`;

it('a usage update after one agent reports does not end the background turn while another is still held', async () => {
  const turns: VendorBackgroundTurn[] = [];
  const session = createAcpSession({ commandWatchMs: 200, backgroundTurns: (turn) => turns.push(turn) });
  try {
    await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', twoAgents()], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
    expect(turns).toHaveLength(1);
    turns[0]!.attach({});
    const done = await turns[0]!.finished;
    expect(done.text).toContain('a1 back');
    expect(done.text).toContain('COLLECTED 2');
  } finally { await session.close(); }
}, 20_000);

/** The last agent reports while the vendor's model call is already answering the one before it: the prompt resolves
 * on that answer, and the vendor answers the report in a turn of its own a moment later. The CLI stays `running`
 * until it has. */
const reportInPrompt = (followUp: boolean): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  const say = (text) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      frame({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      frame({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'call-a', task_type: 'local_agent', description: 'audit', is_backgrounded: true });
      setTimeout(() => {
        frame({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'call-a', status: 'completed', summary: 'done' });
        say(${followUp ? "'one agent still running'" : "'COLLECTED 1'"});
        frame({ type: 'result', subtype: 'success' });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }, 100);
      setTimeout(() => {
        ${followUp ? "say('COLLECTED 1'); frame({ type: 'result', subtype: 'success' });" : ''}
        frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      }, 600);
    }
  } });
`;

it('an agent that reports as the prompt resolves keeps a background turn for the vendor answer still to come', async () => {
  const turns: VendorBackgroundTurn[] = [];
  const session = createAcpSession({ commandWatchMs: 200, orphanedToolMs: 60_000, backgroundTurns: (turn) => turns.push(turn) });
  try {
    const result = await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', reportInPrompt(true)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
    expect(result.text).not.toContain('COLLECTED');
    expect(turns).toHaveLength(1);
    turns[0]!.attach({});
    const done = await turns[0]!.finished;
    expect(done.text).toContain('COLLECTED 1');
  } finally { await session.close(); }
}, 20_000);

it('a vendor that answered the report in the prompt lets the background turn go at its idle', async () => {
  const turns: VendorBackgroundTurn[] = [];
  const session = createAcpSession({ commandWatchMs: 200, orphanedToolMs: 60_000, backgroundTurns: (turn) => turns.push(turn) });
  try {
    const result = await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', reportInPrompt(false)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
    expect(result.text).toContain('COLLECTED 1');
    const started = Date.now();
    if (turns.length) { turns[0]!.attach({}); await turns[0]!.finished; }
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally { await session.close(); }
}, 20_000);

/** Opus, 2026-11-24 (4 of 10 audits): the last agent's notification lands just after the prompt resolved, the
 * prompt's own end-of-turn bookkeeping and \`result\` trail it, and the vendor writes its answer ~1s later. The
 * trailing frames are not that answer's end. */
const staleAfterLastReport = (): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      frame({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      frame({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'call-a', task_type: 'local_agent', description: 'audit', is_backgrounded: true });
      setTimeout(() => {
        say('waiting on the last one');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
        frame({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'call-a', status: 'completed', summary: 'done' });
        update({ sessionUpdate: 'usage_update', used: 1000, size: 200000 });
        frame({ type: 'result', subtype: 'success' });
      }, 100);
      setTimeout(() => {
        say('COLLECTED 1');
        update({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
        frame({ type: 'result', subtype: 'success' });
        frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      }, 900);
    }
  } });
`;

it('stale bookkeeping and result after the last report do not end the background turn before the vendor answers it', async () => {
  const turns: VendorBackgroundTurn[] = [];
  const session = createAcpSession({ commandWatchMs: 200, orphanedToolMs: 60_000, backgroundTurns: (turn) => turns.push(turn) });
  try {
    const result = await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', staleAfterLastReport()], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
    expect(result.text).not.toContain('COLLECTED');
    expect(turns).toHaveLength(1);
    turns[0]!.attach({});
    const started = Date.now();
    const done = await turns[0]!.finished;
    expect(done.text).toContain('COLLECTED 1');
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally { await session.close(); }
}, 20_000);
