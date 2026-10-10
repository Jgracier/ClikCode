/** A conversation moved onto ClikCode's own agent (the Gateway, ClikCode
 * Local) arrives with its history: the model the agent runs on is told what
 * the conversation did before it, however many harnesses did it. These run a
 * real turn against a real OpenAI-compatible HTTP server standing in for the
 * model and read what the model was sent. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from './session-turn';
import { readState } from '../session/state/read';
import { writeState } from '../session/state/write';
import { redoFrom } from '../session/redo';
import { ConversationStore } from '../agent/conversation';
import { agentItemsFromTurn, agentSeedBudget, AGENT_SEED_CEILING_TOKENS, seedAgentConversation } from './agent-history';
import { canonicalRecord } from '../session/canonical';
import type { HarnessSession, TranscriptMessage } from '../session/model';

const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn() }));
vi.mock('../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModelsOnExit: () => undefined,
}));
// The bridge loads the bundled router; the catalog's own functions stand in.
vi.mock('../runtime/lazy-bridge', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});

const config = { get: () => undefined } as never;
type Sent = { role: string; content?: unknown }[];

/** The text of everything the model was sent, in order, one string per message. */
const said = (messages: Sent): string[] => messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')));

async function fakeModel(requests: Sent[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push((JSON.parse(body) as { messages: Sent }).messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Understood.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}

const claude = { harness: 'claude', route: 'local' as const, provider: 'anthropic', model: 'opus' };
const codex = { harness: 'codex', route: 'local' as const, provider: 'openai', model: 'gpt-6-sol' };
const turn = (request: string, answer: string, origin: TranscriptMessage['origin'], label?: string): TranscriptMessage[] => [
  { role: 'user', content: request, origin },
  { role: 'assistant', content: answer, origin, ...(label ? { activities: [{ responseOffset: 0, event: { kind: 'tool-done' as const, label, category: 'edit' as const, id: `${request}-call` } }] } : {}) },
];

const onAgent = (workspace: string, messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
  permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', workspace, title: 'already named', name: 'already named', nameSource: 'user', messages, ...extra,
} as HarnessSession);

describe('a conversation taken up by ClikCode\'s own agent', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  let model: { server: Server; url: string } | undefined;
  let requests: Sent[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-history-'));
    process.env.CLIKCODE_HOME = home;
    requests = [];
    model = await fakeModel(requests);
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: model.url, model: 'test-model', contextWindow: 32768 });
  });
  afterEach(async () => {
    model?.server.closeAllConnections();
    if (model) await new Promise((resolve) => model!.server.close(resolve));
    model = undefined;
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  async function start(messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): Promise<void> {
    const state = await readState();
    state.sessions.push(onAgent(home, messages, extra));
    await writeState(state);
  }
  const stored = async (): Promise<HarnessSession> => (await readState()).sessions.find((item) => item.id === 's1')!;

  it('tells the model what other harnesses did before it, in order, before the new prompt', async () => {
    await start([
      ...turn('Fix the parser', 'Fixed it in src/parser.ts.', claude, 'Edit src/parser.ts'),
      ...turn('Now add tests', 'Added tests.', claude),
    ]);
    await runSessionTurn(config, 's1', 'What were we doing?', undefined, {});
    expect(requests).toHaveLength(1);
    const text = said(requests[0]!);
    const at = (needle: string): number => text.findIndex((entry) => entry.includes(needle));
    for (const needle of ['Fix the parser', 'Fixed it in src/parser.ts.', 'Edit src/parser.ts', 'Now add tests', 'Added tests.']) {
      expect(at(needle), needle).toBeGreaterThan(-1);
    }
    expect(at('Fix the parser')).toBeLessThan(at('Fixed it in src/parser.ts.'));
    expect(at('Fixed it in src/parser.ts.')).toBeLessThan(at('Now add tests'));
    expect(at('Now add tests')).toBeLessThan(at('What were we doing?'));
    // Said once, at the change of provider.
    expect(text.filter((entry) => entry.includes('the following turns ran on'))).toHaveLength(1);
    expect(text.at(-1)).toContain('What were we doing?');
    const session = await stored();
    expect(session.agentThreadTurns).toBe(3);
    expect(session.messages?.at(-1)?.content).toBe('Understood.');
  }, 30_000);

  it('does not repeat itself on the turn after', async () => {
    await start(turn('Fix the parser', 'Fixed it in src/parser.ts.', claude));
    await runSessionTurn(config, 's1', 'First question', undefined, {});
    await runSessionTurn(config, 's1', 'Second question', undefined, {});
    const second = said(requests[1]!);
    expect(second.filter((entry) => entry.includes('Fix the parser'))).toHaveLength(1);
    expect(second.filter((entry) => entry.includes('First question'))).toHaveLength(1);
    expect((await stored()).agentThreadTurns).toBe(3);
  }, 30_000);

  it('brings in what ran elsewhere while the conversation was away, and only that', async () => {
    await start(turn('Fix the parser', 'Fixed it in src/parser.ts.', claude));
    await runSessionTurn(config, 's1', 'Agent question', undefined, {});
    // Away on Codex for two turns, then back.
    const away = await readState();
    const session = away.sessions.find((item) => item.id === 's1')!;
    session.messages = [...session.messages!, ...turn('Add a retry', 'Retries added in src/net.ts.', codex, 'Edit src/net.ts'), ...turn('Run the suite', 'All green.', codex)];
    await writeState(away);
    await runSessionTurn(config, 's1', 'Welcome back', undefined, {});
    const text = said(requests[1]!);
    for (const needle of ['Add a retry', 'Retries added in src/net.ts.', 'Edit src/net.ts', 'Run the suite', 'All green.']) {
      expect(text.some((entry) => entry.includes(needle)), needle).toBe(true);
    }
    // What it ran itself, and what ran before, are there once.
    expect(text.filter((entry) => entry.includes('Agent question'))).toHaveLength(1);
    expect(text.filter((entry) => entry.includes('Fix the parser'))).toHaveLength(1);
    expect(text.filter((entry) => entry.includes('Add a retry'))).toHaveLength(1);
    expect(text.at(-1)).toContain('Welcome back');
  }, 30_000);

  it('starts the memory over when the conversation is cut back', async () => {
    await start([...turn('One', 'First.', claude), ...turn('Two', 'Second.', claude)]);
    await runSessionTurn(config, 's1', 'Three', undefined, {});
    const state = await readState();
    const session = state.sessions.find((item) => item.id === 's1')!;
    await redoFrom(state, session, 2, { keepFiles: true, stateDir: join(home), who: 'ClikCode', turnIsRunning: async () => false });
    await writeState(state);
    expect(session.agentThreadTurns).toBeUndefined();
    expect((await readdir(join(home, 'sessions', 's1'))).some((name) => name.endsWith('.discarded'))).toBe(true);
    await runSessionTurn(config, 's1', 'Two again', undefined, {});
    const text = said(requests.at(-1)!);
    expect(text.some((entry) => entry.includes('First.'))).toBe(true);
    expect(text.some((entry) => entry.includes('Second.'))).toBe(false);
    expect(text.some((entry) => entry.includes('Three'))).toBe(false);
  }, 30_000);
});

