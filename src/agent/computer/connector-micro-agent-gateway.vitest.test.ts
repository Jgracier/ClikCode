import { describe, expect, it } from 'vitest';
import { microModels, runGatewayMicro } from './connector-micro-agent-gateway.js';

const reply = (message: unknown): Response => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });

describe('micro-task agent on the Gateway', () => {
  it('runs the tool the model asks for and returns its closing text', async () => {
    const seen: string[] = [];
    const replies = [
      reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"word":"hi"}' } }] }),
      reply({ content: 'RESULT: done' }),
    ];
    const ran = await runGatewayMicro('go', {
      tab: 'agent-x', models: ['claude-sonnet-5'], maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' },
      tools: [{ name: 'echo', class: 'read', description: 'echo', parameters: { type: 'object', properties: {} }, label: () => 'echo', async run(input: { word?: string }) { seen.push(String(input.word)); return { output: `said ${input.word}` }; } } as never],
      fetchImpl: (async (url: unknown, init?: RequestInit) => { if (!String(url).endsWith('/v1/chat/completions')) throw new Error(`bad url ${String(url)}`); seen.push(`model:${JSON.parse(String(init?.body)).model}`); return replies.shift()!; }) as typeof fetch,
    });
    expect(ran).toEqual({ text: 'RESULT: done', timedOut: false, calls: 1 });
    expect(seen).toEqual(['model:claude-sonnet-5', 'hi', 'model:claude-sonnet-5']);
  });

  it('moves to the next model when the Gateway says one is not available, and keeps it for the rest of the run', async () => {
    const asked: string[] = [];
    const ran = await runGatewayMicro('go', {
      tab: 'agent-fallback', models: ['gone-model', 'out-of-credit-model', 'working-model'], maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' }, tools: [],
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const model = JSON.parse(String(init?.body)).model as string;
        asked.push(model);
        if (model === 'gone-model') return new Response(JSON.stringify({ error: { message: 'gone-model is not available to you on the ClikDeploy Gateway right now.' } }), { status: 404 });
        if (model === 'out-of-credit-model') return new Response(JSON.stringify({ error: { message: 'Every provider that could serve this request is out of credit right now.' } }), { status: 402 });
        return reply({ content: 'RESULT: done' });
      }) as typeof fetch,
    });
    expect(ran).toEqual({ text: 'RESULT: done', timedOut: false, calls: 0 });
    expect(asked).toEqual(['gone-model', 'out-of-credit-model', 'working-model']);
  });

  it('gives up with the Gateway\'s own words when every model is unavailable, and when the refusal is not about the model', async () => {
    const none = await runGatewayMicro('go', { tab: 'agent-none', models: ['a-model'], maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' }, tools: [], fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'a-model is not available to you right now.' } }), { status: 404 })) as typeof fetch });
    expect(none.error).toContain('not available to you');
    const asked: string[] = [];
    const other = await runGatewayMicro('go', { tab: 'agent-other', models: ['m1', 'm2'], maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' }, tools: [], fetchImpl: (async (_u: unknown, init?: RequestInit) => { asked.push(JSON.parse(String(init?.body)).model); return new Response(JSON.stringify({ error: { message: 'The request was malformed.' } }), { status: 400 }); }) as typeof fetch });
    // A refusal that is not about the model is not worked around by trying another.
    expect(asked).toEqual(['m1']);
    expect(other.error).toContain('400');
  });

  it('reports a refused request as an error so the caller can fall back', async () => {
    const ran = await runGatewayMicro('go', { tab: 'agent-x', models: ['claude-sonnet-5'], maxCalls: 5, maxMs: 10_000, connection: { baseUrl: 'https://gw.test/v1', apiKey: 'k' }, tools: [], fetchImpl: (async () => new Response('{"error":{"message":"no credit"}}', { status: 402 })) as typeof fetch });
    expect(ran.error).toContain('402');
  });

  it('abandons a tool call that hangs past the time left, so a stuck page cannot hold the vendor', async () => {
    const replies = [reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'stuck', arguments: '{}' } }] }), reply({ content: 'RESULT: gave-up the page hung' })];
    const started = Date.now();
    const ran = await runGatewayMicro('go', { models: ['claude-sonnet-5'],
      tab: 'agent-x', maxCalls: 5, maxMs: 2_500, connection: { baseUrl: 'https://gw.test', apiKey: 'k' },
      tools: [{ name: 'stuck', class: 'read', description: 's', parameters: { type: 'object', properties: {} }, label: () => 's', run: () => new Promise(() => undefined) } as never],
      fetchImpl: (async () => replies.shift()!) as typeof fetch,
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(ran.timedOut).toBe(true);
  });
});

describe('which models run a hand-off', () => {
  it('uses the names the Gateway lists now, in preference order', async () => {
    expect(await microModels(['claude-sonnet-5', 'claude-opus-5', 'gpt-5.2'])).toEqual(['claude-sonnet-5', 'claude-opus-5', 'gpt-5.2']);
  });
  it('asks for the names as written when the list holds none of them', async () => {
    expect((await microModels(['some-other-model']))[0]).toBe('claude-sonnet-5-5');
  });
});
