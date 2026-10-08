/** A queued turn runs once, however many submits name it. Two windows send
 * the same queued entry; the first runs and finishes while the second's read
 * of the queue is still in flight, so the second still sees the entry and
 * starts it. Taking the entry off the queue is what claims the turn: the
 * second finds it gone and does not run it. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from './session-turn';
import { enqueueSessionTurn } from './checkpoint';
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

describe('a queued turn submitted twice', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  let server: Server;
  let requests = 0;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-queued-once-'));
    process.env.CLIKCODE_HOME = home;
    requests = 0;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        requests += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answered' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', contextWindow: 32768 });
    const state = await readState();
    const session = {
      id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
      permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'active', workspace: home, title: 'named', name: 'named', nameSource: 'user',
    } as HarnessSession;
    enqueueSessionTurn(session, { id: 'q1', text: 'do the thing', submittedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
    state.sessions.push(session);
    await writeState(state);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs it once: the submit that read the queue before the first run ended does not run it again', async () => {
    // Window A's submit: runs the entry to the end.
    await runSessionTurn(config, 's1', 'do the thing', undefined, { queuedTurnId: 'q1' });
    // Window B's submit, started from a read of the queue that still had the
    // entry (taken before A's run ended).
    await runSessionTurn(config, 's1', 'do the thing', undefined, { queuedTurnId: 'q1' });
    expect(requests).toBe(1);
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.queuedTurns ?? []).toEqual([]);
    expect(session.pendingTurn).toBeUndefined();
    expect(session.messages?.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['do the thing']);
    expect(session.messages?.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });
});
