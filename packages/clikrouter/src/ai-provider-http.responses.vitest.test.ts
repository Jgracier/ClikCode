// The Responses surface is what OpenAI requires for function tools on reasoning models
// (chat/completions rejects tools+reasoning). Locks request shape and both extractors.
import { describe, it, expect } from 'vitest';
import {
  aggregateResponsesSse,
  buildAiChatRequest,
  extractChatText,
  extractStopReason,
  extractToolCalls,
  extractUsage,
} from './ai-provider-http';

const TOOLS = [{ name: 'set_app_env', description: 'set env', parameters: { type: 'object', properties: {} } }];
// Typed as the builder's own input shape rather than `as never`: `never` is not spreadable, so the
// three `{ ...base }` sites below were TS2698 errors even though the runtime behavior was correct.
const base = {
  provider: 'openai',
  model: 'gpt-5.6-luna',
  apiKey: 'k',
  credentialSource: 'env' as const,
};

describe('openai responses dialect', () => {
  it('routes to /responses ONLY when tools are supplied', () => {
    const withTools = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS } as never);
    expect(withTools.url).toBe('https://api.openai.com/v1/responses');
    expect(withTools.dialect).toBe('openai-responses');

    const noTools = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }] } as never);
    expect(noTools.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(noTools.dialect).toBe('openai-chat');
  });

  it('uses max_output_tokens, flat tools, and instructions for system', () => {
    const b = buildAiChatRequest({
      ...base, system: 'be careful', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 2048,
    } as never);
    const body = b.body as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.instructions).toBe('be careful');
    // flat, NOT nested under `function`
    expect(body.tools).toEqual([{ type: 'function', name: 'set_app_env', description: 'set env', parameters: TOOLS[0].parameters }]);
  });

  it('extracts tool calls from the output array, ignoring reasoning items', () => {
    const payload = { output: [
      { type: 'reasoning', summary: [] },
      { type: 'function_call', name: 'set_app_env', arguments: '{"key":"PORT","value":"8080"}' },
    ] };
    expect(extractToolCalls('openai-responses', payload)).toEqual([
      { name: 'set_app_env', args: { key: 'PORT', value: '8080' } },
    ]);
  });

  it('skips malformed argument JSON instead of throwing away the turn', () => {
    const payload = { output: [
      { type: 'function_call', name: 'bad', arguments: '{not json' },
      { type: 'function_call', name: 'good', arguments: '{"a":1}' },
    ] };
    expect(extractToolCalls('openai-responses', payload)).toEqual([{ name: 'good', args: { a: 1 } }]);
  });

  it('extracts assistant prose from output_text parts', () => {
    const payload = { output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'Set PORT to 8080.' }] },
    ] };
    expect(extractChatText('openai-responses', payload)).toBe('Set PORT to 8080.');
  });

  it('returns empty rather than throwing on an unexpected body', () => {
    expect(extractToolCalls('openai-responses', {})).toEqual([]);
    expect(extractChatText('openai-responses', {})).toBe('');
  });

  // Regression: the Codex `store:false` surface streams the answer as
  // `output_text.delta` events but returns `response.completed` with an EMPTY
  // `output[]` (VERIFIED live 2026-09-05 against gpt-5.6-terra: deltas carried the
  // whole reply, completed.output was []). Returning the terminal frame verbatim
  // made a successful turn read as empty prose → "ended the step without producing
  // any output". The aggregator must splice the streamed text back in.
  it('backfills streamed deltas when response.completed carries an empty output[]', () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.output_text.delta","delta":"po"}',
      'data: {"type":"response.output_text.delta","delta":"ng"}',
      'data: {"type":"response.output_text.done"}',
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1 } } })}`,
      'data: [DONE]',
    ].join('\n');
    const body = aggregateResponsesSse(sse);
    // Text is recovered for the extractor the agent step loop relies on...
    expect(extractChatText('codex-responses', body)).toBe('pong');
    // ...without clobbering the terminal frame's status/usage (cost + stop reason).
    expect(extractStopReason('codex-responses', body)).toBe('stop');
    expect(extractUsage('codex-responses', body).outputTokens).toBe(1);
  });

  it('trusts the terminal frame when it already carries message text (no double-append)', () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] },
      })}`,
    ].join('\n');
    const body = aggregateResponsesSse(sse);
    // Exactly one copy — the deltas are NOT spliced when the frame already has text.
    expect(extractChatText('codex-responses', body)).toBe('hello');
  });
});

