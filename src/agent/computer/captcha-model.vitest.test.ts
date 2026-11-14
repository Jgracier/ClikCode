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

describe('voting on spots, reading text, reading a drag', () => {
  it('keeps only spots two or more voters agree on, averaged', async () => {
    const { agreedPoints } = await import('./captcha-model.js');
    const agreed = agreedPoints([[{ x: 0.5, y: 0.34 }, { x: 0.28, y: 0.72 }], [{ x: 0.52, y: 0.36 }, { x: 0.9, y: 0.1 }], [{ x: 0.29, y: 0.71 }]]);
    expect(agreed).toHaveLength(2);
    expect(agreed[0]!.x).toBeCloseTo(0.51); expect(agreed[1]!.y).toBeCloseTo(0.715);
    // One voter alone, however sure, is not enough.
    expect(agreedPoints([[{ x: 0.5, y: 0.5 }], undefined, []])).toEqual([]);
  });

  it('reads the typed text, without spaces, and refuses an implausibly long one', async () => {
    const { parseCaptchaText, askCaptchaText } = await import('./captcha-model.js');
    expect(parseCaptchaText('```json\n{"text": "Xk d7DE"}\n```')).toBe('Xkd7DE');
    expect(parseCaptchaText('{"text": "this is far too long to be a code"}')).toBeUndefined();
    const fake = (text: string): ModelClient => ({ step: async () => ({ text }) } as unknown as ModelClient);
    // The reading most voters agree on wins; a tie goes to the first voter.
    expect(await askCaptchaText({ mimeType: 'image/png', data: 'eA==' }, { modelClientsOf: async () => [fake('{"text":"XKd1DE"}'), fake('{"text":"XKd7DE"}'), fake('{"text":"XKd7DE"}')] })).toBe('XKd7DE');
    expect(await askCaptchaText({ mimeType: 'image/png', data: 'eA==' }, { modelClientsOf: async () => [fake('{"text":"ab12"}'), fake('{"text":"ab1z"}')] })).toBe('ab12');
  });

  it('reads a drag answer and refuses points outside the picture', async () => {
    const { parseDrag } = await import('./captcha-model.js');
    expect(parseDrag('{"from": {"x": 0.1, "y": 0.8}, "to": {"x": 0.62, "y": 0.8}}')).toEqual({ from: { x: 0.1, y: 0.8 }, to: { x: 0.62, y: 0.8 } });
    expect(parseDrag('{"from": {"x": 0.1, "y": 0.8}, "to": {"x": 1.4, "y": 0.8}}')).toBeUndefined();
  });
});

describe('listening to an audio challenge', () => {
  it('sends the clip to the Gateway and falls to the next model when one fails', async () => {
    const { askTranscript, cleanTranscript } = await import('./captcha-model.js');
    const asked: string[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: FormData }) => {
      const model = String(init.body.get('model')); asked.push(model);
      return asked.length === 1 ? new Response('{"error":{}}', { status: 500 }) : new Response(JSON.stringify({ text: ' Their, plan was: simple.' }), { status: 200 });
    }) as unknown as typeof fetch;
    const heard = await askTranscript(Buffer.from('mp3-bytes'), 'audio/mpeg', { fetchImpl, connection: { baseUrl: 'http://gateway.test', apiKey: 'k' } });
    expect(asked).toEqual(['whisper-large-v3', 'whisper-1']);
    expect(cleanTranscript(heard!)).toBe('their plan was simple');
  });
});

describe('ordered spots', () => {
  it('takes, position by position, the point two voters agree on, and gives up when a position has none', async () => {
    const { agreedInOrder } = await import('./captcha-model.js');
    const a = [{ x: 0.3, y: 0.55 }, { x: 0.19, y: 0.34 }], b = [{ x: 0.31, y: 0.54 }, { x: 0.2, y: 0.33 }], stray = [{ x: 0.7, y: 0.2 }, { x: 0.36, y: 0.41 }];
    const agreed = agreedInOrder([a, stray, b]);
    expect(agreed).toHaveLength(2);
    expect(agreed![0]!.x).toBeCloseTo(0.305);
    expect(agreedInOrder([a, stray])).toBeUndefined();
    expect(agreedInOrder([a, undefined])).toBeUndefined();
  });
});

describe('several pieces to drag', () => {
  it('keeps the pieces two voters agree on, by number, and reads fenced JSON', async () => {
    const { agreedDrags, parseDrags } = await import('./captcha-model.js');
    const a = parseDrags('```json\n{"drags":[{"n":2,"from":{"x":0.87,"y":0.37},"to":{"x":0.52,"y":0.56}},{"n":5,"from":{"x":0.86,"y":0.52},"to":{"x":0.32,"y":0.6}}]}\n```')!;
    const b = parseDrags('{"drags":[{"n":5,"from":{"x":0.86,"y":0.52},"to":{"x":0.31,"y":0.59}},{"n":2,"from":{"x":0.87,"y":0.37},"to":{"x":0.53,"y":0.56}}]}')!;
    const stray = parseDrags('{"drags":[{"n":2,"from":{"x":0.91,"y":0.28},"to":{"x":0.64,"y":0.45}}]}')!;
    const agreed = agreedDrags([a, stray, b]);
    expect(agreed.map(d => d.n)).toEqual([2, 5]);
    expect(agreed[0]!.to.x).toBeCloseTo(0.525);
    expect(agreedDrags([a, stray])).toEqual([{ n: 5, from: a[1]!.from, to: a[1]!.to }].slice(0, 0));
    expect(parseDrags('{"drags":[{"n":1,"from":{"x":2,"y":0},"to":{"x":0,"y":0}}]}')).toEqual([]);
  });
});
