import { describe, expect, it, vi } from 'vitest';
import { GatewayModelClient } from './gateway-client.js';

const finished = () => new Response('data: {"type":"finish","stopReason":"stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
const step = { system: 's', items: [{ type: 'text', role: 'user', text: 'hi' }], tools: [], onTextDelta: () => undefined } as never;

describe('a Gateway step', () => {
  it('carries the chosen model, and none when the Gateway is to choose', async () => {
    const fetchImpl = vi.fn(async () => finished());
    await new GatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', version: '1', sessionId: 's', model: 'gpt-5.6-sol', fetchImpl: fetchImpl as never }).step(step);
    await new GatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', version: '1', sessionId: 's', fetchImpl: fetchImpl as never }).step(step);
    const hints = fetchImpl.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).hints);
    expect(hints[0]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'auto' });
    expect(hints[1]).not.toHaveProperty('model');
  });

  it('fails a stream that goes silent as retryable incomplete_stream, and cancels it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"par"}\n\n')); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const error = await new GatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', version: '1', idleTimeoutMs: 100, fetchImpl: fetchImpl as never })
      .step(step).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'incomplete_stream', kind: 'other' });
    expect(cancelled).toBe(true);
  });

  it('tells a user out of credit how to add more', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false, error: "You're out of AI credit.", code: 'AI_CREDIT_EXHAUSTED', balanceMicroUsd: '0' }), { status: 402 }));
    const client = new GatewayModelClient({ baseUrl: 'https://g', apiKey: 'k', version: '1', sessionId: 's', fetchImpl: fetchImpl as never });
    await expect(client.step(step)).rejects.toMatchObject({
      kind: 'quota',
      code: 'AI_CREDIT_EXHAUSTED',
      message: "You're out of AI credit. Run `clikcode gateway credit` to add credit.",
    });
  });
});
