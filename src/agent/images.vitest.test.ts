import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactConversation } from './context.js';
import { ConversationStore } from './conversation.js';
import { sniffImage } from './images.js';
import { gatewayModelClient } from './models/for-session.js';
import type { ConversationItem, ModelClient, ModelStepRequest } from './model-client.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { ScriptedModelClient } from './testing.js';

let root: string;
let cwd: string;
let stateDir: string;
let counter = 0;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-images-')));
  cwd = path.join(root, 'work');
  stateDir = path.join(root, 'state');
  await Promise.all([cwd, stateDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(cwd, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** A scripted client that claims (or not) to see images. */
function client(acceptsImages: boolean): ScriptedModelClient & ModelClient {
  const scripted = new ScriptedModelClient([{ text: 'seen' }]);
  return Object.assign(scripted, { acceptsImages });
}

async function turn(modelClient: ModelClient, sessionId = `s${++counter}`): Promise<string> {
  await runGatewayHarnessTurn({
    sessionId, cwd, stateDir, homeDir: root, userConfigDir: path.join(root, 'config'), prompt: 'look',
    images: [path.join(cwd, 'shot.png'), path.join(cwd, 'missing.png')], permissionMode: 'bypass', modelClient,
  });
  return sessionId;
}

describe('image input', () => {
  it('reads attached images into the user item for a client that accepts them, keeping the file note', async () => {
    const model = client(true);
    const sessionId = await turn(model);
    const first = model.requests[0].items[0] as Extract<ConversationItem, { type: 'text' }>;
    expect(first.text).toContain('[Attached image files: ');
    expect(first.images).toEqual([{ mimeType: 'image/png', data: 'iVBORw==', name: 'shot.png' }]);

    // Persisted beside the item, and restored with it.
    const raw = await fs.readFile(new ConversationStore(stateDir, sessionId).file, 'utf8');
    const record = JSON.parse(raw.split('\n')[0]) as { item: Record<string, unknown>; images?: unknown };
    expect(record.item.images).toBeUndefined();
    expect(record.images).toEqual(first.images);
    const loaded = await new ConversationStore(stateDir, sessionId).load();
    expect(loaded[0]).toEqual(first);
  });

  it('leaves images out entirely for a client that does not accept them', async () => {
    const model = client(false);
    await turn(model);
    const first = model.requests[0].items[0] as Extract<ConversationItem, { type: 'text' }>;
    expect(first.text).toContain('shot.png');
    expect(first.images).toBeUndefined();
  });

  it('keeps images through a compaction record', async () => {
    const store = new ConversationStore(stateDir, 'compacted');
    const withImage: ConversationItem = { type: 'text', role: 'user', text: 'look', images: [{ mimeType: 'image/png', data: 'AAAA' }] };
    await store.append({ type: 'text', role: 'user', text: 'old' });
    await store.appendCompaction('summary', [{ type: 'text', role: 'assistant', text: 'ok' }, withImage]);
    expect(await store.load()).toEqual([{ type: 'summary', text: 'summary' }, { type: 'text', role: 'assistant', text: 'ok' }, withImage]);
    const raw = await fs.readFile(store.file, 'utf8');
    expect(raw).not.toMatch(/"keep":\[[^\]]*"images"/);
  });

  it('never sends images to the Gateway, which takes text only', async () => {
    let sent: { messages: Array<{ role: string; content: unknown }> } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent;
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const gateway = gatewayModelClient({ baseUrl: 'http://gateway.test', apiKey: 'k', fetchImpl });
    const request: ModelStepRequest = {
      system: 's', tools: [], onTextDelta: () => undefined,
      items: [{ type: 'text', role: 'user', text: 'look [Attached image files: a.png]', images: [{ mimeType: 'image/png', data: 'AAAA' }] }],
    };
    await gateway.step(request);
    expect(sent?.messages[1]).toEqual({ role: 'user', content: 'look [Attached image files: a.png]' });
  });

  it('answers a call with broken JSON arguments without running it', async () => {
    const model = new ScriptedModelClient([
      async () => ({ toolCalls: [{ id: 'bad', name: 'write_file', args: {} }] }),
      { text: 'fixed' },
    ]);
    // ScriptedModelClient has no argumentsError field; wrap its result.
    const wrapped: ModelClient = {
      step: async (request) => {
        const result = await model.step(request);
        return { ...result, toolCalls: result.toolCalls.map((call) => ({ ...call, argumentsError: 'Unexpected end of JSON input' })) };
      },
    };
    await runGatewayHarnessTurn({
      sessionId: `s${++counter}`, cwd, stateDir, homeDir: root, userConfigDir: path.join(root, 'config'), prompt: 'go', permissionMode: 'bypass', modelClient: wrapped,
    });
    const result = model.requests[1].items.find((item) => item.type === 'tool_result');
    expect(result).toMatchObject({ id: 'bad', isError: true });
    expect((result as { output: string }).output).toContain('not a valid JSON object (Unexpected end of JSON input)');
  });
});

/** A real 1x1 PNG. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('read_file shows images', () => {
  async function readPixel(acceptsImages: boolean, file = 'pixel.png'): Promise<{ model: ScriptedModelClient; sessionId: string }> {
    const model = Object.assign(new ScriptedModelClient([{ toolCalls: [{ id: 'r1', name: 'read_file', args: { path: file } }] }, { text: 'a dot' }]), { acceptsImages });
    const sessionId = `s${++counter}`;
    await runGatewayHarnessTurn({
      sessionId, cwd, stateDir, homeDir: root, userConfigDir: path.join(root, 'config'), prompt: 'what is in it?', permissionMode: 'bypass', modelClient: model,
    });
    return { model, sessionId };
  }

  const toolResult = (model: ScriptedModelClient): Extract<ConversationItem, { type: 'tool_result' }> =>
    model.requests[1].items.find((item) => item.type === 'tool_result') as Extract<ConversationItem, { type: 'tool_result' }>;

  beforeEach(async () => { await fs.writeFile(path.join(cwd, 'pixel.png'), Buffer.from(PIXEL_PNG, 'base64')); });

  it('returns the picture as an image part the next step carries, and the store keeps it', async () => {
    const { model, sessionId } = await readPixel(true);
    const result = toolResult(model);
    expect(result.output).toBe('pixel.png is an image (image/png, 1x1, 70 bytes), attached for you to see.');
    expect(result.images).toEqual([{ mimeType: 'image/png', data: PIXEL_PNG, name: 'pixel.png' }]);

    const store = new ConversationStore(stateDir, sessionId);
    const raw = await fs.readFile(store.file, 'utf8');
    const record = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { item: Record<string, unknown>; images?: unknown }).find((entry) => entry.item.type === 'tool_result');
    expect(record?.item.images).toBeUndefined();
    expect(record?.images).toEqual(result.images);
    expect((await store.load()).find((item) => item.type === 'tool_result')).toEqual(result);
  });

  it('says in one line that a model that cannot see images cannot, and sends nothing', async () => {
    const result = toolResult((await readPixel(false)).model);
    expect(result.output).toBe('pixel.png is an image (70 bytes), and the current model cannot see images.');
    expect(result.images).toBeUndefined();
  });

  it('refuses a file named as an image that is not one', async () => {
    await fs.writeFile(path.join(cwd, 'fake.png'), 'not a picture');
    const result = toolResult((await readPixel(true, 'fake.png')).model);
    expect(result).toMatchObject({ isError: true });
    expect(result.images).toBeUndefined();
  });

  it('sends a tool result image as a user image part after the tool messages', async () => {
    let sent: { messages: Array<Record<string, unknown>> } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent;
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const image = { mimeType: 'image/png', data: PIXEL_PNG, name: 'pixel.png' };
    const items: ConversationItem[] = [
      { type: 'text', role: 'user', text: 'look' },
      { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'pixel.png' } },
      { type: 'tool_call', id: 'b', name: 'read_file', args: { path: 'x.ts' } },
      { type: 'tool_result', id: 'a', name: 'read_file', output: 'pixel.png is an image', images: [image] },
      { type: 'tool_result', id: 'b', name: 'read_file', output: '1\tx' },
    ];
    await gatewayModelClient({ baseUrl: 'http://gateway.test', apiKey: 'k', vision: true, fetchImpl }).step({ system: 's', tools: [], onTextDelta: () => undefined, items });
    expect(sent?.messages.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'pixel.png is an image' },
      { role: 'tool', tool_call_id: 'b', content: '1\tx' },
      { role: 'user', content: [{ type: 'text', text: '[Image from the tool results above: pixel.png]' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } }] },
    ]);

    // A model that cannot see images gets the tool text alone.
    await gatewayModelClient({ baseUrl: 'http://gateway.test', apiKey: 'k', fetchImpl }).step({ system: 's', tools: [], onTextDelta: () => undefined, items });
    expect(sent?.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'b', content: '1\tx' });
  });

  it('stops showing old tool images when compacting, and says so', async () => {
    const items: ConversationItem[] = [
      { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'pixel.png' } },
      { type: 'tool_result', id: 'a', name: 'read_file', output: 'pixel.png is an image', images: [{ mimeType: 'image/png', data: PIXEL_PNG }] },
      ...Array.from({ length: 12 }, (_, index): ConversationItem => ({ type: 'text', role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` })),
    ];
    const compacted = await compactConversation({ items, modelClient: new ScriptedModelClient([]), keepRecent: 4, targetTokens: 1_000_000 });
    expect(compacted.stage).toBe('elided');
    const result = compacted.items[1] as Extract<ConversationItem, { type: 'tool_result' }>;
    expect(result.images).toBeUndefined();
    expect(result.output).toContain('no longer shown');
  });

  it('reads the type and size from the header, not the name', () => {
    expect(sniffImage(Buffer.from(PIXEL_PNG, 'base64'))).toEqual({ mimeType: 'image/png', width: 1, height: 1 });
    expect(sniffImage(Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1'))).toEqual({ mimeType: 'image/gif', width: 2, height: 3 });
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40]))).toEqual({ mimeType: 'image/jpeg', width: 64, height: 32 });
    expect(sniffImage(Buffer.from('hello world, not an image'))).toBeUndefined();
  });
});