describe('what the agent\'s memory is told', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cc-agent-seed-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });
  const session = (messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): HarnessSession => onAgent(stateDir, messages, extra);

  it('writes a turn as the request, then the answer with its calls as lines', () => {
    const [turnOne] = canonicalRecord(session(turn('Fix it', 'Done.', claude, 'Edit a.ts'))).turns;
    expect(agentItemsFromTurn(turnOne!)).toEqual([
      { type: 'text', role: 'user', text: 'Fix it' },
      // The call began where the answer began, so it comes first.
      { type: 'text', role: 'assistant', text: '[Tool calls: Edit a.ts]\n\nDone.' },
    ]);
  });

  it('writes nothing for a conversation the agent has no turns to add to', async () => {
    expect(await seedAgentConversation({ session: session([]), stateDir })).toEqual({ total: 0, seeded: 0 });
  });

  it('takes a memory from before the count was kept as complete, and an empty one as holding nothing', async () => {
    const chat = session([...turn('One', 'A.', claude), ...turn('Two', 'B.', claude)]);
    const store = new ConversationStore(stateDir, 's1');
    await store.append({ type: 'text', role: 'user', text: 'something it ran' });
    expect(await seedAgentConversation({ session: chat, stateDir })).toEqual({ total: 2, seeded: 0 });
    // A stale count over an empty memory: the memory is what is empty.
    const empty = session([...turn('One', 'A.', claude)], { id: 's2', agentThreadTurns: 5 });
    expect(await seedAgentConversation({ session: empty, stateDir })).toEqual({ total: 1, seeded: 1 });
  });

  describe('how much of a long conversation a switch hands the agent', () => {
    const seededBytes = async (contextWindow: number | undefined): Promise<{ bytes: number; text: string }> => {
      // ~1.5 MB of conversation: far past any budget below.
      const long = Array.from({ length: 1_500 }, (_, index) => turn(`Request ${index}`, `Answer ${index} ${'y'.repeat(900)}`, claude)).flat();
      await seedAgentConversation({ session: session(long), stateDir, ...(contextWindow ? { contextWindow } : {}) });
      const items = await new ConversationStore(stateDir, 's1').load();
      const text = items.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
      return { bytes: Buffer.byteLength(text, 'utf8'), text };
    };
    const ceilingBytes = AGENT_SEED_CEILING_TOKENS * 4;

    it('stops at the ceiling on a very large window, keeps the newest turns and says what it left out', async () => {
      const { bytes, text } = await seededBytes(1_000_000);
      expect(bytes).toBeLessThanOrEqual(ceilingBytes + 2_000);
      expect(bytes).toBeGreaterThan(ceilingBytes * 0.5);
      expect(text).toContain('Request 1499');
      expect(text).not.toContain('Request 0\n');
      expect(text).toMatch(/earlier turns? (is|are) left out/);
    });

    it('is still half the window where that is less than the ceiling', async () => {
      const window = 100_000;
      expect(agentSeedBudget(window)).toBe(window * 0.5 * 4);
      const { bytes } = await seededBytes(window);
      expect(bytes).toBeLessThanOrEqual(window * 0.5 * 4 + 2_000);
      expect(bytes).toBeGreaterThan(window * 0.5 * 4 * 0.5);
    });

    it('takes the ceiling when the window is not known to be smaller than it', () => {
      expect(agentSeedBudget(undefined)).toBeLessThanOrEqual(ceilingBytes);
      expect(agentSeedBudget(10_000_000)).toBe(ceilingBytes);
    });
  });

  it('keeps the newest turns when the model\'s window is small, and says what it left out', async () => {
    const long = Array.from({ length: 40 }, (_, index) => turn(`Request ${index}`, `Answer ${index} ${'x'.repeat(400)}`, claude)).flat();
    const chat = session(long);
    await seedAgentConversation({ session: chat, stateDir, contextWindow: 2_000 });
    const items = await new ConversationStore(stateDir, 's1').load();
    const text = items.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    expect(text).toContain('Request 39');
    expect(text).not.toContain('Request 0\n');
    expect(text).toMatch(/earlier turns? (is|are) left out/);
  });
});
