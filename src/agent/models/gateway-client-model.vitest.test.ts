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
});
