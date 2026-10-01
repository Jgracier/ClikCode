/** A turn's usage from agents that report the SESSION's running totals over
 * ACP, measured from what the session had reached when the prompt was sent.
 * Driven by a real child speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { TurnUsage } from '../protocol/turn-usage.js';

type Step = { update?: Record<string, unknown>; answer?: Record<string, unknown> };

/** `prompts[n]` is what the agent does for the nth session/prompt; `onLoad`
 * is what it replays when asked to session/load. */
function agent(prompts: Step[][], onLoad: Record<string, unknown>[] = [], started: Record<string, unknown> = {}): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const prompts = ${JSON.stringify(prompts)};
    const onLoad = ${JSON.stringify(onLoad)};
    const started = ${JSON.stringify(started)};
    let n = 0; let buf = '';
    const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1', ...started } });
      else if (m.method === 'session/load') { onLoad.forEach(update); send({ id: m.id, result: {} }); }
      else if (m.method === 'session/prompt') { for (const s of prompts[n++] ?? []) { if (s.update) update(s.update); if (s.answer) send({ id: m.id, result: s.answer }); } }
    } });
  `;
}

const chunk = (text: string, meta?: Record<string, unknown>) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta ? { _meta: meta } : {}) });

async function turns(prompts: Step[][], options: { onLoad?: Record<string, unknown>[]; started?: Record<string, unknown>; resume?: boolean; extra?: Record<string, unknown>; count?: number } = {}): Promise<TurnUsage[]> {
  const session = createAcpSession();
  const last: TurnUsage[] = [];
  try {
    for (let index = 0; index < (options.count ?? prompts.length); index += 1) {
      let merged: TurnUsage = {};
      await session.runTurn({
        binary: process.execPath, command: 'fake', argv: ['-e', agent(prompts, options.onLoad, options.started)], cwd: process.cwd(), prompt: 'go',
        environment: {}, permissionMode: 'ask', ...(options.resume ? { nativeSessionId: 's1' } : {}), ...options.extra,
        // Merged as the turn loop does: field by field, the latest wins.
        onUsage: (usage) => { merged = { ...merged, ...usage }; },
      });
      last.push(merged);
    }
  } finally { await session.close(); }
  return last;
}

describe('ACP usage reported as session totals', () => {
  // hermes acp_adapter/server.py returns Usage(input_tokens=agent.session_prompt_tokens, ...).
  it('a declared session total counts each turn by what it grew', async () => {
    const answer = (input: number, output: number) => ({ stopReason: 'end_turn', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output } });
    const [first, second] = await turns([[{ update: chunk('a'), answer: answer(1000, 50) }], [{ update: chunk('b'), answer: answer(2600, 90) }]], {
      extra: { usageTotals: 'session' },
    });
    expect(first).toMatchObject({ input: 1000, output: 50, totalTokens: 1050 });
    expect(second).toMatchObject({ input: 1600, output: 40, totalTokens: 1640 });
  });

  // Grok Build 1.0.46, captured live: per-turn usage under `_meta.usage`
  // (numTurns: 1 on every turn), cost in ticks, no usage_update -- the
  // context occupied is `_meta.totalTokens` and the window is the model's.
  it('Grok: per-turn usage, cost from ticks, context from the result and model', async () => {
    const answer = (input: number, output: number, ticks: number, context: number) => ({ stopReason: 'end_turn', _meta: {
      modelId: 'grok-4.7', totalTokens: context,
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: 1664, reasoningTokens: 25, costUsdTicks: ticks, numTurns: 1 },
    } });
    const started = { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', _meta: { totalContextTokens: 256_000 } }] } };
    const [, second] = await turns([[{ update: chunk('a'), answer: answer(14_349, 29, 91_636_800, 14_386) }], [{ update: chunk('b'), answer: answer(14_407, 26, 90_011_600, 14_440) }]], { started });
    expect(second).toMatchObject({ input: 14_407, output: 26, cacheRead: 1664, reasoning: 25, contextUsed: 14_440, contextWindow: 256_000 });
    expect(second!.costUsd).toBeCloseTo(0.0090011600, 10);
  });

  it('an undeclared prompt usage stays the turn\'s own', async () => {
    const answer = { stopReason: 'end_turn', usage: { inputTokens: 700, outputTokens: 20, totalTokens: 720 } };
    const [, second] = await turns([[{ update: chunk('a'), answer }], [{ update: chunk('b'), answer }]]);
    expect(second).toMatchObject({ input: 700, output: 20 });
  });

  // vibe acp/agent.py _send_usage_update: after session/load too, with the
  // session's totals in `_meta` and its cost.
  it('Vibe: the totals a session/load reports are the baseline, cost included', async () => {
    const vibeUpdate = (prompt: number, completion: number, cached: number, cost: number) => ({
      sessionUpdate: 'usage_update', used: prompt, size: 256_000, cost: { amount: cost, currency: 'USD' },
      _meta: { steps: 3, promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: prompt + completion, tokensPerSecond: 40 },
    });
    const [turn] = await turns([[
      { update: chunk('ok') }, { update: vibeUpdate(15_000, 700, 9_000, 0.42) },
      { answer: { stopReason: 'end_turn', usage: { inputTokens: 15_000, outputTokens: 700, totalTokens: 15_700 } } },
    ]], { onLoad: [chunk('earlier answer'), vibeUpdate(10_000, 500, 6_000, 0.3)], resume: true, extra: { usageTotals: 'session' } });
    expect(turn).toMatchObject({ input: 5_000, output: 200, cacheRead: 3_000, totalTokens: 5_200, contextWindow: 256_000 });
    expect(turn!.costUsd).toBeCloseTo(0.12, 6);
  });

  // openhands_cli acp_impl/events/utils.py get_metadata: accumulated usage on
  // every message and tool update.
  it('OpenHands: accumulated metrics on message updates are this turn\'s by their growth', async () => {
    const metrics = (input: number, output: number, cached: number, reasoning: number, cost: number) => ({
      'openhands.dev/metrics': { input_tokens: input, output_tokens: output, cache_read_tokens: cached, reasoning_tokens: reasoning, cost, status_line: '...' },
    });
    const [turn] = await turns([[
      { update: chunk('Hel', metrics(8_000, 100, 5_000, 10, 0.05)) }, { update: chunk('lo', metrics(8_000, 140, 5_000, 12, 0.06)) },
      { answer: { stopReason: 'end_turn' } },
    ]], { onLoad: [chunk('before', metrics(6_000, 60, 4_000, 4, 0.02))], resume: true });
    expect(turn).toMatchObject({ input: 2_000, output: 80, cacheRead: 1_000, reasoning: 8 });
    expect(turn!.costUsd).toBeCloseTo(0.04, 6);
  });

  // gemini-cli's GeminiAgent.prompt returns `_meta.quota.token_count`.
  it('Gemini: reads the turn\'s token count from `_meta.quota`', async () => {
    const [turn] = await turns([[{ update: chunk('ok'), answer: { stopReason: 'end_turn', _meta: { quota: { token_count: { input_tokens: 4_100, output_tokens: 33 }, model_usage: [] } } } }]]);
    expect(turn).toMatchObject({ input: 4_100, output: 33, stopReason: 'completed' });
  });
});
