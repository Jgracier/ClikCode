/** A message typed while ClikCode's own agent is running reaches that turn.
 *
 * The Gateway / ClikCode Local path never bound the live-input queue nor
 * published a steer handler, so a message typed mid-turn waited for the turn
 * to end, was then refused, and was gone. These run a real turn against a
 * real OpenAI-compatible HTTP server standing in for the model. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from './session-turn';
import { LiveTurnInputBroker } from './live-input';
import { readState } from '../session/state/read';
import { writeState } from '../session/state/write';
import type { HarnessSession } from '../session/model';

const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn() }));
vi.mock('../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModelsOnExit: () => undefined,
}));

const config = { get: () => undefined } as never;

interface ModelRequest { body: { messages: { role: string; content: unknown }[] }; respond: (text: string) => void }

/** An OpenAI-compatible server whose every request waits for the test to answer it. */
async function fakeModel(): Promise<{ server: Server; url: string; next: () => Promise<ModelRequest> }> {
  const arrived: ModelRequest[] = [];
  let waiter: ((request: ModelRequest) => void) | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const request: ModelRequest = {
        body: JSON.parse(raw) as ModelRequest['body'],
        respond: (text) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        },
      };
      if (waiter) { const deliver = waiter; waiter = undefined; deliver(request); } else arrived.push(request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    server, url: `http://127.0.0.1:${port}/v1`,
    next: () => arrived.length ? Promise.resolve(arrived.shift()!) : new Promise((resolve) => { waiter = resolve; }),
  };
}

const local = (workspace: string): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
  permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', workspace, title: 'already named',
} as HarnessSession);

describe('a message typed during a ClikCode agent turn', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  beforeEach(async () => {
    process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-agent-steer-'));
    model = await fakeModel();
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: model.url, model: 'test-model', contextWindow: 32768 });
    const state = await readState();
    state.sessions.push(local(process.env.CLIKCODE_HOME));
    await writeState(state);
  });
  afterEach(async () => {
    model.server.closeAllConnections();
    await new Promise((resolve) => model.server.close(resolve));
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('is steered into the running turn and answered before the turn ends', async () => {
    const liveInput = new LiveTurnInputBroker();
    const turn = runSessionTurn(config, 's1', 'first question', undefined, { liveInput });
    const first = await model.next();
    // Before the fix this never settled while the turn ran: nothing had bound the queue.
    const typed = await liveInput.submit('and also this', 'typed-1');
    expect(typed.disposition).toBe('steered');
    first.respond('answer one');
    const second = await model.next();
    expect(JSON.stringify(second.body.messages.at(-1))).toContain('and also this');
    second.respond('answer two');
    await turn;
    liveInput.close();
    const saved = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(saved.queuedTurns ?? []).toEqual([]);
    expect(JSON.stringify(saved.messages)).toContain('and also this');
  }, 30_000);

  it('typed after the loop has finished is queued durably for the next turn, not dropped', async () => {
    const liveInput = new LiveTurnInputBroker();
    const turn = runSessionTurn(config, 's1', 'first question', undefined, { liveInput });
    (await model.next()).respond('done');
    await turn;
    const late = await liveInput.submit('one more', 'typed-2');
    expect(late.disposition).toBe('queued');
    const saved = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(saved.queuedTurns?.map((item) => item.text)).toEqual(['one more']);
  }, 30_000);
});
