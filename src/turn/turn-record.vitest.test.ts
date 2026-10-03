/** Every turn is recorded where every turn path goes through, so /undo acts
 * on the conversation's actual last turn. A turn run in-process (a scripted
 * send with no worker) that made no edits used to record nothing, and /undo
 * then reversed an OLDER turn while calling it "the last turn". This runs a
 * real ClikCode Local turn against a stand-in OpenAI-compatible server. */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from './session-turn';
import { readState } from '../session/state/read';
import { writeState } from '../session/state/write';
import { stateDirectory } from '../session/store/paths';
import { readTurnChanges } from '../session/turn-changes';
import { undoLastTurn } from '../session/undo-turn';
import { FileCheckpointStore } from '../agent/file-checkpoints';
import type { HarnessSession } from '../session/model';

const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn() }));
vi.mock('../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModelsOnExit: () => undefined,
}));

const config = { get: () => undefined } as never;

describe('a turn run with no worker and no edits', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let server: Server;
  let workspace: string;
  beforeEach(async () => {
    process.env.CLIKCODE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cc-turn-record-')));
    workspace = join(process.env.CLIKCODE_HOME, 'work');
    await fs.mkdir(workspace);
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'It says hello.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', contextWindow: 32768 });
    const state = await readState();
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
      permissionMode: 'auto', accountFailover: 'never', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'active', workspace, title: 'named',
    } as HarnessSession);
    await writeState(state);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('is recorded, and /undo says it made no edits instead of undoing an older turn', async () => {
    // An older agent turn's edit, snapshotted.
    const file = join(workspace, 'a.txt');
    await fs.writeFile(file, 'before\n');
    const store = new FileCheckpointStore(stateDirectory());
    await store.snapshot('s1', 'older', file);
    await fs.writeFile(file, 'after\n');
    await store.seal('s1', 'older');

    await runSessionTurn(config, 's1', 'what does a.txt say');
    expect(await readTurnChanges(stateDirectory(), 's1')).toEqual([
      expect.objectContaining({ prompt: 'what does a.txt say', store: 'agent', changes: [] }),
    ]);
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    const undone = await undoLastTurn(session, { stateDir: stateDirectory(), who: 'ClikCode Local' });
    expect(undone.text).toMatch(/^Nothing undone: the turn "what does a\.txt say" made no edits ClikCode saw/);
    expect(await fs.readFile(file, 'utf8')).toBe('after\n');
  }, 30_000);
});
