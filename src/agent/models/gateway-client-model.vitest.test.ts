import { describe, expect, it, vi } from 'vitest';
import { gatewayModelClient } from './for-session.js';

const sse = (...frames: unknown[]) => new Response(`${frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('')}`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const finished = () => sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]');
const step = { system: 's', items: [{ type: 'text', role: 'user', text: 'hi' }], tools: [], onTextDelta: () => undefined } as never;
const sent = (fetchImpl: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe('a Gateway step', () => {
  it('is an OpenAI chat completion on the Gateway\'s API, with the chosen model or `auto`', async () => {
    const fetchImpl = vi.fn(async () => finished());
    await gatewayModelClient({ baseUrl: 'https://g/', apiKey: 'k', sessionId: 's1', model: 'gpt-5.6-sol', fetchImpl: fetchImpl as never }).step(step);
    await gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', sessionId: 's1', fetchImpl: fetchImpl as never }).step(step);
    const first = sent(fetchImpl);
    expect(first.url).toBe('https://g/v1/chat/completions');
    expect(first.headers).toMatchObject({ authorization: 'Bearer k', 'x-session-id': 's1' });
    expect(first.headers['x-client']).toMatch(/^clikcode\//);
    expect(first.body).toMatchObject({ model: 'gpt-5.6-sol', stream: true, stream_options: { include_usage: true } });
    expect(sent(fetchImpl, 1).body.model).toBe('auto');
  });

  it('carries the session\'s effort and speed, and images for a model that takes them', async () => {
    const { gatewayStepOptions } = await import('../../gateway/options.js');
    const fetchImpl = vi.fn(async () => finished());
    const image = { system: 's', items: [{ type: 'text', role: 'user', text: 'look', images: [{ mimeType: 'image/png', data: 'AAAA' }] }], tools: [], onTextDelta: () => undefined } as never;
    await gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', vision: true, options: gatewayStepOptions({ effort: 'high', speed: 'fast' }), fetchImpl: fetchImpl as never }).step(image);
    const body = sent(fetchImpl).body as { reasoning_effort?: string; speed?: string; messages: Array<{ content: unknown }> };
    expect(body).toMatchObject({ reasoning_effort: 'high', speed: 'fast' });
    expect(body.messages[1]!.content).toEqual([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    // No choice made: nothing sent, the model's own default applies.
    expect(gatewayStepOptions({ effort: 'platform-managed' })).toEqual({});
  });

  it('names the request an error came from', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad', code: 'upstream_error' } }), { status: 502, headers: { 'x-request-id': 'chatcmpl-abc' } }));
    await expect(gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never }).step(step)).rejects.toMatchObject({
      code: 'MODEL_ERROR',
      message: expect.stringContaining('[request chatcmpl-abc]'),
    });
  });

  it('reads the model that answered, the window it serves and what the step cost', async () => {
    const fetchImpl = vi.fn(async () => sse(
      { model: 'glm-5', context_window: 200_000, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { model: 'glm-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { model: 'glm-5', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0015 } },
      '[DONE]',
    ));
    const result = await gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never }).step(step);
    expect(result).toMatchObject({ text: 'ok', servedModel: 'glm-5', contextWindow: 200_000, usage: { input: 10, output: 2, costMicroUsd: 1500 } });
    expect(gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k' }).contextHints.hosted).toBe(true);
  });

  it('counts what the provider charged directly beside the charge (the operator is charged 0)', async () => {
    const fetchImpl = vi.fn(async () => sse(
      { model: 'claude-sonnet-5-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      { model: 'claude-sonnet-5-5', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 0.050573 } } },
      '[DONE]',
    ));
    const result = await gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never }).step(step);
    expect(result.usage.costMicroUsd).toBe(50_573);
  });

  it('turns the Gateway\'s codes into the ones the loop acts on', async () => {
    const limited = vi.fn(async () => sse({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded', retry_after: 7 } }));
    await expect(gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: limited as never }).step(step))
      .rejects.toMatchObject({ kind: 'quota', code: 'MODEL_RATE_LIMITED', retryAfter: 7 });
    const disabled = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'off', type: 'server_error', code: 'gateway_disabled' } }), { status: 503 }));
    await expect(gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: disabled as never }).step(step))
      .rejects.toMatchObject({ statusCode: 503, code: 'CLIKCODE_DISABLED' });
  });

  it('fails a stream that goes silent as retryable incomplete_stream, and cancels it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n')); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const client = gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never });
    Object.assign((client as unknown as { options: Record<string, unknown> }).options, { idleTimeoutMs: 100 });
    const error = await client.step(step).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'incomplete_stream', kind: 'other' });
    expect(cancelled).toBe(true);
  });

  it('tells a user out of credit how to add more', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "You're out of AI credit.", type: 'insufficient_quota', code: 'insufficient_credits' } }), { status: 402 }));
    await expect(gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never }).step(step)).rejects.toMatchObject({
      kind: 'quota',
      code: 'AI_CREDIT_EXHAUSTED',
      message: expect.stringMatching(/out of AI credit\..*Run `clikcode gateway credit` to add credit\.$/),
    });
  });

  it('asks for the model\'s output limit and stays inside the Gateway\'s request limits', async () => {
    const fetchImpl = vi.fn(async () => finished());
    const tools = Array.from({ length: 130 }, (_, index) => ({ name: `t${index}`, description: 'd', parameters: { type: 'object' } }));
    await gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', maxOutput: 32_000, contextWindow: 131_072, fetchImpl: fetchImpl as never })
      .step({ ...(step as object), tools, system: 'x'.repeat(70 * 1024) } as never);
    const body = sent(fetchImpl).body as { max_tokens?: number; tools: unknown[]; messages: Array<{ content: string }> };
    expect(body.max_tokens).toBe(32_000);
    expect(body.tools).toHaveLength(128);
    expect(Buffer.byteLength(body.messages[0]!.content)).toBeLessThanOrEqual(64 * 1024);
  });

  it('says what to do about each of the Gateway\'s refusals', async () => {
    const refusal = (code: string, status = 200) => vi.fn(async () => status === 200
      ? sse({ error: { message: `refused (${code}).`, code } })
      : new Response(JSON.stringify({ error: { message: `refused (${code}).`, code } }), { status, headers: { 'retry-after': '42' } }));
    const attempt = (fetchImpl: ReturnType<typeof refusal>) => gatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', fetchImpl: fetchImpl as never }).step(step).catch((error: Error) => error.message);
    expect(await attempt(refusal('model_not_found'))).toMatch(/Pick another model with \/model/);
    expect(await attempt(refusal('rate_limit_exceeded', 429))).toMatch(/Try again in 42s\./);
    expect(await attempt(refusal('gateway_disabled', 503))).toMatch(/turned off for this account/);
    expect(await attempt(refusal('no_model_available'))).toMatch(/No model can take this request right now/);
  });
});
