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
import { askClickPoints } from './captcha-model.js';

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

describe('an ask over the Gateway', () => {
  it('sends the picture with a system prompt and no tools, to every voter, and answers what they share', async () => {
    reply = { chunks: ['```json\n{"points": [{"x": 0.4, "y": 0.6}]}\n```'] };
    const points = await askClickPoints(image, 'Click the odd one out', { modelClientsOf: async () => [await clientOf(), await clientOf()] });
    expect(points).toHaveLength(1);
    expect(points![0]!.x).toBeCloseTo(0.4);
    expect(received).toHaveLength(2);
    const sent = received[0]!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.body.tools).toBeUndefined();
    const messages = sent.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe('system');
    // The picture rides on the user message as an inline data part.
    const parts = messages[1]!.content as Array<{ type: string }>;
    expect(parts[0]!.type).toBe('text');
    expect(parts[1]!.type).toBe('image_url');
  });

  it('answers nothing, rather than guessing, when no voter can be reached or none makes sense', async () => {
    const broken = async (): Promise<ModelClient> => {
      const { OpenAIModelClient } = await import('../models/openai-client.js');
      return new OpenAIModelClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'x' });
    };
    expect(await askClickPoints(image, 'Click the odd one out', { modelClientsOf: async () => [await broken(), await broken()] })).toBeUndefined();
    reply = { chunks: ['I cannot see anything to click.'] };
    expect(await askClickPoints(image, 'Click the odd one out', { modelClientsOf: async () => [await clientOf(), await clientOf()] })).toBeUndefined();
    expect(await askClickPoints(image, 'Click the odd one out', { modelClientsOf: async () => [] })).toBeUndefined();
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

  it('takes one yes when the widget said a matching square is still unselected', async () => {
    const { askTileMatch } = await import('./captcha-model.js');
    // The majority said no last time and the widget refused that: a single voter that sees the target now decides.
    expect(await askTileMatch({ ...question, lenient: true }, { modelClientsOf: async () => [fake('No'), fake('no'), fake('Yes')] })).toBe(true);
    expect(await askTileMatch({ ...question, lenient: true }, { modelClientsOf: async () => [fake('No'), fake('no'), fake('No')] })).toBe(false);
    expect(await askTileMatch(question, { modelClientsOf: async () => [fake('No'), fake('no'), fake('Yes')] })).toBe(false);
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

describe('reading text and spoken digits', () => {
  it('reads the typed text, without spaces, and refuses an implausibly long one', async () => {
    const { parseCaptchaText, askCaptchaText } = await import('./captcha-model.js');
    expect(parseCaptchaText('```json\n{"text": "Xk d7DE"}\n```')).toBe('Xkd7DE');
    expect(parseCaptchaText('{"text": "this is far too long to be a code"}')).toBeUndefined();
    const fake = (text: string): ModelClient => ({ step: async () => ({ text }) } as unknown as ModelClient);
    // The reading most voters agree on wins; a tie goes to the first voter.
    expect(await askCaptchaText({ mimeType: 'image/png', data: 'eA==' }, { modelClientsOf: async () => [fake('{"text":"XKd1DE"}'), fake('{"text":"XKd7DE"}'), fake('{"text":"XKd7DE"}')] })).toBe('XKd7DE');
    expect(await askCaptchaText({ mimeType: 'image/png', data: 'eA==' }, { modelClientsOf: async () => [fake('{"text":"ab12"}'), fake('{"text":"ab1z"}')] })).toBe('ab12');
  });

  it('spells the code one character at a time when three voters each misread a different character', async () => {
    const { characterVote } = await import('./captcha-model.js');
    expect(characterVote(['K7mP4x', 'K7np4x', 'k7mP4x'])).toBe('K7mP4x');
    // Two readings, or three that split three ways on a character, settle nothing.
    expect(characterVote(['K7mP4x', 'K7np4x'])).toBeUndefined();
    expect(characterVote(['abc', 'abd', 'abe'])).toBeUndefined();
    expect(characterVote(['abc', 'abcd', undefined])).toBeUndefined();
  });

  it('turns spoken numbers into digits', async () => {
    const { spokenDigits } = await import('./captcha-model.js');
    expect(spokenDigits('Seven, two. oh four 9')).toBe('72049');
    expect(spokenDigits('thank you')).toBe('');
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
    expect(agreedDrags([a, stray])).toEqual([]);
    // Two voters agree on piece 5 but not on piece 2: a half-finished line is no answer, so nothing is dragged.
    const wrongTwo = parseDrags('{"drags":[{"n":2,"from":{"x":0.87,"y":0.37},"to":{"x":0.2,"y":0.8}},{"n":5,"from":{"x":0.86,"y":0.52},"to":{"x":0.31,"y":0.59}}]}')!;
    expect(agreedDrags([a, wrongTwo])).toEqual([]);
    // A piece only one voter names is a stray mark, not part of the puzzle.
    const extra = parseDrags('{"drags":[{"n":2,"from":{"x":0.87,"y":0.37},"to":{"x":0.52,"y":0.56}},{"n":5,"from":{"x":0.86,"y":0.52},"to":{"x":0.32,"y":0.6}},{"n":9,"from":{"x":0.1,"y":0.1},"to":{"x":0.2,"y":0.2}}]}')!;
    expect(agreedDrags([a, extra]).map(d => d.n)).toEqual([2, 5]);
    expect(parseDrags('{"drags":[{"n":1,"from":{"x":2,"y":0},"to":{"x":0,"y":0}}]}')).toEqual([]);
  });
});

describe('a voter that declines', () => {
  const fake = (text: string): ModelClient => ({ step: async () => ({ text }) } as unknown as ModelClient);
  const point = (x: number, y: number) => `{"points":[{"x":${x},"y":${y}}]}`;
  const picture = { mimeType: 'image/jpeg', data: 'eA==' };
  const refusal = 'I cannot fulfill this request. I am prohibited from assisting with the bypass of security measures.';

  it('is replaced by the next model in the roster, so three answers vote instead of two', async () => {
    const { askClickPoints, isBenched } = await import('./captcha-model.js');
    // The two models that answered disagree; only the stand-in agrees with one of them. Without a replacement there is no agreement at all.
    const voters = async () => [
      { name: 'declines-1', client: fake(refusal) },
      { name: 'answers-a', client: fake(point(0.3, 0.4)) },
      { name: 'answers-b', client: fake(point(0.8, 0.8)) },
      { name: 'stands-in', client: fake(point(0.31, 0.4)) },
    ];
    const spots = await askClickPoints(picture, 'Click the odd one out', { voters });
    expect(spots).toHaveLength(1);
    expect(spots![0]!.x).toBeCloseTo(0.305, 2);
    // It declined in words, so it sits out for a while.
    expect(isBenched('declines-1')).toBe(true);
    expect(isBenched('answers-a')).toBe(false);
  });

  it('is replaced but not benched when it merely wrote prose with no answer in it', async () => {
    const { askClickPoints, isBenched } = await import('./captcha-model.js');
    const voters = async () => [
      { name: 'rambles', client: fake('There are several icons here and it is hard to say which.') },
      { name: 'ok-1', client: fake(point(0.3, 0.4)) },
      { name: 'ok-2', client: fake(point(0.3, 0.41)) },
      { name: 'spare', client: fake(point(0.9, 0.9)) },
    ];
    expect(await askClickPoints(picture, 'Click the odd one out', { voters })).toHaveLength(1);
    expect(isBenched('rambles')).toBe(false);
  });

  it('leaves the vote with what it has when no stand-in is left', async () => {
    const { askClickPoints } = await import('./captcha-model.js');
    const voters = async () => [
      { name: 'declines-2', client: fake(refusal) },
      { name: 'answers-a', client: fake(point(0.3, 0.4)) },
      { name: 'answers-b', client: fake(point(0.3, 0.41)) },
    ];
    expect(await askClickPoints(picture, 'Click the odd one out', { voters })).toHaveLength(1);
  });
});

describe('picking one of several pictures', () => {
  it('takes the majority pick and refuses a tie or an out-of-range answer', async () => {
    const { askPick } = await import('./captcha-model.js');
    const fake = (text: string): ModelClient => ({ step: async () => ({ text }) } as unknown as ModelClient);
    const images = Array.from({ length: 5 }, () => ({ mimeType: 'image/jpeg', data: 'eA==' }));
    expect(await askPick(images, 'pick the circle', { modelClientsOf: async () => [fake('{"pick": 3}'), fake('```json\n{"pick":3}\n```'), fake('{"pick": 1}')] })).toBe(3);
    expect(await askPick(images, 'pick the circle', { modelClientsOf: async () => [fake('{"pick": 3}'), fake('{"pick": 1}')] })).toBeUndefined();
    expect(await askPick(images, 'pick the circle', { modelClientsOf: async () => [fake('{"pick": 9}'), fake('no idea')] })).toBeUndefined();
  });
});

describe('answering only on a shared whole answer, without waiting for the slowest voter', () => {
  it('needs two voters with the same full set of spots', async () => {
    const { sameAnswer } = await import('./captcha-model.js');
    const two = [{ x: 0.5, y: 0.34 }, { x: 0.28, y: 0.72 }];
    expect(sameAnswer([two, [{ x: 0.29, y: 0.71 }, { x: 0.51, y: 0.35 }], [{ x: 0.9, y: 0.9 }]])).toHaveLength(2);
    // One voter adds a spot: that is not the same answer, even though two spots overlap.
    expect(sameAnswer([two, [...two, { x: 0.72, y: 0.72 }]])).toEqual([]);
    expect(sameAnswer([two, undefined, []])).toEqual([]);
  });

  it('stops waiting once the answers in hand agree', async () => {
    const { untilAgreed } = await import('./captcha-model.js');
    const slow = new Promise<number | undefined>(() => undefined); // never answers
    const got = await untilAgreed([Promise.resolve(3), slow, Promise.resolve(3)], answers => answers.filter(a => a === 3).length >= 2);
    expect(got).toEqual([3, undefined, 3]);
    expect(await untilAgreed([Promise.resolve(1), Promise.reject(new Error('down'))], () => false)).toEqual([1, undefined]);
  });
});

describe('what a vote costs and who sided with the answer', () => {
  const fake = (text: string): ModelClient => ({ step: async () => ({ text }) } as unknown as ModelClient);

  it('counts each ask and marks the voters that gave the answer that was used', async () => {
    const { askPick, newMeter } = await import('./captcha-model.js');
    const meter = newMeter();
    expect(await askPick([image, image, image], 'Pick the cat', { meter, modelClientsOf: async () => [fake('{"pick": 2}'), fake('{"pick": 2}'), fake('{"pick": 3}')] })).toBe(2);
    expect(meter.asks).toBe(3);
    expect(meter.votes.map(vote => vote.withWinner)).toEqual([]);
    // Fake voters have no names, so nothing is scored; the question itself is kept with what each said.
    expect(meter.samples).toHaveLength(1);
    expect(meter.samples[0]).toMatchObject({ roster: 'order', answers: { 'voter-1': '{"pick": 2}', 'voter-3': '{"pick": 3}' } });
  });

  it('runs the subscription voter headless, with no tools but reading the pictures and no session kept', async () => {
    const { subscriptionArgs } = await import('./captcha-subscription.js');
    const claude = subscriptionArgs('claude', 'Q', ['/t/picture-1.png'], '/t', '/t/mcp.json', '/t/final.txt');
    expect(claude).toEqual(expect.arrayContaining(['-p', 'Q', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk']));
    expect(claude[claude.indexOf('--tools') + 1]).toBe('Read');
    const codex = subscriptionArgs('codex', 'Q', ['/t/picture-1.png'], '/t', '/t/mcp.json', '/t/final.txt');
    expect(codex).toEqual(expect.arrayContaining(['exec', '--ephemeral', '--ignore-user-config', '-i', '/t/picture-1.png', '-o', '/t/final.txt']));
    expect(codex.at(-1)).toBe('Q');
  });
});

describe('who sits in a vote', () => {
  it('seats only the subscription models a roster names, best first, and never a paid stand-in', async () => {
    const { seatOrder, STAND_INS } = await import('./captcha-model.js');
    expect(STAND_INS).toEqual([]);
    // What a subscription serves on the Gateway (the caller passes only subscription and free vision models).
    const vision = ['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'qwen4-max'];
    expect(seatOrder('tile', vision).map(seat => seat.id)).toEqual(['gpt-5.6-luna', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-terra']);
    expect(seatOrder('click', vision).map(seat => seat.id).slice(0, 2)).toEqual(['gpt-6-sol', 'gpt-6.1-terra']);
    // A paid model in the list is never seated (it is not in any roster and there are no stand-ins).
    expect(seatOrder('tile', [...vision, 'gpt-4.1-mini']).map(seat => seat.id)).not.toContain('gpt-4.1-mini');
  });
});
