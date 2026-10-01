/** Grok Build's usage, from lines captured off grok 1.0.34 (one real
 * `grok -p ... --output-format streaming-messages-json
 * --include-partial-messages` turn, and its agent's `_x.ai/billing` answer). */
import { describe, expect, it } from 'vitest';
import { grokBillingReading, grokUsageReading } from './grok-usage.js';
import { NATIVE_USAGE_PROBES } from './usage-probes.js';
import { createStreamState, parseHarnessLine } from '../events/adapters.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const billing = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-28T23:16:51.066254+00:00', end: '2026-10-05T23:16:51.066254+00:00' },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true,
    billingPeriodStart: '2026-09-28T23:16:51.066254+00:00', billingPeriodEnd: '2026-10-05T23:16:51.066254+00:00',
  },
  subscription_tier: 'SuperGrok',
};

describe('grok plan allowance (_x.ai/billing)', () => {
  it('reads a fresh week, where the zero percent is omitted, as 0% used -- as the TUI does', () => {
    expect(grokBillingReading(billing)).toEqual({
      windows: [{ name: 'weekly', usedPct: 0, resetsAt: '2026-10-05T23:16:51.066Z' }],
      label: 'Weekly 100% left',
    });
  });

  it('reads the used percentage once the week has spend', () => {
    const spent = { ...billing, config: { ...billing.config, creditUsagePercent: 37.5 } };
    expect(grokBillingReading(spent)?.label).toBe('Weekly 63% left');
    expect(grokBillingReading(spent)?.windows[0]?.usedPct).toBe(37.5);
  });

  it('names a monthly period', () => {
    const monthly = { config: { ...billing.config, creditUsagePercent: 100, currentPeriod: { ...billing.config.currentPeriod, type: 'USAGE_PERIOD_TYPE_MONTHLY' } } };
    expect(grokBillingReading(monthly)?.label).toBe('Monthly 0% left');
  });

  it('invents nothing without a current period', () => {
    expect(grokBillingReading({ config: { isUnifiedBillingUser: false } })).toBeUndefined();
    expect(grokBillingReading(undefined)).toBeUndefined();
  });

  it('is registered as a probe with a structured reading', () => {
    expect(NATIVE_USAGE_PROBES.grok).toBe(grokUsageReading);
  });
});

describe('grok per-turn usage on its stream', () => {
  const harness = {
    command: 'grok', displayName: 'Grok Build', parser: 'claude-stream-json',
    turn: { output: 'json-lines', responseFields: ['result'] },
  } as unknown as AiLocalHarnessDefinition;
  const lines = [
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_0","type":"message","role":"assistant","model":"grok-4.7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}},"parent_tool_use_id":null,"session_id":"s","uuid":"u1"}',
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":20482,"output_tokens":28,"cache_read_input_tokens":1280,"cache_creation_input_tokens":0}},"parent_tool_use_id":null,"session_id":"s","uuid":"u2"}',
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":4838,"duration_api_ms":2770,"num_turns":1,"result":"ok","stop_reason":"end_turn","total_cost_usd":0.01420248,"usage":{"input_tokens":20482,"output_tokens":28,"cache_read_input_tokens":1280,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":0}},"modelUsage":{"grok-4.7-build":{"inputTokens":20482,"outputTokens":28,"cacheReadInputTokens":1280,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.01420248}},"session_id":"s","uuid":"u3"}',
  ];

  it('reports tokens live from message_delta, then the cost from result', () => {
    const turn = createStreamState();
    const readings = lines.map((line) => parseHarnessLine(harness, line, turn).usage);
    expect(readings[1]).toMatchObject({ input: 20482, output: 28, cacheRead: 1280, contextUsed: 21790 });
    expect(readings[2]).toMatchObject({ input: 20482, output: 28, cacheRead: 1280, costUsd: 0.01420248, stopReason: 'completed' });
  });
});
