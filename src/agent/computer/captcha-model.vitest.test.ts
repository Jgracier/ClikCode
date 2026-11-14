/** One-shot vision asks that answer a captcha challenge. A picture of the puzzle goes to the
 * account's own ClikDeploy Gateway model -- the same OpenAI-compatible `/v1/chat/completions`
 * the agent loop uses -- and only its answer comes back. This is ClikCode's built-in solver,
 * the same capability other agents get from an external captcha-solving service, except
 * nothing leaves this machine but the puzzle's pixels: no third party, no key to keep, and
 * the local tab keeps its cookies and signed-in profile. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelClient } from '../model-client.js';
import { askCaptchaModel, CAPTCHA_MODEL_PROMPT } from './captcha-model.js';

let server: http.Server;
let baseUrl: string;
let reply: { status?: number; body?: string; chunks?: Array<string | Record<string, unknown>> };
let received: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> });
      const current = reply;
      if (current.status) { res.writeHead(current.status, { 'content-type': 'application/json' }); res.end(current.body ?? '{}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: current.chunks?.join('') ?? '' }, finish_reason: 'stop' }] });
      res.write(`data: ${text}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => { server.close(() => resolve()); });
});

beforeEach(() => { received = []; });

const image = { mimeType: 'image/jpeg', data: 'aGk' };

/** A client against the local SSE server, the shape gatewayModelClient returns. */
const clientOf = async (): Promise<ModelClient> => {
  const { OpenAIModelClient } = await import('../models/openai-client.js');
  return new OpenAIModelClient({ baseUrl, apiKey: 'k', model: 'vision-test', vision: true });
};

describe('askCaptchaModel', () => {
  it('sends the puzzle picture with the strict prompt, no tools, and parses the tile answer', async () => {
    reply = { chunks: ['{"tiles": [0, 3]}'] };
    const result = await askCaptchaModel(image, { modelClientOf: clientOf });
    expect(result).toEqual({ ok: true, answer: { tiles: [0, 3] } });
    const sent = received[0];
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.body.tools).toBeUndefined();
    const messages = sent.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({ role: 'system', content: CAPTCHA_MODEL_PROMPT });
    // The picture rides on the user message as an inline data part.
    const parts = messages[1].content as Array<{ type: string }>;
    expect(parts[0].type).toBe('text');
    expect(parts[1].type).toBe('image_url');
  });

  it('reads an unreadable verdict and strips a chatty fence around the JSON', async () => {
    reply = { chunks: ['sure!\n```json\n{"unreadable": true}\n```\n'] };
    expect(await askCaptchaModel(image, { modelClientOf: clientOf })).toEqual({ ok: true, answer: { unreadable: true } });
  });

  it('drops non-integer or negative tile numbers instead of trusting them', async () => {
    reply = { chunks: ['{"tiles": [1, "2", -1, 3.5, null, 4]}'] };
    expect(await askCaptchaModel(image, { modelClientOf: clientOf })).toEqual({ ok: true, answer: { tiles: [1, 4] } });
  });

  it('reports a bad answer rather than guessing', async () => {
    reply = { chunks: ['I cannot see any tiles in this image.'] };
    expect(await askCaptchaModel(image, { modelClientOf: clientOf })).toEqual({ ok: false, error: 'bad-answer' });
  });

  it('says unreachable when the model server cannot be reached', async () => {
    reply = {};
    const broken = async (): Promise<ModelClient> => {
      const { OpenAIModelClient } = await import('../models/openai-client.js');
      return new OpenAIModelClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'x' });
    };
    expect(await askCaptchaModel(image, { modelClientOf: broken })).toEqual({ ok: false, error: 'unreachable' });
  });
});

describe('one outlined square at a time', () => {
  const fake = (text: string | Error): ModelClient => ({ step: async () => { if (text instanceof Error) throw text; return { text } as never; } } as unknown as ModelClient);
  const question = { image: { mimeType: 'image/jpeg', data: 'eA==' }, instruction: 'Select all squares with buses', target: 'buses', size: 4 };

  it('lets the majority of the models that answered decide, and calls a tie or silence no', async () => {
    const { askTileMatch } = await import('./captcha-model.js');
    expect(await askTileMatch(question, { modelClientsOf: async () => [fake('Yes.'), fake('yes'), fake('No')] })).toBe(true);
    expect(await askTileMatch(question, { modelClientsOf: async () => [fake('No'), fake('Yes'), fake('no.')] })).toBe(false);
    // One model failed: the two that answered decide, and a 1-1 split is no.
    expect(await askTileMatch(question, { modelClientsOf: async () => [fake('Yes'), fake(new Error('down')), fake('No')] })).toBe(false);
    expect(await askTileMatch(question, { modelClientsOf: async () => [fake(new Error('down')), fake('maybe')] })).toBeUndefined();
  });

  it('asks about the outlined square and says how a split photo counts', async () => {
    const { tileQuestionText } = await import('./captcha-model.js');
    expect(tileQuestionText(question)).toMatch(/red-outlined square contain any part of buses\? The squares together form one photo/);
    expect(tileQuestionText({ ...question, size: 3 })).toMatch(/Each square is a separate photo/);
  });
});

describe('where to click on a free-form challenge', () => {
  it('reads a list of points or a single point, fenced or not, and drops ones outside the picture', async () => {
    const { parsePoints } = await import('./captcha-model.js');
    expect(parsePoints('```json\n{"points": [{"x": 0.2, "y": 0.4}, {"x": 1.4, "y": 0.1}]}\n```')).toEqual([{ x: 0.2, y: 0.4 }]);
    expect(parsePoints('The odd one is the star. {"x": 0.53, "y": 0.4}')).toEqual([{ x: 0.53, y: 0.4 }]);
    expect(parsePoints('{"points": []}')).toEqual([]);
    expect(parsePoints('I cannot tell.')).toBeUndefined();
  });
});
