/** How an ACP turn waits: for the answer to session/prompt, with the idle
 * watchdog as a ceiling -- and where updates the agent sends between prompts
 * go. Driven by a real child speaking ACP. */
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { VendorBackgroundTurn } from './background-turn.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { TurnUsage } from '../protocol/turn-usage.js';

type Step = { after?: number; update?: Record<string, unknown>; answer?: true | Record<string, unknown>; permission?: true };

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
        if (step.permission) send({ id: 500 + n, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't', title: 'Run make', kind: 'execute' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } });
        if (step.answer) send({ id, result: step.answer === true ? { stopReason: 'end_turn' } : step.answer });
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

describe('the idle watchdog on an ACP prompt', () => {
  it('fails a prompt the agent never answers, as an idle timeout', async () => {
    const session = createAcpSession({ idleMs: 200 });
    try {
      const failure = await session.runTurn(input([[{ update: chunk('thinking...') }]])).catch((error: Error & { reason?: string }) => error);
      expect((failure as Error & { reason?: string }).reason).toBe('idle-timeout');
      expect((failure as Error).message).toBe('fake produced no output for 0s and was stopped');
    } finally { await session.close(); }
  });

  it('gives a running tool the longer budget, and each update restarts it', async () => {
    const session = createAcpSession({ idleMs: 200, toolIdleMs: 2000 });
    try {
      const result = await session.runTurn(input([[
        { update: tool('b', 'pending') }, { after: 400, update: tool('b', 'completed') },
        { after: 120, update: chunk('built') }, { after: 120, answer: true },
      ]]));
      expect(result.text).toBe('built');
    } finally { await session.close(); }
  });

  it('does not count time the user spends deciding an approval', async () => {
    // Unpaused, 300ms of silence would fire at 300ms; the answer comes at 400
    // and the next update at 500.
    const session = createAcpSession({ idleMs: 300 });
    try {
      const result = await session.runTurn(input([[{ permission: true }, { after: 500, update: chunk('ok') }, { answer: true }]], {
        onApproval: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
      }));
      expect(result.text).toBe('ok');
    } finally { await session.close(); }
  });
});

describe('updates an ACP agent sends between prompts', () => {
  it('open a background turn that ends on the agent\'s end-of-turn bookkeeping', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      const result = await session.runTurn(input([[
        { update: chunk('first') }, { answer: true },
        // Bookkeeping alone opens nothing.
        { after: 50, update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
        { after: 50, update: chunk('A task you started finished.') },
        { update: { sessionUpdate: 'session_info_update', updatedAt: 'now' } },
      ]]));
      expect(result.text).toBe('first');
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000, interval: 10 });
      expect(await turns[0]!.finished).toEqual({ text: 'A task you started finished.', ended: 'completed' });
      expect(turns).toHaveLength(1);
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
