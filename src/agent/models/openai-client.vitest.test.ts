import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationItem, ModelStepRequest } from '../model-client.js';
import { isTurnCancelled } from '../cancellation.js';
import { ModelClientError } from './gateway-client.js';
import { OpenAIModelClient, parseToolArguments, toChatMessages } from './openai-client.js';

/** What the next request gets: SSE chunks written with a pause between them,
 * or a plain error response. */
type Reply =
  | { chunks: (Record<string, unknown> | string)[]; gapMs?: number; hang?: boolean }
  | { status: number; body: string; headers?: Record<string, string> };

let server: http.Server;
let baseUrl: string;
let reply: Reply;
let received: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const current = reply;
      if ('status' in current) { res.writeHead(current.status, { 'content-type': 'application/json', ...current.headers }); res.end(current.body); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      for (const chunk of current.chunks) {
        if (res.destroyed) return;
        res.write(typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}\n\n`);
        if (current.gapMs) await new Promise((resolve) => setTimeout(resolve, current.gapMs));
      }
      if (!current.hang) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => { received = []; });

const delta = (value: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({
  id: 'x', object: 'chat.completion.chunk', model: 'maple-test', choices: [{ index: 0, delta: value, finish_reason: finish }],
});

function request(items: ConversationItem[] = [{ type: 'text', role: 'user', text: 'hi' }], extra: Partial<ModelStepRequest> = {}): ModelStepRequest & { deltas: string[]; reasoning: string[] } {
  const deltas: string[] = [];
  const reasoning: string[] = [];
  return {
    system: 'sys', items, tools: [], deltas, reasoning,
    onTextDelta: (text) => deltas.push(text), onReasoningDelta: (text) => reasoning.push(text), ...extra,
  };
}

describe('OpenAIModelClient', () => {
  it('streams text, reasoning, usage and the served model', async () => {
    reply = { chunks: [
      delta({ role: 'assistant', reasoning_content: 'let me ' }),
      delta({ reasoning: 'think' }),
      delta({ content: 'Hel' }),
      delta({ content: 'lo' }),
      delta({}, 'stop'),
      { choices: [], model: 'maple-test', usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 3 } } },
      'data: [DONE]\n\n',
    ] };
    const client = new OpenAIModelClient({ baseUrl, model: 'maple', contextWindow: 16384, apiKey: 'k', headers: { 'x-extra': '1' }, body: { temperature: 0.1 } });
    const req = request();
    const result = await client.step(req);
    expect(req.deltas).toEqual(['Hel', 'lo']);
    expect(req.reasoning).toEqual(['let me ', 'think']);
    expect(result).toMatchObject({ text: 'Hello', toolCalls: [], stopReason: 'stop', servedModel: 'maple-test', contextWindow: 16384 });
    expect(result.usage).toEqual({ input: 120, output: 7, cached: 100, reasoning: 3 });
    const sent = received[0];
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer k');
    expect(sent.headers['x-extra']).toBe('1');
    expect(sent.body).toMatchObject({ model: 'maple', stream: true, temperature: 0.1, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
    expect(sent.body.tools).toBeUndefined();
  });

  it('accepts a base URL that already ends in /v1 and sends no auth header without a key', async () => {
    reply = { chunks: [delta({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n'] };
    await new OpenAIModelClient({ baseUrl: `${baseUrl}/v1/`, model: 'm' }).step(request());
    expect(received[0].url).toBe('/v1/chat/completions');
    expect(received[0].headers.authorization).toBeUndefined();
  });

  it('assembles tool calls split across chunks, including parallel ones', async () => {
    reply = { gapMs: 2, chunks: [
      delta({ content: 'Doing both.' }),
      delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"hel' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'lo.txt","content":"hi"}' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"a.txt"}' } }] }),
      delta({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ] };
    const tools = [{ name: 'write_file', description: 'Write', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const result = await new OpenAIModelClient({ baseUrl, model: 'm' }).step(request(undefined, { tools }));
    expect(result.text).toBe('Doing both.');
    expect(result.stopReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'write_file', args: { path: 'hello.txt', content: 'hi' } },
      { id: 'call_b', name: 'read_file', args: { path: 'a.txt' } },
    ]);
    expect(received[0].body.tools).toEqual([{ type: 'function', function: { name: 'write_file', description: 'Write', parameters: tools[0].parameters } }]);
  });

  it('marks a call whose arguments are not JSON instead of guessing', async () => {
    reply = { chunks: [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{"command": "ls' } }] }, 'tool_calls'), 'data: [DONE]\n\n'] };
    const result = await new OpenAIModelClient({ baseUrl, model: 'm' }).step(request());
    expect(result.toolCalls[0]).toMatchObject({ id: 'c', name: 'bash', args: {} });
    expect(result.toolCalls[0].argumentsError).toContain('{"command": "ls');
  });

  it('falls back to llama-server timings when no usage is sent', async () => {
    const timings: { value: unknown; elapsedMs: number }[] = [];
    reply = { chunks: [delta({ content: 'x' }, 'stop'), { choices: [], timings: { prompt_n: 20, cache_n: 80, predicted_n: 5, predicted_per_second: 12 } }, 'data: [DONE]\n\n'] };
    const result = await new OpenAIModelClient({ baseUrl, model: 'm', onTimings: (value, elapsedMs) => { timings.push({ value, elapsedMs }); } }).step(request());
    expect(result.usage).toEqual({ input: 100, output: 5, cached: 80 });
    expect(timings).toHaveLength(1);
    expect(timings[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('maps HTTP errors to the loop\'s kinds with the server\'s message', async () => {
    const client = new OpenAIModelClient({ baseUrl, model: 'm', label: 'Local model' });
    const failure = async (status: number, body: string, headers?: Record<string, string>): Promise<ModelClientError> => {
      reply = { status, body, ...(headers ? { headers } : {}) };
      return client.step(request()).then(() => { throw new Error('expected a failure'); }, (error: ModelClientError) => error);
    };
    const auth = await failure(401, JSON.stringify({ error: { message: 'Invalid API Key', type: 'authentication_error' } }));
    expect(auth).toBeInstanceOf(ModelClientError);
    expect(auth).toMatchObject({ kind: 'auth', statusCode: 401 });
    expect(auth.message).toContain('Invalid API Key');
    expect(auth.code).toBeUndefined();

    const quota = await failure(429, JSON.stringify({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }), { 'retry-after': '7' });
    expect(quota).toMatchObject({ kind: 'quota', statusCode: 429, retryAfter: 7 });
    expect(quota.message).toContain('slow down');

    const overflow = await failure(400, JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } }));
    expect(overflow).toMatchObject({ kind: 'other', statusCode: 400, code: 'CONTEXT_TOO_LARGE' });

    const down = await failure(503, 'Loading model');
    expect(down).toMatchObject({ kind: 'other', statusCode: 503 });
    expect(down.message).toBe('Local model returned HTTP 503: Loading model');
    expect(down.code).toBeUndefined();
  });

  it('reports an error frame sent mid-stream', async () => {
    reply = { chunks: [delta({ content: 'par' }), { error: { message: 'model crashed', type: 'server_error' } }] };
    await expect(new OpenAIModelClient({ baseUrl, model: 'm' }).step(request())).rejects.toThrow('model crashed');
  });

  it('treats a stream cut off before finishing as incomplete', async () => {
    reply = { chunks: [delta({ content: 'par' })] };
    await expect(new OpenAIModelClient({ baseUrl, model: 'm' }).step(request())).rejects.toMatchObject({ code: 'incomplete_stream' });
  });

  it('drops a stream that goes silent mid-answer and fails it as retryable incomplete_stream', async () => {
    reply = { chunks: [delta({ content: 'par' })], hang: true };
    const closed = new Promise<void>((resolve) => server.once('request', (_req, res: http.ServerResponse) => res.once('close', () => resolve())));
    const error = await new OpenAIModelClient({ baseUrl, model: 'm', idleTimeoutMs: 200 }).step(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'incomplete_stream', kind: 'other' });
    expect((error as Error).message).toMatch(/sent nothing for 0s/);
    // The connection is let go, not left open behind the error.
    await closed;
  });

  it('waits far longer for the first chunk than between chunks, and still gives up', async () => {
    reply = { chunks: [], hang: true };
    const error = await new OpenAIModelClient({ baseUrl, model: 'm', idleTimeoutMs: 50, firstChunkTimeoutMs: 300 }).step(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'incomplete_stream' });
  });

  it('never cuts a slow answer that keeps arriving', async () => {
    reply = { chunks: [delta({ content: 'a' }), delta({ content: 'b' }), delta({ content: 'c' }), delta({ content: 'd' }), delta({}, 'stop')], gapMs: 80 };
    const result = await new OpenAIModelClient({ baseUrl, model: 'm', idleTimeoutMs: 250 }).step(request());
    expect(result.text).toBe('abcd');
  });

  it('reports an unreachable server as a retryable failure', async () => {
    const error = await new OpenAIModelClient({ baseUrl: 'http://127.0.0.1:1', model: 'm' }).step(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'other' });
    expect((error as ModelClientError).statusCode).toBeUndefined();
  });

  it('stops promptly when the turn is aborted mid-stream', async () => {
    reply = { chunks: [delta({ content: 'a' })], hang: true };
    const controller = new AbortController();
    const req = request(undefined, { signal: controller.signal, onTextDelta: () => controller.abort() });
    const error = await new OpenAIModelClient({ baseUrl, model: 'm' }).step(req).catch((caught: unknown) => caught);
    expect(isTurnCancelled(error)).toBe(true);
  });

  it('sends user images as image_url parts only when configured for vision', async () => {
    const items: ConversationItem[] = [{ type: 'text', role: 'user', text: 'what is this?\n\n[Attached image files: /tmp/a.png]', images: [{ mimeType: 'image/png', data: 'iVBORw0K', name: 'a.png' }] }];
    reply = { chunks: [delta({ content: 'a cat' }, 'stop'), 'data: [DONE]\n\n'] };
    const vision = new OpenAIModelClient({ baseUrl, model: 'm', vision: true });
    expect(vision.acceptsImages).toBe(true);
    await vision.step(request(items));
    expect((received[0].body.messages as unknown[])[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'what is this?\n\n[Attached image files: /tmp/a.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
    ] });
    const plain = new OpenAIModelClient({ baseUrl, model: 'm' });
    expect(plain.acceptsImages).toBe(false);
    await plain.step(request(items));
    expect((received[1].body.messages as unknown[])[1]).toEqual({ role: 'user', content: 'what is this?\n\n[Attached image files: /tmp/a.png]' });
  });
});

describe('toChatMessages', () => {
  it('maps a full conversation, merging runs that templates reject', () => {
    const messages = toChatMessages('sys', [
      { type: 'summary', text: 'earlier work' },
      { type: 'text', role: 'user', text: 'continue' },
      { type: 'text', role: 'assistant', text: 'Reading.' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } },
      { type: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'b' } },
      { type: 'tool_result', id: 'c1', name: 'read_file', output: 'A' },
      { type: 'tool_result', id: 'c2', name: 'read_file', output: 'no such file', isError: true },
      { type: 'text', role: 'assistant', text: 'Done.' },
    ], false);
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Summary of the earlier conversation:\nearlier work\n\ncontinue' },
      { role: 'assistant', content: 'Reading.', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: no such file' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('parseToolArguments', () => {
  it('parses, repairs what is safely repairable, and reports the rest', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ args: { a: 1 } });
    expect(parseToolArguments('')).toEqual({ args: {} });
    expect(parseToolArguments('```json\n{"a":[1,2,],}\n```')).toEqual({ args: { a: [1, 2] } });
    expect(parseToolArguments('"{\\"a\\":1}"')).toEqual({ args: { a: 1 } });
    expect(parseToolArguments('[1]').error).toContain('an array');
    expect(parseToolArguments('{"a":').error).toBeDefined();
  });
});
