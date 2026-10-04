/** A message typed during a Claude Code (ACP) turn reaches the model without
 * interrupting anything: claude-agent-acp 0.84 injects `_session/steering` at
 * once, which cancels a tool call in flight (verified live: "[Request
 * interrupted by user for tool use]"), so ClikCode holds the message until no
 * call of the turn is open -- a sub-agent's for its whole run -- and nobody is
 * being asked for approval. Driven by a real child speaking ACP that records
 * when each steer arrives against its open calls. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { LiveTurnInputBroker, type LiveTurnInputResult } from '../../turn/live-input.js';
import type { HarnessActivityEvent } from '../prompter.js';

const agent = (log: string, mode: string, steering = true) => `
  const fs = require('node:fs');
  const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  const open = new Set();
  const start = (id, title, parent) => { open.add(id); log('open ' + id); update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'in_progress', ...(parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {}) }); };
  const close = (id, parent) => { open.delete(id); log('close ' + id); update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...(parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {}) }); };
  const later = (ms, fn) => setTimeout(fn, ms);
  let prompt; let steered = []; let finish;
  const end = () => { if (!prompt) return; const id = prompt; prompt = undefined; clearTimeout(finish);
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steered.length ? 'Answered: ' + steered.join(' | ') : 'Done.' } });
    log('end'); send({ id, result: { stopReason: 'end_turn' } }); };
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, ...(${steering} ? { _meta: { steering: { supported: true } } } : {}) } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === '_session/steering') {
      const text = m.params.prompt[0].text;
      log('steer ' + text + (open.size ? ' INTERRUPTING ' + [...open].join(',') : '') + ' idle=' + m.params._meta?.steering?.idleBehavior);
      if (${JSON.stringify(mode)} === 'promptRequired') { send({ id: m.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } }); continue; }
      steered.push(text);
      send({ id: m.id, result: { outcome: 'injected' } });
      later(50, end);
    }
    else if (m.method === 'session/prompt') {
      prompt = m.id; log('prompt');
      finish = later(1500, end);
      const mode = ${JSON.stringify(mode)};
      if (mode === 'subagent' || mode === 'promptRequired') {
        // A sub-agent: its Agent call is open for its whole run, its own calls inside it.
        start('agent1', 'Explore the repo');
        later(150, () => start('child1', 'Read a.ts', 'agent1'));
        later(400, () => close('child1', 'agent1'));
        later(500, () => start('child2', 'Read b.ts', 'agent1'));
        later(700, () => close('child2', 'agent1'));
        later(800, () => close('agent1'));
      } else if (mode === 'never-closes') {
        start('bash1', 'sleep 600');
        clearTimeout(finish); finish = later(500, end);
      } else if (mode === 'permission') {
        log('ask p1');
        send({ id: 900, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'p1', title: 'Write a.ts', kind: 'edit' },
          options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
      } else if (mode === 'idle') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Thinking out loud. ' } });
      }
    }
    else if (m.id === 900) {
      log('answered ' + m.result?.outcome?.optionId);
      start('p1', 'Write a.ts');
      later(200, () => close('p1'));
    }
  } });
`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acp-steering-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** One turn with a broker wired the way runVendorSessionAttempt wires it,
 * and the message typed when `typeAt` first sees an event. */
async function turnWithMessage(mode: string, options: {
  typeAt: (event: HarnessActivityEvent) => boolean;
  approve?: (resolve: (answer: boolean) => void) => void;
  steering?: boolean;
  typeAtStart?: boolean;
}) {
  const log = join(dir, 'log');
  const broker = new LiveTurnInputBroker({ steerTimeoutMs: 100 });
  const queue: string[] = [];
  const queuedHeld: boolean[] = [];
  let unqueued = 0;
  broker.bindQueue(async (submission, queueOptions) => { queue.push(submission.id); queuedHeld.push(queueOptions?.held === true); });
  broker.setLateSteerHandler((submission) => { unqueued++; queue.splice(queue.indexOf(submission.id), 1); });
  let typed: Promise<LiveTurnInputResult> | undefined;
  let answer = '';
  const type = () => { typed ??= broker.submit('also check c.ts', 'm1'); };
  const session = createAcpSession();
  let stopReason: unknown;
  try {
    const result = await session.runTurn({
      binary: process.execPath, command: 'claude', argv: ['-e', agent(log, mode, options.steering)], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask',
      onSteerReady: (handler) => {
        broker.setSteerHandler(handler ? (text, _submission, hold) => handler(text, hold) : undefined);
        if (handler && options.typeAtStart) type();
      },
      onActivity: (event) => { if (options.typeAt(event)) type(); },
      onResponseDelta: (delta) => { answer += delta; if (options.typeAt({ kind: 'thinking', label: delta })) type(); },
      onApproval: () => new Promise<boolean>((resolve) => {
        type();
        options.approve?.(resolve);
      }),
    });
    stopReason = result.stopReason;
  } finally {
    await broker.settled();
    await session.close();
  }
  const result = await typed;
  const landed = await result?.landed;
  return { log: readFileSync(log, 'utf8').trim().split('\n'), result, landed, queue, queuedHeld, unqueued, answer, stopReason };
}

