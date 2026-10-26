/** How a Codex turn waits: on Codex's own events, for its own thread only,
 * with the idle watchdog as a ceiling -- and what happens to the work a turn
 * leaves running. Driven by a real child process speaking the app-server's
 * JSONL the way codex 0.155 does (shapes recorded from a live probe). */
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSession } from './codex-app-server.js';
import type { VendorBackgroundTurn } from './background-turn.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { TurnUsage } from '../protocol/turn-usage.js';
import type { BackgroundWorkUpdate } from '../protocol/background-agents.js';

type Step = { after?: number; send?: Record<string, unknown>; approve?: string };

/** A fake app-server. `turns[n]` is what it does after answering the nth
 * turn/start; `{{turn}}` in a step is replaced with that turn's id. */
function fakeServer(turns: Step[][]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const turns = ${JSON.stringify(turns)};
    let n = 0; let buf = '';
    const run = async (steps, turn) => {
      for (const step of steps) {
        if (step.after) await new Promise((r) => setTimeout(r, step.after));
        if (step.send) send(JSON.parse(JSON.stringify(step.send).split('{{turn}}').join(turn)));
        if (step.approve) send({ id: 900 + n, method: 'item/commandExecution/requestApproval', params: { threadId: 'T', itemId: step.approve, command: 'make' } });
      }
    };
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/read') send({ id: m.id, result: { thread: { id: m.params.threadId, turns: [{ items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Check the child task' }] },
        { type: 'commandExecution', id: 'child-tool', command: 'git status', status: 'completed', exitCode: 0 },
        { type: 'agentMessage', text: 'Child task finished' }
      ] }] } } });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') { const turn = 'U' + (++n); send({ id: m.id, result: { turn: { id: turn } } }); run(turns[n - 1] ?? [], turn); }
      else if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
    } });
  `;
}

function session(turns: Step[][], options: { backgroundTurns?: (turn: VendorBackgroundTurn) => void } = {}) {
  return createCodexSession({
    spawn: (_binary, _argv, spawnOptions) => spawn(process.execPath, ['-e', fakeServer(turns)], spawnOptions),
    ...options,
  });
}

const input = (activity: HarnessActivityEvent[] = [], extra: Record<string, unknown> = {}) => ({
  binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask' as const,
  onActivity: (event: HarnessActivityEvent) => activity.push(event), ...extra,
});

const agentMessage = (threadId: string, turnId: string, text: string) => ({
  method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `m-${threadId}-${text}`, text } },
});
const turnCompleted = (threadId: string, turnId: string, status = 'completed') => ({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
const turnStarted = (threadId: string, turnId: string) => ({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
const command = (id: string, done: boolean, turnId = '{{turn}}') => ({
  method: done ? 'item/completed' : 'item/started',
  params: { threadId: 'T', turnId, item: { type: 'commandExecution', id, command: 'sleep 30; echo BG', status: done ? 'completed' : 'inProgress', ...(done ? { aggregatedOutput: 'BG\n', exitCode: 0 } : {}) } },
});

describe('a Codex failover standby', () => {
  it('initializes without creating a thread and reads child history through the same server', async () => {
    const codex = session([]);
    try {
      expect(await codex.runTurn(input([], { prompt: '', initializeOnly: true }))).toEqual({ text: '', nativeSessionId: '' });
      const rows = await codex.readSubagentThread('CHILD');
      expect(rows[0]).toEqual({ kind: 'prompt', text: 'Check the child task' });
      expect(rows[1]).toMatchObject({ kind: 'activity', event: { id: 'child-tool', kind: 'tool-done' } });
      expect(rows[2]).toEqual({ kind: 'text', text: 'Child task finished' });
    } finally { await codex.close(); }
  });
  it('resumes the thread up to the turn, and the next turn on it starts at turn/start', async () => {
    const methods: string[] = [];
    const codex = createCodexSession({
      spawn: (_binary, _argv, spawnOptions) => {
        const child = spawn(process.execPath, ['-e', fakeServer([[
          { send: agentMessage('T', '{{turn}}', 'WARM') }, { send: turnCompleted('T', '{{turn}}') },
        ]])], spawnOptions);
        let buf = '';
        child.stdin!.write = ((original) => function (this: unknown, chunk: unknown, ...rest: unknown[]) {
          buf += String(chunk);
          let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.method) methods.push(m.method); }
          return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
        })(child.stdin!.write) as typeof child.stdin.write;
        return child;
      },
    });
    try {
      expect(await codex.runTurn(input([], { nativeSessionId: 'T', prompt: '', prepareOnly: true }))).toEqual({ text: '', nativeSessionId: 'T' });
      const result = await codex.runTurn(input([], { nativeSessionId: 'T' }));
      expect(result.text).toBe('WARM');
      expect(methods.filter((method) => method !== 'initialized')).toEqual(['initialize', 'thread/resume', 'turn/start']);
    } finally {
      await codex.close();
    }
  });
});

describe('a Codex turn waits for its own thread', () => {
  it('is not ended by a sub-agent finishing first, and shows the sub-agent as one row', async () => {
    const codex = session([[
      { send: { method: 'item/started', params: { threadId: 'T', turnId: '{{turn}}', item: { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 'C', agentPath: '/root/run_tests' } } } },
      { send: turnStarted('C', 'CU1') },
      { send: agentMessage('C', 'CU1', 'CHILD PROSE') },
      { after: 50, send: turnCompleted('C', 'CU1') },
      { after: 150, send: agentMessage('T', '{{turn}}', 'PARENT DONE') },
      { send: turnCompleted('T', '{{turn}}') },
    ]]);
    const activity: HarnessActivityEvent[] = [];
    try {
      const result = await codex.runTurn(input(activity));
      expect(result.text).toBe('PARENT DONE');
      expect(activity.filter((event) => event.agent)).toEqual([
        { kind: 'tool-start', label: 'subagent run_tests', agent: true, id: 'agent:C' },
        { kind: 'tool-done', label: 'subagent run_tests', agent: true, id: 'agent:C' },
      ]);
    } finally { await codex.close(); }
  });
});

describe('a Codex sub-agent thread\'s own tool calls', () => {
  const childCommand = (id: string, done: boolean) => ({
    method: done ? 'item/completed' : 'item/started',
    params: { threadId: 'C', turnId: 'CU1', item: { type: 'commandExecution', id, command: 'ls src', status: done ? 'completed' : 'inProgress', ...(done ? { aggregatedOutput: 'a.ts\n', exitCode: 0 } : {}) } },
  });

  it('are child rows of the sub-agent row (standard section 5), never top-level rows', async () => {
    const codex = session([[
      { send: { method: 'item/started', params: { threadId: 'T', turnId: '{{turn}}', item: { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 'C', agentPath: '/root/run_tests' } } } },
      { send: turnStarted('C', 'CU1') },
      { send: childCommand('c1', false) },
      { send: childCommand('c1', true) },
      { send: { method: 'item/completed', params: { threadId: 'C', turnId: 'CU1', item: { type: 'reasoning', id: 'r1', summary: ['child thought'] } } } },
      { after: 50, send: turnCompleted('C', 'CU1') },
      { after: 100, send: agentMessage('T', '{{turn}}', 'PARENT DONE') },
      { send: turnCompleted('T', '{{turn}}') },
    ]]);
    const activity: HarnessActivityEvent[] = [];
    try {
      await codex.runTurn(input(activity));
      const children = activity.filter((event) => event.id === 'c1');
      expect(children.map((event) => [event.kind, event.parentId])).toEqual([['tool-start', 'agent:C'], ['tool-done', 'agent:C']]);
      expect(children[1]!.output).toEqual(['a.ts']);
      // The thread's own row is the parent, and is the only agent row.
      expect(activity.filter((event) => event.agent).every((event) => event.id === 'agent:C' && event.parentId === undefined)).toBe(true);
      // A child's reasoning is its own: it is not the turn's thought.
      expect(activity.some((event) => event.kind === 'thinking')).toBe(false);
    } finally { await codex.close(); }
  });
});

describe('a Codex turn has no silence ceiling', () => {
  it('waits through a silent tool and a user deciding an approval', async () => {
    const codex = session([[
      { send: command('build', false) },
      { approve: 'build' },
      { after: 900, send: command('build', true) },
      { after: 100, send: { method: 'item/agentMessage/delta', params: { threadId: 'T', turnId: '{{turn}}', itemId: 'm', delta: 'ok' } } },
      { after: 100, send: turnCompleted('T', '{{turn}}') },
    ]]);
    try {
      expect((await codex.runTurn(input([], { onApproval: async () => true }))).text).toBe('ok');
    } finally { await codex.close(); }
  });
});

describe('work a Codex turn leaves running', () => {
  it('keeps a subagent alive when the parent turn fails', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([[
      { send: { method: 'item/started', params: { threadId: 'T', turnId: '{{turn}}', item: { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: 'C', agentPath: '/root/check' } } } },
      { send: turnCompleted('T', '{{turn}}', 'failed') },
      { after: 600, send: turnCompleted('C', 'CU1') },
    ]], { backgroundTurns: (turn) => turns.push(turn) });
    try {
      await expect(codex.runTurn(input())).rejects.toThrow();
      expect(turns).toHaveLength(1);
      expect(turns[0]!.reason).toBe('background-work');
      expect(await codex.backgroundWorkRunning()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await codex.backgroundWorkRunning()).toBe(true);
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(await codex.backgroundWorkRunning()).toBe(false);
    } finally { await codex.close(); }
  });

  it('reports a background shell that finishes after the reply as a background turn', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([[
      { send: command('bg-1', false) },
      { send: agentMessage('T', '{{turn}}', 'STARTED') },
      { send: turnCompleted('T', '{{turn}}') },
      { after: 200, send: command('bg-1', true, 'U1') },
    ]], { backgroundTurns: (turn) => turns.push(turn) });
    try {
      const result = await codex.runTurn(input());
      expect(result.text).toBe('STARTED');
      expect(turns).toHaveLength(1);
      expect(turns[0]!.reason).toBe('background-work');
      const seen: HarnessActivityEvent[] = [];
      turns[0]!.attach({ onActivity: (event) => seen.push(event) });
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(seen).toEqual([{ kind: 'tool-done', label: '$ sleep 30; echo BG', category: 'run', id: 'bg-1', call: { name: 'shell', input: { command: 'sleep 30; echo BG' } }, output: ['BG'], outputTail: true, exitCode: 0 }]);
    } finally { await codex.close(); }
  });

  it('opens a background turn for a turn the vendor starts itself, and closes it on its turn/completed', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([[
      { send: agentMessage('T', '{{turn}}', 'first') },
      { send: turnCompleted('T', '{{turn}}') },
      { after: 100, send: turnStarted('T', 'V1') },
      { send: { method: 'item/agentMessage/delta', params: { threadId: 'T', turnId: 'V1', itemId: 'v', delta: 'The sub-agent ' } } },
      { send: { method: 'item/agentMessage/delta', params: { threadId: 'T', turnId: 'V1', itemId: 'v', delta: 'finished.' } } },
      { send: turnCompleted('T', 'V1') },
    ]], { backgroundTurns: (turn) => turns.push(turn) });
    try {
      await codex.runTurn(input());
      await vi.waitFor(() => expect(turns.map((turn) => turn.reason)).toEqual(['vendor-turn']), { timeout: 5000, interval: 10 });
      const text: string[] = [];
      turns[0]!.attach({ onResponseDelta: (delta) => text.push(delta) });
      expect(await turns[0]!.finished).toEqual({ text: 'The sub-agent finished.', ended: 'completed' });
      expect(text.join('')).toBe('The sub-agent finished.');
      expect(turns).toHaveLength(1);
    } finally { await codex.close(); }
  });

  it('hands the vendor over to the next user turn, which supersedes the background turn', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([
      [{ send: command('bg-1', false) }, { send: agentMessage('T', '{{turn}}', 'one') }, { send: turnCompleted('T', '{{turn}}') }],
      [{ send: command('bg-1', true, 'U1') }, { send: agentMessage('T', '{{turn}}', 'two') }, { send: turnCompleted('T', '{{turn}}') }],
    ], { backgroundTurns: (turn) => turns.push(turn) });
    try {
      await codex.runTurn(input());
      const activity: HarnessActivityEvent[] = [];
      expect((await codex.runTurn(input(activity))).text).toBe('two');
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'superseded' });
      expect(activity.map((event) => `${event.kind} ${event.id}`)).toEqual(['tool-done bg-1']);
      expect(turns).toHaveLength(1);
    } finally { await codex.close(); }
  });

  it('ends a background turn as closed when the session closes', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([[{ send: command('bg-1', false) }, { send: agentMessage('T', '{{turn}}', 'x') }, { send: turnCompleted('T', '{{turn}}') }]], {
      backgroundTurns: (turn) => turns.push(turn),
    });
    await codex.runTurn(input());
    await codex.close();
    expect(await turns[0]!.finished).toEqual({ text: '', ended: 'closed' });
  });
});

describe('background terminals (unified exec processes the turn leaves running)', () => {
  /** Codex 0.155's commandExecution item for a unified-exec process: `source`
   * unifiedExecStartup and the PTY's `processId` (app-server schema v2). */
  const exec = (id: string, done: boolean, source = 'unifiedExecStartup', processId: string | null = 'p-1') => ({
    method: done ? 'item/completed' : 'item/started',
    params: { threadId: 'T', turnId: '{{turn}}', item: { type: 'commandExecution', id, command: 'npm run dev', source, processId, status: done ? 'completed' : 'inProgress', ...(done ? { aggregatedOutput: '', exitCode: 0 } : {}) } },
  });
  const interaction = (itemId: string, processId: string) => ({ method: 'item/commandExecution/terminalInteraction', params: { threadId: 'T', turnId: '{{turn}}', itemId, processId, stdin: '' } });
  const kinds = (seen: BackgroundWorkUpdate[]) => seen.map((work) => work.terminals);

  it('counts none for a command that finished within its turn, or one the model never came back to', async () => {
    const codex = session([[
      { send: exec('quick', false) }, { send: exec('quick', true) },
      { send: exec('agentcmd', false, 'agent', null) },
      { send: exec('shell', false, 'userShell', null) },
      { send: exec('agentcmd', true, 'agent', null) }, { send: exec('shell', true, 'userShell', null) },
      { send: agentMessage('T', '{{turn}}', 'done') }, { send: turnCompleted('T', '{{turn}}') },
    ]]);
    const seen: BackgroundWorkUpdate[] = [];
    try {
      await codex.runTurn(input([], { onBackgroundWork: (work: BackgroundWorkUpdate) => seen.push(work) }));
      expect(seen).toEqual([]);
    } finally { await codex.close(); }
  });

  it('counts a process the model went back to (terminalInteraction) while the turn still runs, and drops it when it exits', async () => {
    const codex = session([[
      { send: exec('dev', false) },
      { after: 20, send: interaction('dev', 'p-1') },
      { after: 20, send: exec('dev', true) },
      { send: agentMessage('T', '{{turn}}', 'done') }, { send: turnCompleted('T', '{{turn}}') },
    ]]);
    const seen: BackgroundWorkUpdate[] = [];
    try {
      await codex.runTurn(input([], { onBackgroundWork: (work: BackgroundWorkUpdate) => seen.push(work) }));
      expect(kinds(seen)).toEqual([1, 0]);
    } finally { await codex.close(); }
  });

  it('keeps reporting after the turn ended while a process runs, and ends the background turn when it exits', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const codex = session([[
      { send: exec('dev', false) }, { send: agentMessage('T', '{{turn}}', 'Started the server.') }, { send: turnCompleted('T', '{{turn}}') },
      { after: 400, send: exec('dev', true, 'unifiedExecStartup', 'p-1') },
    ]], { backgroundTurns: (turn) => turns.push(turn) });
    const during: BackgroundWorkUpdate[] = [];
    try {
      await codex.runTurn(input([], { onBackgroundWork: (work: BackgroundWorkUpdate) => during.push(work) }));
      // At the turn's end the process outlived it: the turn's own observer is told, and so is the background turn.
      expect(kinds(during).at(-1)).toBe(1);
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      const after: BackgroundWorkUpdate[] = [];
      turns[0]!.attach({ onBackgroundWork: (work) => after.push(work) });
      expect(await codex.backgroundWorkRunning()).toBe(true);
      expect(await turns[0]!.finished).toMatchObject({ ended: 'completed' });
      expect(kinds(after)).toEqual([1, 0]);
    } finally { await codex.close(); }
  });
});

describe('what a Codex turn reports as it runs', () => {
  const notify = (method: string, params: Record<string, unknown>) => ({ send: { method, params: { threadId: 'T', turnId: '{{turn}}', ...params } } });
  const breakdown = (input: number, cached: number, output: number) => ({
    totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0,
  });
  const tokenUsage = (total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
    notify('thread/tokenUsage/updated', { tokenUsage: { total, last, modelContextWindow: 258_000 } });
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old line', '+new line',
  ].join('\n');

  it('counts the turn, not the thread, and reports thoughts, notices and progress', async () => {
    const codex = session([[
      // A resumed thread: 5,000 tokens were spent before this turn began.
      tokenUsage(breakdown(6_000, 4_000, 100), breakdown(1_000, 800, 100)),
      notify('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Plan', summaryIndex: 0 }),
      notify('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: ' the fix', summaryIndex: 0 }),
      notify('model/rerouted', { fromModel: 'gpt-5.5', toModel: 'gpt-5.5-mini', reason: 'highRiskCyberActivity' }),
      notify('thread/compacted', {}),
      notify('item/completed', { item: { type: 'contextCompaction', id: 'c1' } }),
      notify('item/started', { item: { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', status: 'inProgress', arguments: {} } }),
      notify('item/mcpToolCall/progress', { itemId: 'm1', message: 'fetching page 2' }),
      notify('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', status: 'completed', arguments: {} } }),
      notify('turn/diff/updated', { diff }),
      tokenUsage(breakdown(7_500, 5_000, 250), breakdown(1_500, 1_000, 150)),
      // Sent again beside a rate-limit update: the same reading, not more work.
      tokenUsage(breakdown(7_500, 5_000, 250), breakdown(1_500, 1_000, 150)),
      { send: agentMessage('T', '{{turn}}', 'Fixed.') },
      { send: turnCompleted('T', '{{turn}}') },
    ]]);
    const activity: HarnessActivityEvent[] = [];
    const thoughts: Array<[string, string | undefined]> = [];
    const notices: string[] = [];
    const usage: TurnUsage[] = [];
    try {
      await codex.runTurn(input(activity, {
        onThought: (text: string, id?: string) => thoughts.push([text, id]),
        onNotice: (message: string) => notices.push(message),
        onUsage: (reading: TurnUsage) => usage.push(reading),
      }));
    } finally { await codex.close(); }
    expect(usage[0]).toEqual({ input: 1_000, cacheRead: 800, cacheWrite: 0, output: 100, reasoning: 0, totalTokens: 1_100, contextWindow: 258_000, contextUsed: 1_100 });
    expect(usage[1]).toMatchObject({ input: 2_500, cacheRead: 1_800, output: 250, totalTokens: 2_750, contextUsed: 1_650 });
    expect(usage[2]).toEqual(usage[1]);
    expect(usage.at(-1)).toEqual({ stopReason: 'completed' });
    expect(thoughts).toEqual([['Plan', 'r1'], ['Plan the fix', 'r1']]);
    expect(notices).toEqual([
      'Codex moved this turn from gpt-5.5 to gpt-5.5-mini (highRiskCyberActivity)',
      'Codex compacted the conversation to fit its context window',
    ]);
    expect(activity.find((event) => event.id === 'm1' && event.output)).toMatchObject({ kind: 'tool-start', label: 'docs › search', output: ['fetching page 2'] });
    // The aggregated turn diff adds no row: each file change shows its own.
    expect(activity.filter((event) => !event.id || !['m1'].includes(event.id))).toEqual([]);
  });
});
