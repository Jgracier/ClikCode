/** One contract for every transport: a conversation is live on account A with background work
 * running, and the vendor reports the work ended because A is out of usage, in that transport's own
 * frame shape. Whatever the transport, the conversation must end up the same way:
 *   - A is marked spent, exactly once (a second report of the same end changes nothing),
 *   - the conversation is on account B at once, not at its next turn,
 *   - the cut-off work is queued to be taken up again, with its task, for B,
 *   - the lifecycle log says so (`worker.work-ended`, `worker.switch`).
 *
 * The 2026-10-30 incident: three background agents of a Claude conversation over ACP died with
 * "You've hit your weekly limit" (error type rate_limit, HTTP 429). The conversation stayed on the
 * spent account and its next turn spent 139 s being refused by it. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';
import { createAmpStreamTurn } from '../harness/transport/native/amp-stream.js';
import { holdVendorProcess } from '../harness/transport/native/held-vendor.js';
import { createBackgroundWait, streamJsonUserMessage } from '../harness/transport/native/background-wait.js';
import { captureNativeHarnessTurn, createTurnInput, createTurnRelease } from '../harness/transport/native/turn.js';
import { createCodexSession } from '../harness/transport/codex-app-server.js';
import { createAcpSession } from '../harness/transport/acp-client.js';
import { reportStructuredLine } from '../harness/events/structured.js';
import { createStreamState } from '../harness/events/adapters.js';
import { createWorkEndedHandler } from '../worker/handed-off-work.js';
import type { WorkerContext } from '../worker/worker-context.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';

const logged = vi.hoisted(() => [] as Array<{ name: string; fields: Record<string, unknown> }>);
vi.mock('../runtime/lifecycle-log.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lifecycle-log.js')>(),
  lifecycle: (name: string, fields: Record<string, unknown> = {}) => { logged.push({ name, fields }); },
}));

const {
  TRANSPORT_SESSIONS, closePersistentTransport, leavePersistentTransport, persistentTransportFor, reportEndedWork, setWorkEndedHandler, vendorChildKey,
} = await import('./vendor-process.js');

const SESSION = 's1';
const LIMIT = "You've hit your weekly limit · resets 1pm (America/Denver)";
const TASK = 'Check the games endpoints';
const harness = { command: 'claude' } as AiLocalHarnessDefinition;
const account = (id: string): AiHarnessAccount => ({ id, provider: 'fake', label: id, status: 'ready', authKind: 'vendor-cli', models: [], credentialRef: 'native:fake' } as AiHarnessAccount);

let dir: string;
let notices: string[];
let told: EndedWork[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-ended-work-'));
  logged.length = 0;
  notices = [];
  told = [];
  const state = await readState();
  // A is nearly spent (1% left) and B has room: the figures the incident's account showed.
  state.accounts = [
    { ...account('acct-a'), usage: { at: new Date().toISOString(), windows: [{ name: 'weekly', usedPct: 99, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] } } as AiHarnessAccount,
    { ...account('acct-b'), usage: { at: new Date().toISOString(), windows: [{ name: 'weekly', usedPct: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] } } as AiHarnessAccount,
  ];
  state.sessions = [{
    id: SESSION, conversationId: SESSION, route: 'local', accountId: 'acct-a', provider: 'fake', model: 'm1', effort: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', workspace: dir, title: 't', name: 't', nameSource: 'user',
  } as HarnessSession];
  await writeState(state);
  // The worker's side, as the session worker registers it.
  const ctx = {
    sessionId: SESSION, turnRunning: false,
    io: { recordNotificationText: async (text: string) => { notices.push(text); }, broadcastQueueChanged: () => undefined },
    queue: { drainQueue: async () => undefined }, idle: { scheduleIdleExit: () => undefined },
  } as unknown as WorkerContext;
  const handler = createWorkEndedHandler(ctx);
  setWorkEndedHandler(SESSION, (ended, from) => { told.push(...ended); handler(ended, from); });
});

afterEach(async () => {
  setWorkEndedHandler(SESSION, undefined);
  TRANSPORT_SESSIONS.acp = createAcpSession;
  TRANSPORT_SESSIONS.codex = createCodexSession;
  await closePersistentTransport();
  await rm(dir, { recursive: true, force: true });
});

const count = (name: string): number => logged.filter((event) => event.name === name).length;

/** What every transport owes the conversation once the vendor said A's work ended on its usage limit. */
async function expectMovedToB(options: { reports?: number; task?: boolean } = {}): Promise<void> {
  // The transport told the conversation's ledger of the agent that ended...
  await vi.waitFor(() => expect(told.filter((work) => work.kind === 'agent')).toHaveLength(1), { timeout: 10_000 });
  // ... which marked A spent...
  await vi.waitFor(async () => {
    const stored = await readState({ transcripts: [] });
    expect(stored.accounts.find((item) => item.id === 'acct-a')?.quotaState).toBe('exhausted');
    // ... and moved the conversation to B now, not at its next turn.
    expect(stored.sessions.find((item) => item.id === SESSION)?.accountId).toBe('acct-b');
  }, { timeout: 10_000 });
  await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
  // The work is queued to be taken up again, with the task it was given.
  expect(notices[0]).toContain('was cut off');
  // ... with the task it was given, where the vendor said what it was.
  expect(notices[0]).toContain(options.task === false ? 'Use the recorded task description' : `Original task:\n${TASK}`);
  expect(count('worker.work-ended')).toBe(1);
  expect(count('worker.switch')).toBe(1);
  expect(logged.find((event) => event.name === 'worker.switch')?.fields).toMatchObject({ from: 'acct-a'.slice(0, 8), to: 'acct-b'.slice(0, 8), why: 'quota-exhausted' });
  // Once, however many times the end was reported.
  expect(count('worker.account-spent')).toBe(1);
  expect(options.reports ?? 1).toBeGreaterThan(0);
}

