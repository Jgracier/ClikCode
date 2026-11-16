import { describe, expect, it } from 'vitest';
import { runGatewayMicro } from './connector-micro-agent-gateway.js';

const reply = (message: unknown): Response => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });

describe('micro-task agent on the Gateway', () => {
  it('runs the tool the model asks for and returns its closing text', async () => {
    const seen: string[] = [];
    const replies = [
      reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"word":"hi"}' } }] }),
      reply({ content: 'RESULT: done' }),
    ];
    const ran = await runGatewayMicro('go', {
      tab: 'agent-x', maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' },
      tools: [{ name: 'echo', class: 'read', description: 'echo', parameters: { type: 'object', properties: {} }, label: () => 'echo', async run(input: { word?: string }) { seen.push(String(input.word)); return { output: `said ${input.word}` }; } } as never],
      fetchImpl: (async (url: unknown, init?: RequestInit) => { if (!String(url).endsWith('/v1/chat/completions')) throw new Error(`bad url ${String(url)}`); seen.push(`model:${JSON.parse(String(init?.body)).model}`); return replies.shift()!; }) as typeof fetch,
    });
    expect(ran).toEqual({ text: 'RESULT: done', timedOut: false, calls: 1 });
    expect(seen).toEqual(['model:claude-sonnet-5-5', 'hi', 'model:claude-sonnet-5-5']);
  });

  it('reports a refused request as an error so the caller can fall back', async () => {
    const ran = await runGatewayMicro('go', { tab: 'agent-x', maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' }, tools: [], fetchImpl: (async () => new Response('{"error":{"message":"no credit"}}', { status: 402 })) as typeof fetch });
    expect(ran.error).toContain('402');
  });

  it('abandons a tool call that hangs past the time left, so a stuck page cannot hold the vendor', async () => {
    const replies = [reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'stuck', arguments: '{}' } }] }), reply({ content: 'RESULT: gave-up the page hung' })];
    const started = Date.now();
    const ran = await runGatewayMicro('go', {
      tab: 'agent-x', maxCalls: 5, maxMs: 2_500, connection: { baseUrl: 'https://gw.test', apiKey: 'k' },
      tools: [{ name: 'stuck', class: 'read', description: 's', parameters: { type: 'object', properties: {} }, label: () => 's', run: () => new Promise(() => undefined) } as never],
      fetchImpl: (async () => replies.shift()!) as typeof fetch,
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(ran.timedOut).toBe(true);
  });
});
