import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import { createStreamState, parseHarnessLine } from '../events/adapters.js';
import { nativeTurnUsage, nativeUsageFromValue } from './turn-usage.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const catalog = (command: string): AiLocalHarnessDefinition => {
  const found = AI_LOCAL_HARNESSES.find((harness) => harness.command === command);
  if (!found) throw new Error(`no ${command} in the catalog`);
  return found;
};

/** The usage the live stream reports after each line, as the turn loop sees it. */
function streamUsage(command: string, lines: readonly string[]) {
  const state = createStreamState();
  return lines.map((line) => parseHarnessLine(catalog(command), line, state).usage).filter(Boolean).at(-1);
}

describe('per-turn usage each vendor actually writes', () => {
  // amp 0.0.1790126705, `amp -x "Reply with just: ok" --stream-json`. The only
  // usage is on the `assistant` record; the `result` has none, so every Amp
  // turn used to record zero tokens.
  const AMP = [
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":4,"cache_creation_input_tokens":38033,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"T-00000000-0000-0000-0000-000000000000"}',
    '{"type":"result","subtype":"success","duration_ms":2956,"is_error":false,"num_turns":1,"result":"ok","session_id":"T-00000000-0000-0000-0000-000000000000"}',
  ];

  it('amp: reads the assistant message, since its result carries no usage', () => {
    expect(streamUsage('amp', AMP)).toMatchObject({ input: 4, output: 4, cacheRead: 0, cacheWrite: 38033 });
  });

  it('amp: two model calls in one turn are summed, not the last one alone', () => {
    const second = AMP[0]!.replace('"input_tokens":4,', '"input_tokens":6,').replace('"cache_creation_input_tokens":38033', '"cache_creation_input_tokens":0').replace('"cache_read_input_tokens":0', '"cache_read_input_tokens":38033');
    expect(streamUsage('amp', [AMP[0]!, second, AMP[1]!])).toMatchObject({ input: 10, output: 8, cacheRead: 38033, cacheWrite: 38033 });
  });

  // qwen 0.24.3 against a local OpenAI-compatible stub (no model turn). The
  // result's totals win; the assistant record gives a figure before it.
  it('qwen: the assistant record reports live, the result has the last word', () => {
    const assistant = '{"type":"assistant","uuid":"u1","session_id":"s1","parent_tool_use_id":null,"message":{"id":"u1","type":"message","role":"assistant","model":"stub-model","content":[{"type":"text","text":"OK"}],"stop_reason":null,"usage":{"input_tokens":1234,"output_tokens":56,"cache_read_input_tokens":1000,"total_tokens":1290}}}';
    const result = '{"type":"result","subtype":"success","uuid":"u2","session_id":"s1","is_error":false,"duration_ms":318,"duration_api_ms":123,"num_turns":1,"result":"OK","usage":{"input_tokens":2468,"output_tokens":112,"cache_read_input_tokens":2000,"total_tokens":2580},"permission_denials":[]}';
    expect(streamUsage('qwen', [assistant])).toMatchObject({ input: 1234, output: 56, cacheRead: 1000, totalTokens: 1290 });
    expect(streamUsage('qwen', [assistant, result])).toMatchObject({ input: 2468, output: 112, cacheRead: 2000, totalTokens: 2580 });
  });

  // goose 1.51.0, `goose run --output-format stream-json` against the stub.
  it('goose: the complete record carries its counts at the top level', () => {
    const complete = '{"type":"complete","total_tokens":1290,"input_tokens":1234,"output_tokens":56,"cache_read_input_tokens":1000,"cache_write_input_tokens":0}';
    expect(streamUsage('goose', [complete])).toEqual({ input: 1234, output: 56, cacheRead: 1000, cacheWrite: 0, totalTokens: 1290 });
  });

  it('a Claude assistant snapshot never lowers what message_delta already counted', () => {
    const start = { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 1 } } } };
    const delta = { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 104 } } };
    const snapshot = { type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 3 } } };
    expect(streamUsage('claude', [start, delta, snapshot].map((line) => JSON.stringify(line)))).toMatchObject({ input: 5, output: 104 });
  });

  // OpenClaw 2026.9.6 `agent --local --json`: the shape its embedded runner
  // builds (agentMeta: usage from the run's accumulator, costUsd,
  // contextTokens, promptTokens).
  it('openclaw: reads meta.agentMeta', () => {
    const document = JSON.stringify({
      payloads: [{ text: 'ok' }],
      meta: {
        durationMs: 2100, finalAssistantVisibleText: 'ok',
        agentMeta: { sessionId: 's', provider: 'anthropic', model: 'm', contextTokens: 200000, promptTokens: 67742,
          usage: { input: 2, output: 3, cacheRead: 67566, cacheWrite: 171, total: 67742 }, costUsd: 0.021 },
      },
    });
    expect(nativeTurnUsage(catalog('openclaw'), document)).toEqual({
      input: 2, output: 3, cacheRead: 67566, cacheWrite: 171, totalTokens: 67742, costUsd: 0.021, contextWindow: 200000, contextUsed: 67742,
    });
  });

  it('an untyped document is never read for counts at its top level', () => {
    expect(nativeUsageFromValue({ input: 3, output: 4 })).toBeUndefined();
  });
});