/** The claude-agent-acp process: a prompt launches a background Agent (task_started), answers, and
 * later the vendor frames `frames` arrive (each `[delayMs, message]`). */
const acpAgent = (frames: Array<[number, Record<string, unknown>]>): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const sdk = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Agent', kind: 'think', status: 'pending', rawInput: { description: 'Open B5', prompt: ${JSON.stringify(TASK)}, run_in_background: true } } } });
      sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 't1', task_type: 'local_agent', description: 'Open B5', subagent_type: 'general-purpose', is_backgrounded: true });
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } });
      setTimeout(() => {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }, 200);
      for (const [delay, message] of ${JSON.stringify(frames)}) setTimeout(() => sdk(message), delay);
    }
  } });
`;

/** A live ACP child for account A with `frames` to come. */
async function acpTurn(frames: Array<[number, Record<string, unknown>]>): Promise<void> {
  TRANSPORT_SESSIONS.acp = (options) => createAcpSession({ ...options, spawn: (_binary, _argv, spawnOptions) => spawn(process.execPath, ['-e', acpAgent(frames)], spawnOptions) });
  const key = vendorChildKey(harness, account('acct-a'), {}, dir);
  const child = persistentTransportFor(SESSION, 'acp', key);
  await (child.session as ReturnType<typeof createAcpSession>).runTurn({
    binary: process.execPath, command: 'fake', argv: [], cwd: dir, prompt: 'start the checks', environment: {}, permissionMode: 'ask',
  } as never);
}

const failedSummary = `Agent "Open B5" failed: Agent terminated early due to an API error: ${LIMIT} (error type rate_limit, HTTP 429, request id req_011Cf, model sent to the API: claude-sonnet-5-5)`;
/** The frames Claude sends for an agent that died: the terminal patch first, then the notification that says why. */
const FAILED: Array<[number, Record<string, unknown>]> = [
  [600, { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'failed', end_time: 1790548486403 } }],
  [620, { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'failed', summary: failedSummary, output_file: '/nonexistent' }],
];

describe('ACP (claude-agent-acp)', () => {
  it('moves a live conversation to B when its agent dies on the usage limit', async () => {
    await acpTurn(FAILED);
    await expectMovedToB();
  }, 30_000);

  it('does the same once for the end reported again', async () => {
    await acpTurn([...FAILED, [900, FAILED[1]![1]], [950, FAILED[0]![1]]]);
    await expectMovedToB({ reports: 3 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(count('worker.account-spent')).toBe(1);
    expect(notices).toHaveLength(1);
  }, 30_000);

  it('does the same when the end reaches ClikCode only through the agent\'s saved transcript', async () => {
    const transcript = join(dir, 'agent-a1.jsonl');
    await writeFile(transcript, [
      { type: 'assistant', message: { model: 'sonnet', content: [{ type: 'text', text: 'Half the endpoints checked.' }] } },
      { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] } },
    ].map((row) => JSON.stringify(row)).join('\n'));
    // The task is reported completed, with nothing of the limit in what it says.
    await acpTurn([[600, { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'completed', summary: 'Agent "Open B5" completed', output_file: transcript }]]);
    await expectMovedToB();
    expect(notices[0]).toContain('Half the endpoints checked.');
    expect(notices[0]).toContain(JSON.stringify(transcript));
  }, 30_000);

  it('does the same for a process the conversation already left', async () => {
    await acpTurn(FAILED);
    await leavePersistentTransport(SESSION);
    expect(count('vendor.retired')).toBe(1);
    await expectMovedToB();
  }, 30_000);
});

describe('structured CLI (Claude stream-json, held process)', () => {
  it('moves a live conversation to B when its agent dies on the usage limit', async () => {
    const records = [
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 't1', task_type: 'local_agent', description: 'Open B5', prompt: TASK, is_backgrounded: true },
      { type: 'result', subtype: 'success', is_error: false, result: 'started' },
    ];
    const tail = [
      { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'failed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'failed', summary: failedSummary, output_file: '/nonexistent' },
    ];
    const script = `const head = ${JSON.stringify(records.map((r) => JSON.stringify(r)))}, tail = ${JSON.stringify(tail.map((r) => JSON.stringify(r)))};
      let started = false; process.stdin.on('data', () => { if (started) return; started = true; head.forEach((l) => console.log(l)); setTimeout(() => tail.forEach((l) => console.log(l)), 300); });
      process.stdin.on('end', () => setTimeout(() => process.exit(0), 20)); process.stdin.resume();`;
    const input = createTurnInput();
    const release = createTurnRelease();
    const owner = { harness: 'claude', accountId: 'acct-a' };
    let held: ReturnType<typeof holdVendorProcess>;
    const background = createBackgroundWait({ onSettled: () => input.end(), onQuiet: () => held?.quiet() });
    const streams = new WeakMap<object, ReturnType<typeof createStreamState>>();
    await captureNativeHarnessTurn({ command: 'fixture', binary: process.execPath, displayName: 'Fixture' }, ['-e', script], {}, {
      stdinText: streamJsonUserMessage('go'), input, release,
      onStdoutLine: (line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (held) { held.line(line, record); return; }
        background.note(record);
        if (record.type === 'result' && background.pending > 0 && background.quiet) {
          held = holdVendorProcess({
            sessionId: SESSION, background, release, owner, endInput: () => input.end(), handler: () => undefined,
            workEnded: (ended) => reportEndedWork(SESSION, ended, owner),
            report: (text, observer, parsed) => reportStructuredLine({ command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition, text, observer, createStreamState(), parsed),
          });
        }
      },
    });
    void streams;
    await expectMovedToB();
  }, 30_000);
});

describe('Codex app-server', () => {
  /** A fake app-server: a sub-agent thread starts under the turn, the turn answers, and the sub-agent
   * thread then fails with the usage limit (`turn/completed` status failed with its `codexErrorInfo`). */
  const server = (): string => `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'U1' } } });
        send({ method: 'item/started', params: { threadId: 'T', turnId: 'U1', item: { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 'C', agentPath: '/root/check' } } });
        send({ method: 'turn/started', params: { threadId: 'C', turn: { id: 'CU1', status: 'inProgress' } } });
        setTimeout(() => {
          send({ method: 'item/completed', params: { threadId: 'T', turnId: 'U1', item: { type: 'agentMessage', id: 'm1', text: 'started' } } });
          send({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U1', status: 'completed' } } });
        }, 200);
        setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'C', turn: { id: 'CU1', status: 'failed',
          error: { message: "You've hit your usage limit. Try again at Oct 22nd, 2026 3:13 PM.", codexErrorInfo: 'usageLimitExceeded' } } } }), 700);
      }
    } });
  `;

  it('moves a live conversation to B when its sub-agent thread fails on the usage limit', async () => {
    TRANSPORT_SESSIONS.codex = (options) => createCodexSession({ ...options, spawn: (_binary, _argv, spawnOptions) => spawn(process.execPath, ['-e', server()], spawnOptions) });
    const key = vendorChildKey({ command: 'codex' } as AiLocalHarnessDefinition, account('acct-a'), {}, dir);
    const child = persistentTransportFor(SESSION, 'codex-app-server', key);
    await (child.session as ReturnType<typeof createCodexSession>).runTurn({ binary: 'codex', prompt: 'go', cwd: dir, permissionMode: 'ask' } as never);
    await expectMovedToB({ task: false });
  }, 30_000);
});

describe('Amp stream-json', () => {
  it('moves a live conversation to B when its sub-agent fails on the usage limit', async () => {
    const owner = { harness: 'amp', accountId: 'acct-a' };
    const turn = createAmpStreamTurn({
      prompt: 'go', write: () => true, close: () => undefined,
      agentEnded: (ended) => reportEndedWork(SESSION, [ended], owner),
    } as never);
    turn.note({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } });
    turn.note({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { mode: 'async', description: 'Open B5', prompt: TASK } }] } });
    turn.note({ type: 'system', subtype: 'subagent_finished', tool_use_id: 'task-1', status: 'error', error: "You've hit your usage limit. Try again at 10:35 AM." });
    await expectMovedToB();
  }, 30_000);
});