// Usage + stop reason from the Responses terminal object — the whole reason a
// Codex subscription turn is billable-visible at all. The `response.completed`
// event's `response` carries `usage`, and aggregateResponsesSse hands that
// exact object back, so these lock both the field mapping and the end-to-end
// SSE path.
describe('responses usage + stop reason', () => {
  // Realistic terminal event body, field names per the Responses API:
  // input_tokens includes cached; output_tokens includes reasoning.
  const completed = {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'PORT is 8080.' }] },
    ],
    usage: {
      input_tokens: 1452,
      input_tokens_details: { cached_tokens: 1280 },
      output_tokens: 312,
      output_tokens_details: { reasoning_tokens: 256 },
      total_tokens: 1764,
    },
  };

  it('maps usage into the AI-SDK shape, decomposing input and output', () => {
    expect(extractUsage('openai-responses', completed)).toEqual({
      inputTokens: 1452,
      outputTokens: 312,
      // input_tokens INCLUDES the cached count on this surface, so the
      // full-rate slice is the difference — the number cost estimation
      // actually multiplies by inMTok.
      uncachedInputTokens: 172,
      cachedInputTokens: 1280,
      // Already inside output_tokens; reported separately so a turn that
      // spends its whole budget reasoning is visible.
      reasoningTokens: 256,
    });
  });

  it('keeps the input decomposition summing back to the reported total', () => {
    const usage = extractUsage('openai-responses', completed);
    expect((usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0)).toBe(
      usage.inputTokens,
    );
  });

  it('never lets a cached count larger than the total produce a negative slice', () => {
    // Defensive: a truncated or inconsistent body must not yield a negative
    // uncached count, which downstream would price as a DISCOUNT.
    const inconsistent = {
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 999 } },
    };
    expect(extractUsage('openai-responses', inconsistent).uncachedInputTokens).toBe(0);
  });

  it('parses usage from the terminal response.completed SSE event end-to-end', () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_text.delta","delta":"PORT is 8080."}',
      `data: ${JSON.stringify({ type: 'response.completed', response: completed })}`,
      'data: [DONE]',
    ].join('\n');
    const body = aggregateResponsesSse(sse);
    expect(extractUsage('codex-responses', body)).toEqual({
      inputTokens: 1452,
      outputTokens: 312,
      uncachedInputTokens: 172,
      cachedInputTokens: 1280,
      reasoningTokens: 256,
    });
    expect(extractStopReason('codex-responses', body)).toBe('stop');
  });

  it('leaves usage absent (not zeroed) when the body carries none', () => {
    expect(extractUsage('codex-responses', {})).toEqual({});
    // Truncated stream: aggregateResponsesSse synthesizes a body from deltas
    // with no usage and no status — nothing may be invented from it.
    const truncated = aggregateResponsesSse(
      'data: {"type":"response.output_text.delta","delta":"par"}',
    );
    expect(extractUsage('codex-responses', truncated)).toEqual({});
    expect(extractStopReason('codex-responses', truncated)).toBeUndefined();
  });

  it('omits individual fields the body does not carry', () => {
    expect(
      extractUsage('codex-responses', { usage: { input_tokens: 10, output_tokens: 3 } }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      // No cache details in the body: every input token was billed at the
      // full rate, which is a fact the body DOES carry, not an invention.
      uncachedInputTokens: 10,
    });
    expect(extractUsage('codex-responses', { usage: { input_tokens: 'NaNsense' } })).toEqual({});
  });

  it('maps stop reasons the way the AI SDK does', () => {
    expect(
      extractStopReason('codex-responses', {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ).toBe('length');
    expect(
      extractStopReason('codex-responses', {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }),
    ).toBe('content-filter');
    expect(
      extractStopReason('codex-responses', {
        status: 'completed',
        output: [{ type: 'function_call', name: 'set_app_env', arguments: '{}' }],
      }),
    ).toBe('tool-calls');
    // A terminal status with no finer detail surfaces as itself.
    expect(extractStopReason('codex-responses', { status: 'failed' })).toBe('failed');
    // No status at all → absent, not invented.
    expect(extractStopReason('codex-responses', {})).toBeUndefined();
  });
});