describe('a message typed during an ACP turn that advertises steering', () => {
  it('waits out a sub-agent and its calls, then goes into the same turn, which is not stopped', async () => {
    const run = await turnWithMessage('subagent', { typeAt: (event) => event.kind === 'tool-start' && event.id === 'child1' });
    expect(run.log.filter((line) => line.startsWith('steer'))).toEqual(['steer also check c.ts idle=promptRequired']);
    // Never while anything was open: the sub-agent's whole run is one open call.
    const steerAt = run.log.findIndex((line) => line.startsWith('steer'));
    expect(steerAt).toBeGreaterThan(run.log.indexOf('close agent1'));
    expect(steerAt).toBeLessThan(run.log.indexOf('end'));
    // The turn ran to its end and answered the message.
    expect(run.log.filter((line) => line === 'prompt')).toHaveLength(1);
    expect(run.answer).toContain('Answered: also check c.ts');
    // Queued once as the fallback, then taken out when it landed: in the turn, not the queue.
    expect(run.result?.disposition).toBe('queued');
    expect(run.queuedHeld).toEqual([true]);
    expect(run.landed).toBe(true);
    expect(run.unqueued).toBe(1);
    expect(run.queue).toEqual([]);
  });

  it('runs as the next turn, once, when the turn ends with a call still open', async () => {
    const run = await turnWithMessage('never-closes', { typeAt: (event) => event.kind === 'tool-start' });
    expect(run.log.some((line) => line.startsWith('steer'))).toBe(false);
    expect(run.landed).toBe(false);
    expect(run.queue).toEqual(['m1']);
    expect(run.unqueued).toBe(0);
  });

  it('is queued when the agent says no turn is running (promptRequired), never sent twice', async () => {
    const run = await turnWithMessage('promptRequired', { typeAt: (event) => event.kind === 'tool-start' && event.id === 'child1' });
    expect(run.log.filter((line) => line.startsWith('steer'))).toHaveLength(1);
    expect(run.log.some((line) => line.includes('INTERRUPTING'))).toBe(false);
    expect(run.landed).toBe(false);
    expect(run.queue).toEqual(['m1']);
  });

  it('holds while the user is asked to approve a call, and while that call runs', async () => {
    const run = await turnWithMessage('permission', {
      typeAt: () => false,
      approve: (resolve) => setTimeout(() => resolve(true), 300),
    });
    expect(run.log.some((line) => line.includes('INTERRUPTING'))).toBe(false);
    const steerAt = run.log.findIndex((line) => line.startsWith('steer'));
    expect(steerAt).toBeGreaterThan(run.log.indexOf('close p1'));
    expect(run.landed).toBe(true);
    expect(run.queue).toEqual([]);
  });

  it('goes straight in when nothing is open', async () => {
    const run = await turnWithMessage('idle', { typeAt: (event) => event.kind === 'thinking' });
    expect(run.result?.disposition).toBe('steered');
    expect(run.queuedHeld).toEqual([]);
    expect(run.queue).toEqual([]);
    expect(run.answer).toContain('Answered: also check c.ts');
  });

  it('is not steered at all into an agent that does not advertise steering', async () => {
    const run = await turnWithMessage('idle', { typeAt: (event) => event.kind === 'thinking', steering: false, typeAtStart: false });
    expect(run.log.some((line) => line.startsWith('steer'))).toBe(false);
    expect(run.result?.disposition).toBe('queued');
    expect(run.queue).toEqual(['m1']);
  });
});
