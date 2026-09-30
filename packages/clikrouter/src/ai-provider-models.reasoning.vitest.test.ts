import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAiChatTurn } from './ai-provider-models';

const messages = [{ role: 'user' as const, content: 'hi' }];
const sse = (text: string): Response => new Response([
  `data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"${text}"},"finish_reason":null}]}`,
  'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  'data: [DONE]', '',
].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const refused = (message: string): Response => new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });

/** Every request body the SDK sends, answered by `answer`. */
function capture(answer: (body: Record<string, unknown>) => Response): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    return answer(body);
  }));
  return bodies;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('reasoning effort', () => {
  it('goes to each provider under its own parameter', async () => {
    const bodies = capture(() => refused('stop here'));
    await streamAiChatTurn({ provider: 'anthropic', model: 'claude-opus-4-1', apiKey: 'k', messages, reasoningEffort: 'high' }).catch(() => undefined);
    await streamAiChatTurn({ provider: 'openai', model: 'gpt-5.1', apiKey: 'k', messages, reasoningEffort: 'low' }).catch(() => undefined);
    expect(bodies[0]!.thinking).toBeTruthy();
    expect(JSON.stringify(bodies[1])).toMatch(/"reasoning(_effort)?":(\{"effort":)?"low"/);
  });

  it('sends nothing when the session has no effort, or one the standard set lacks', async () => {
    const bodies = capture(() => refused('stop here'));
    await streamAiChatTurn({ provider: 'openai', model: 'gpt-5.1', apiKey: 'k', messages }).catch(() => undefined);
    await streamAiChatTurn({ provider: 'openai', model: 'gpt-5.1', apiKey: 'k', messages, reasoningEffort: 'ultra' }).catch(() => undefined);
    await streamAiChatTurn({ provider: 'anthropic', model: 'claude-opus-4-1', apiKey: 'k', messages }).catch(() => undefined);
    for (const body of bodies) expect(JSON.stringify(body)).not.toMatch(/reasoning|thinking/);
  });

  it('asks again without it when the model refuses it, and does not send it to that model again', async () => {
    const bodies = capture((body) => ('reasoning_effort' in body ? refused('reasoning_effort is not supported for this model') : sse('fine')));
    const first = await streamAiChatTurn({ provider: 'moonshot', model: 'kimi-plain', apiKey: 'k', messages, reasoningEffort: 'high' });
    expect(first.text).toBe('fine');
    expect(bodies.map((body) => 'reasoning_effort' in body)).toEqual([true, false]);
    await streamAiChatTurn({ provider: 'moonshot', model: 'kimi-plain', apiKey: 'k', messages, reasoningEffort: 'high' });
    expect(bodies.map((body) => 'reasoning_effort' in body)).toEqual([true, false, false]);
  });

  it('does not retry a refusal that is about something else', async () => {
    const bodies = capture(() => refused('model not found'));
    await expect(streamAiChatTurn({ provider: 'moonshot', model: 'kimi-other', apiKey: 'k', messages, reasoningEffort: 'high' })).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });
});
