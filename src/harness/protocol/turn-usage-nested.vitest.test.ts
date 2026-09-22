import { describe, expect, it } from 'vitest';
import { nativeUsageFromValue } from './turn-usage.js';

/**
 * Usage is not always beside the terminal marker.
 *
 * Antigravity emits `{event:"result", result:{..., usage:{...}}}` -- the
 * marker is `event` (not `type`) and the payload is one level down. The parser
 * read only `record.type` and `record.usage`, so it matched neither, and every
 * Antigravity turn recorded zero tokens while the CLI was plainly reporting
 * them. Confirmed against agy 1.2.7 on a real authenticated account; the
 * record below is that run's actual output.
 */
describe('usage inside a nested terminal envelope', () => {
  it("reads antigravity's event/result/usage shape", () => {
    const usage = nativeUsageFromValue({
      event: 'result',
      result: {
        conversation_id: '3a60c0ef-9f06-4f50-8636-773807b62e64',
        status: 'SUCCESS',
        response: 'Hi there!',
        duration_seconds: 2.683839839,
        num_turns: 1,
        usage: {
          input_tokens: 13826, output_tokens: 38, thinking_tokens: 0,
          cache_read_tokens: 0, total_tokens: 13864,
        },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 13826, outputTokens: 38, totalTokens: 13864,
      cacheReadTokens: 0, thinkingTokens: 0, numTurns: 1,
    });
    // duration_seconds -> ms, because every other harness reports milliseconds
    expect(usage?.durationMs).toBeCloseTo(2683.84, 0);
  });

  it('still reads the flat shape every other harness uses', () => {
    expect(nativeUsageFromValue({
      type: 'result', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5,
    })).toMatchObject({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.5 });
  });

  it('counts reasoning tokens, which are billed and quota-consuming', () => {
    expect(nativeUsageFromValue({ type: 'result', usage: { reasoning_tokens: 4096 } }))
      .toMatchObject({ thinkingTokens: 4096 });
  });

  it('does not treat a mid-turn record as the terminal one', () => {
    // A partial count on an `assistant` event must not be mistaken for the
    // turn's total -- the final record supersedes it.
    expect(nativeUsageFromValue({ type: 'assistant', usage: { input_tokens: 5 } })).toBeUndefined();
    expect(nativeUsageFromValue({ event: 'step_update', result: { usage: { input_tokens: 5 } } })).toBeUndefined();
  });

  it('does not wander into an unrelated object holding a usage key', () => {
    // Only named envelopes are followed, so a tool result that happens to
    // carry `usage` cannot be read as the turn's cost.
    expect(nativeUsageFromValue({ type: 'result', tool: { usage: { input_tokens: 999 } } })).toBeUndefined();
  });
});
