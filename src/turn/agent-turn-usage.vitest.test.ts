/** ClikCode's own agent reports what it streams and what it spends like every
 * other route: streamed text reaches the saved turn as it arrives, and each
 * step's usage reaches the session and the turn's invocation record. These
 * run a real turn against a real OpenAI-compatible HTTP server standing in
 * for the model. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from './session-turn';
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

/** A model server that answers every request with `frames`, then either ends
 * the stream properly or drops the connection mid-answer. */
async function fakeModel(frames: readonly object[], ending: 'done' | 'drop'): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      if (ending === 'drop') setTimeout(() => res.destroy(), 50);
      else res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/v1` };
}

const local = (workspace: string): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
  permissionMode: 'auto', accountFailover: 'never', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', workspace, title: 'already named', name: 'already named', nameSource: 'user',
} as HarnessSession);

describe('a ClikCode agent turn', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  let model: { server: Server; url: string } | undefined;
  const serve = async (frames: readonly object[], ending: 'done' | 'drop'): Promise<void> => {
    model = await fakeModel(frames, ending);
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: model.url, model: 'test-model', contextWindow: 32768 });
  };
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-usage-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState();
    state.sessions.push(local(home));
    await writeState(state);
  });
  afterEach(async () => {
    model?.server.closeAllConnections();
    if (model) await new Promise((resolve) => model!.server.close(resolve));
    model = undefined;
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('records its tokens, carries on a cut-off answer, and says so when it stays cut off', async () => {
    await serve([
      { choices: [{ delta: { content: 'A long answer that stops' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } } },
    ], 'done');
    await runSessionTurn(config, 's1', 'go', undefined, {});
    const state = await readState();
    const session = state.sessions.find((item) => item.id === 's1')!;
    // Every reply here is cut off: the loop carries it on three times, as a
    // vendor CLI does, and then stops and says why. Before, a ClikCode agent
    // turn recorded no tokens at all.
    expect(state.invocations.at(-1)).toMatchObject({ inputTokens: 4 * 1200, outputTokens: 4 * 30, cacheReadTokens: 4 * 1000 });
    expect(session.lastUsage).toMatchObject({ input: 4 * 1200, output: 4 * 30, cacheRead: 4 * 1000, contextWindow: 32768, stopReason: 'max-tokens' });
    expect(session.messages?.at(-1)?.content).toBe('A long answer that stops'.repeat(4));
    expect(session.lastUsage?.contextUsed).toBeGreaterThan(0);
  }, 30_000);

  it('names the model that answered where a vendor\'s own report of its model goes', async () => {
    await serve([
      { model: 'served-7b', choices: [{ delta: { content: 'Hello' } }] },
      { model: 'served-7b', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ], 'done');
    await runSessionTurn(config, 's1', 'go', undefined, {});
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.reported?.model).toBe('served-7b');
  }, 30_000);

  it('keeps what streamed when the turn dies before it completes', async () => {
    await serve([{ choices: [{ delta: { content: 'Half of the answer, streamed' } }] }], 'drop');
    await expect(runSessionTurn(config, 's1', 'go', undefined, {})).rejects.toThrow();
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    // The streamed text reached the saved turn as it arrived; before, a turn
    // that died left an empty pending answer to recover.
    expect(session.pendingTurn?.response).toBe('Half of the answer, streamed');
  }, 30_000);
});
