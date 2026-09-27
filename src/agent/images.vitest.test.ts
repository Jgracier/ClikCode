import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './conversation.js';
import { GatewayModelClient } from './models/gateway-client.js';
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

  it('never sends images to the Gateway, whose schema has no field for them', async () => {
    let sent: { items: Record<string, unknown>[] } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent;
      return new Response('data: {"type":"finish","stopReason":"stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const gateway = new GatewayModelClient({ baseUrl: 'http://gateway.test', apiKey: 'k', version: 't', fetchImpl });
    const request: ModelStepRequest = {
      system: 's', tools: [], onTextDelta: () => undefined,
      items: [{ type: 'text', role: 'user', text: 'look [Attached image files: a.png]', images: [{ mimeType: 'image/png', data: 'AAAA' }] }],
    };
    await gateway.step(request);
    expect(sent?.items).toEqual([{ type: 'text', role: 'user', text: 'look [Attached image files: a.png]' }]);
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
