import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { agentTurnSettings, readAgentStream, runGatewayAgentTurn, type AgentStreamEvent } from './gateway-agent-turn.js';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://app.test', apiKey: 'account-key' }),
}));

const originalHome = process.env.CLIKCODE_HOME;
const originalFetch = globalThis.fetch;
let root: string | undefined;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = originalHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** An SSE body that writes `frames` (and a keepalive between each), then ends unless `hold`. */
function sse(frames: AgentStreamEvent[], options: { hold?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(': keepalive\n\n'));
        // Split mid-frame, as a network may.
        const text = `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
        controller.enqueue(encoder.encode(text.slice(0, 7)));
        controller.enqueue(encoder.encode(text.slice(7)));
      }
      if (!options.hold) controller.close();
    },
  });
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'gateway-agent-turn-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const now = new Date().toISOString();
  const session = {
    id: 'gw', route: 'gateway' as const, accountId: null, provider: 'gateway', model: 'model-x',
    effort: 'platform-managed', accountFailover: 'never' as const, createdAt: now, updatedAt: now,
    status: 'active' as const, gatewayAgentId: 'agent-1', permissionMode: 'bypass' as const,
  };
  state.sessions.push(session);
  await writeState(state);
  return { state, session };
}

function observer() {
  return {
    phase: vi.fn(), response: vi.fn(), activityEvent: vi.fn(), activity: vi.fn(), render: vi.fn(), setTurnUsage: vi.fn(),
  };
}

const START: AgentStreamEvent = { type: 'start', threadId: 'thread-1', messageId: 'msg-1', agent: { id: 'agent-1', handle: 'silas', name: 'Silas' } };

describe('selected Gateway agent turn, streamed', () => {
  it('asks once, streams the answer and the tool rows, and keeps the conversation and served model', async () => {
    const { state, session } = await setup();
    const fetcher = vi.fn(async () => new Response(sse([
      START,
      { type: 'step' },
      { type: 'tool-start', id: 't1', name: 'admin_jobs', input: { limit: 5 } },
      { type: 'tool-done', id: 't1', ok: true, output: '3 jobs queued' },
      { type: 'step' },
      { type: 'text', text: 'Nothing ' },
      { type: 'text', text: 'is broken.' },
      { type: 'usage', usage: { promptTokens: 4000, outputTokens: 12, cachedInputTokens: 3000 }, served: { provider: 'anthropic', model: 'claude-opus-5-5' } },
      { type: 'done', text: 'Nothing is broken.', usage: { promptTokens: 4000, outputTokens: 12, cachedInputTokens: 3000 }, served: { provider: 'anthropic', model: 'claude-opus-5-5' } },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    globalThis.fetch = fetcher as typeof fetch;
    const prompter = observer();
    await runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'Is anything broken?', run: { prompter: prompter as never } });

    // One request: no queue, no polling.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.test/v1/agents/agent-1/chat');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Is anything broken?', threadId: null, stream: true, model: 'model-x', permissionMode: 'bypass' });
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect(prompter.response.mock.calls).toEqual([['Nothing ', 'append'], ['is broken.', 'append']]);
    const rows = prompter.activityEvent.mock.calls.map((call) => call[0]);
    expect(rows[0]).toMatchObject({ kind: 'tool-start', id: 't1', label: 'silas › admin_jobs limit=5', call: { name: 'admin_jobs', input: { limit: 5 } } });
    expect(rows[1]).toMatchObject({ kind: 'tool-done', id: 't1', label: 'silas › admin_jobs limit=5', output: ['3 jobs queued'] });
    expect(prompter.setTurnUsage).toHaveBeenCalledWith({ input: 4000, output: 12, cacheRead: 3000 });
    const saved = (await readState({ transcripts: ['gw'] })).sessions.find((item) => item.id === 'gw');
    expect(saved).toMatchObject({ gatewayAgentThreadId: 'thread-1', gatewayAgentName: 'Silas', reported: { model: 'claude-opus-5-5' } });
  });

  it('continues the conversation it has', async () => {
    const { state, session } = await setup();
    Object.assign(session, { gatewayAgentThreadId: 'thread-1' });
    const fetcher = vi.fn(async () => new Response(sse([START, { type: 'text', text: 'ok' }, { type: 'done', text: 'ok', usage: { promptTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, served: null }]), { headers: { 'content-type': 'text/event-stream' } }));
    globalThis.fetch = fetcher as typeof fetch;
    await runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'and now?', run: {} });
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ threadId: 'thread-1' });
  });

  it('says a held write the moment it is held', async () => {
    const { state, session } = await setup();
    globalThis.fetch = vi.fn(async () => new Response(sse([
      START,
      { type: 'tool-start', id: 't1', name: 'restart_app', input: { appId: 'a' } },
      { type: 'held', capability: 'restart_app', message: 'restart_app is held for approval (ask mode).' },
      { type: 'tool-done', id: 't1', ok: false, output: 'held for approval', held: true },
      { type: 'text', text: 'I asked to restart it.' },
      { type: 'done', text: 'I asked to restart it.', usage: { promptTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, served: null },
    ]), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const prompter = observer();
    await runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'restart it', run: { prompter: prompter as never } });
    const rows = prompter.activityEvent.mock.calls.map((call) => call[0]);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'tool-error', label: 'Held for approval: restart_app', output: ['restart_app is held for approval (ask mode).'] }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'tool-error', id: 't1', output: expect.arrayContaining(['Held for approval — nothing was changed.']) }));
  });

  it('a refusal is the turn\'s error, with the server\'s reason', async () => {
    const { state, session } = await setup();
    globalThis.fetch = vi.fn(async () => new Response(sse([{ type: 'error', code: 'AI_CREDIT_EXHAUSTED', message: 'No credit.' }]), {
      status: 402, headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
    await expect(runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'hi', run: {} })).rejects.toThrow('No credit.');
  });

  it('Ctrl+C closes the stream (which aborts the run on the server) and ends the turn as cancelled', async () => {
    const { state, session } = await setup();
    const abort = new AbortController();
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined;
      // The body stays open: only the client's own cancel can end this read.
      return new Response(sse([START, { type: 'text', text: 'Half' }], { hold: true }), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const prompter = observer();
    prompter.response.mockImplementation(() => abort.abort(new Error('cancelled by user')));
    await expect(runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'long one', signal: abort.signal, run: { prompter: prompter as never } }))
      .rejects.toThrow('cancelled by user');
    expect(seenSignal).toBe(abort.signal);
  });

  it('a stream that ends without its answer is an error, never a silent empty reply', async () => {
    const { state, session } = await setup();
    globalThis.fetch = vi.fn(async () => new Response(sse([START, { type: 'text', text: 'Hal' }]), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    await expect(runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'hi', run: {} })).rejects.toThrow('ended before the answer finished');
  });

  it('sends the session\'s permission mode and effort, leaving an automatic effort to the agent', () => {
    expect(agentTurnSettings({ model: 'm', effort: 'high', permissionMode: 'bypass' })).toEqual({ model: 'm', effort: 'high', permissionMode: 'bypass' });
    expect(agentTurnSettings({ model: null, effort: 'auto', permissionMode: 'auto' })).toEqual({ model: null, permissionMode: 'auto' });
    expect(agentTurnSettings({ model: 'm', effort: 'platform-managed', permissionMode: undefined })).toEqual({ model: 'm', permissionMode: 'ask' });
  });
});

describe('readAgentStream', () => {
  it('a stream that goes silent past its keepalives is broken', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const read = readAgentStream(body, 20);
    await expect(read.next()).rejects.toThrow('went silent');
  });
});
