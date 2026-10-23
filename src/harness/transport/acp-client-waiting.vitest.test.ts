/** How an ACP turn waits: for the answer to session/prompt, with no ceiling of
 * ClikCode's own -- and where updates the agent sends between prompts go. Driven by a real child speaking ACP. */
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { VendorBackgroundTurn } from './background-turn.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { TurnUsage } from '../protocol/turn-usage.js';
import type { BackgroundWorkUpdate } from '../protocol/background-agents.js';

type Step = { after?: number; update?: Record<string, unknown>; notify?: { method: string; params: Record<string, unknown> }; answer?: true | Record<string, unknown>; error?: { code: number; message: string }; permission?: true };

/** `prompts[n]` is what the agent does for the nth session/prompt. */
function agent(prompts: Step[][]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const prompts = ${JSON.stringify(prompts)};
    let n = 0; let buf = '';
    const run = async (steps, id) => {
      for (const step of steps) {
        if (step.after) await new Promise((r) => setTimeout(r, step.after));
        if (step.update) send({ method: 'session/update', params: { sessionId: 's1', update: step.update } });
        if (step.notify) send({ method: step.notify.method, params: { sessionId: 's1', ...step.notify.params } });
        if (step.permission) send({ id: 500 + n, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't', title: 'Run make', kind: 'execute' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } });
        if (step.answer) send({ id, result: step.answer === true ? { stopReason: 'end_turn' } : step.answer });
        if (step.error) send({ id, error: step.error });
      }
    };
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') run(prompts[n++] ?? [], m.id);
    } });
  `;
}

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const tool = (id: string, status: string) => ({ sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: id, title: 'Run build', kind: 'execute', status });

function input(prompts: Step[][], extra: Record<string, unknown> = {}) {
  return {
    binary: process.execPath, command: 'fake', argv: ['-e', agent(prompts)], cwd: process.cwd(), prompt: 'go',
    environment: {}, permissionMode: 'ask' as const, ...extra,
  };
}

describe('an ACP prompt has no silence ceiling', () => {
  it('waits through a long quiet stretch and a user deciding an approval', async () => {
    const session = createAcpSession();
    try {
      const result = await session.runTurn(input([[{ permission: true }, { after: 900, update: chunk('ok') }, { answer: true }]], {
        onApproval: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
      }));
      expect(result.text).toBe('ok');
    } finally { await session.close(); }
  });
});

describe('a permission switch made while an ACP turn runs', () => {
  const run = async (live?: 'bypass' | 'ask') => {
    const asked = vi.fn(async () => true);
    const session = createAcpSession();
    try {
      await session.runTurn(input([[{ permission: true }, { after: 50, update: chunk('ok') }, { answer: true }]], {
        onApproval: asked,
        ...(live ? { currentPermissionMode: async () => live } : {}),
      }));
    } finally { await session.close(); }
    return asked.mock.calls.length;
  };

  it('applies to the next tool the agent asks about, not only the next turn', async () => {
    expect(await run()).toBe(1); // started in ask, still ask: the user is asked
    expect(await run('bypass')).toBe(0); // switched to bypass mid-turn: not asked
    expect(await run('ask')).toBe(1);
  });
});

describe('updates an ACP agent sends between prompts', () => {
  it('lets an Agent tool finish after its parent request runs out of usage', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      const failure = await session.runTurn(input([[
        { update: { ...tool('agent-1', 'pending'), rawInput: { subagent_type: 'Explore' } } },
        { error: { code: 429, message: 'usage limit reached' } },
        { after: 600, update: tool('agent-1', 'completed') },
      ]])).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.reason).toBe('background-work');
      expect(await session.backgroundWorkRunning()).toBe(true);
      const events: HarnessActivityEvent[] = [];
      turns[0]!.attach({ onActivity: (event) => events.push(event) });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await session.backgroundWorkRunning()).toBe(true);
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(events.map((event) => event.kind)).toEqual(['tool-done']);
      expect(await session.backgroundWorkRunning()).toBe(false);
    } finally { await session.close(); }
  });

  it('relays what the agent says between prompts instead of opening a working turn for it', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const said: string[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn), outOfTurn: (what) => said.push(what.text) });
    try {
      const result = await session.runTurn(input([[
        { update: chunk('first') }, { answer: true },
        // Bookkeeping alone opens nothing.
        { after: 50, update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
        { after: 50, update: chunk('A task you started finished.') },
        { update: { sessionUpdate: 'session_info_update', updatedAt: 'now' } },
      ]]));
      expect(result.text).toBe('first');
      await vi.waitFor(() => expect(said).toEqual(['A task you started finished.']), { timeout: 5000, interval: 10 });
      expect(turns).toHaveLength(0);
    } finally { await session.close(); }
  });

  it('open nothing for the tail of a stopped turn still unwinding', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    const controller = new AbortController();
    try {
      const stopped = session.runTurn(input([[
        { update: chunk('one') },
        // Already on its way when the stop lands, then the cancelled answer.
        { after: 300, update: chunk('tail') }, { after: 50, answer: { stopReason: 'cancelled' } },
      ]], { signal: controller.signal, onResponseDelta: () => controller.abort() })).catch((error: Error) => error);
      expect(await stopped).toBeInstanceOf(Error);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(turns).toHaveLength(0);
    } finally { await session.close(); }
  });

  it('keep a background turn open while a tool it started runs, and close it when that tool settles', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input([[
        { update: chunk('one') }, { answer: true },
        { after: 50, update: tool('bg', 'pending') },
        { after: 50, update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
        // Long enough that the check below runs while the tool is still
        // running, however late this process is scheduled.
        { after: 1000, update: tool('bg', 'completed') },
      ]]));
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      const seen: HarnessActivityEvent[] = [];
      turns[0]!.attach({ onActivity: (event) => seen.push(event) });
      let ended = false;
      void turns[0]!.finished.then(() => { ended = true; });
      // Past the usage_update, well before the tool settles.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ended, 'usage_update does not end it while the tool runs').toBe(false);
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(seen.map((event) => event.kind)).toEqual(['tool-start', 'tool-done']);
    } finally { await session.close(); }
  });

  it('are superseded by the next prompt, which receives them from then on', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    const activity: HarnessActivityEvent[] = [];
    const prompts = input([
      [{ update: chunk('one') }, { answer: true }, { after: 30, update: tool('bg', 'pending') }],
      [{ update: tool('bg', 'completed') }, { update: chunk('two') }, { answer: true }],
    ], { onActivity: (event: HarnessActivityEvent) => activity.push(event) });
    try {
      await session.runTurn(prompts);
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      expect((await session.runTurn(prompts)).text).toBe('two');
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'superseded' });
      expect(activity.map((event) => `${event.kind} ${event.id}`)).toEqual(['tool-done bg']);
    } finally { await session.close(); }
  });
});

describe('the background level an ACP agent publishes (claude-agent-acp _claude/sdkMessage)', () => {
  const level = (...tasks: Array<Record<string, unknown>>) => ({
    notify: { method: '_claude/sdkMessage', params: { message: { type: 'system', subtype: 'background_tasks_changed', tasks } } },
  });
  const shell = { task_id: 'sh1', task_type: 'local_bash', description: 'npm run dev' };
  const agentTask = { task_id: 'ag1', task_type: 'local_agent', description: 'review' };

  it('reaches the running turn by kind', async () => {
    const session = createAcpSession();
    const seen: BackgroundWorkUpdate[] = [];
    try {
      await session.runTurn(input([[level(shell, agentTask), level(agentTask), { update: chunk('ok') }, { answer: true }]], { onBackgroundWork: (work: BackgroundWorkUpdate) => seen.push(work) }));
      expect(seen[0]).toEqual({ agents: 1, agentTasks: [{ id: 'ag1', label: 'review' }], terminals: 1, workflows: 0 });
      expect(seen[1]).toEqual({ agents: 1, agentTasks: [{ id: 'ag1', label: 'review' }], terminals: 0, workflows: 0 });
    } finally { await session.close(); }
  });

  it('keeps reporting after the turn ended, while the vendor still runs a terminal, and ends when the level empties', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input([[
        level(shell), { update: chunk('Started it.') }, { answer: true },
        // After the answer: the shell still runs (a level change), then it ends.
        { after: 100, ...level(shell, agentTask) },
        { after: 600, ...level() },
      ]]));
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      expect(turns[0]!.reason).toBe('background-work');
      const seen: BackgroundWorkUpdate[] = [];
      turns[0]!.attach({ onBackgroundWork: (work) => seen.push(work) });
      expect(await session.backgroundWorkRunning()).toBe(true);
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(seen[0]).toEqual({ agents: 0, terminals: 1, workflows: 0 });
      expect(seen.at(-1)).toEqual({ agents: 0, terminals: 0, workflows: 0 });
      expect(seen.some((work) => work.agents === 1 && work.terminals === 1)).toBe(true);
      expect(await session.backgroundWorkRunning()).toBe(false);
    } finally { await session.close(); }
  });

  it('opens nothing for an empty level after the turn', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input([[{ update: chunk('ok') }, { answer: true }, { after: 50, ...level() }]]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(turns).toHaveLength(0);
    } finally { await session.close(); }
  });

  it('tells the next turn what already runs, so its indicator does not go dark', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    const seen: BackgroundWorkUpdate[] = [];
    try {
      const prompts = input([
        [level(shell), { update: chunk('one') }, { answer: true }],
        [{ update: chunk('two') }, { answer: true }],
      ], { onBackgroundWork: (work: BackgroundWorkUpdate) => seen.push(work) });
      await session.runTurn(prompts);
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      seen.length = 0;
      await session.runTurn(prompts);
      expect(seen[0]).toEqual({ agents: 0, terminals: 1, workflows: 0 });
    } finally { await session.close(); }
  });
});

describe('what an ACP turn reports as it runs', () => {
  const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  const usageUpdate = (used: number, cost: number) => ({ sessionUpdate: 'usage_update', used, size: 200_000, cost: { amount: cost, currency: 'USD' } });

  it('shows one growing thought per run of fragments, live usage, and why it stopped', async () => {
    const session = createAcpSession();
    const thoughts: Array<[string, string | undefined]> = [];
    const usage: TurnUsage[] = [];
    const observe = { onThought: (text: string, id?: string) => thoughts.push([text, id]), onUsage: (reading: TurnUsage) => usage.push(reading) };
    try {
      const prompts: Step[][] = [
        // A session that had already cost $0.50 before this turn.
        [{ update: usageUpdate(1_000, 0.5) }, { update: chunk('ok') }, { answer: true }],
        [
          { update: thought('Reading') }, { update: thought(' the file') }, { update: usageUpdate(12_000, 0.6) },
          { update: thought(' first.') }, { update: chunk('Here') }, { update: thought('Now') }, { update: chunk(' it is') },
          { answer: { stopReason: 'max_tokens', usage: { inputTokens: 900, outputTokens: 40, thoughtTokens: 12, cachedReadTokens: 300, totalTokens: 940 } } },
        ],
      ];
      await session.runTurn(input(prompts, observe));
      usage.length = 0;
      const result = await session.runTurn(input(prompts, observe));
      expect(result.text).toBe('Here it is');
    } finally { await session.close(); }
    // The fragments of a run are one thought; anything else ends it.
    expect(thoughts).toEqual([
      ['Reading', 'thought-1'], ['Reading the file', 'thought-1'], ['Reading the file first.', 'thought-1'], ['Now', 'thought-2'],
    ]);
    // `used`/`size` are the context, and the cost is this turn's share of the session's.
    expect(usage[0]).toEqual({ contextUsed: 12_000, contextWindow: 200_000, costUsd: expect.closeTo(0.1, 6) });
    expect(usage.at(-1)).toEqual({ input: 900, output: 40, reasoning: 12, cacheRead: 300, totalTokens: 940, stopReason: 'max-tokens' });
  });
});
