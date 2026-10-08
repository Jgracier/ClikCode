import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';

const stream = vi.fn();
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  streamLocalAiTurn: (request: unknown) => stream(request),
}));
vi.mock('../daemon/server.js', () => ({ localApiKey: () => 'test-key' }));

const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');
const { sendDirectApiTurn } = await import('./direct-turn.js');
const { turnAccountRecorder } = await import('./account-routing.js');

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;
afterEach(async () => {
  stream.mockReset();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const account = (id: string): AiHarnessAccount => ({
  id, provider: 'anthropic', label: id, authKind: 'api-key', models: ['claude-test'], status: 'ready', credentialRef: `env:KEY_${id}`,
});

async function seeded(): Promise<{ state: Awaited<ReturnType<typeof readState>>; session: HarnessSession }> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-direct-turn-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const now = new Date().toISOString();
  const session = {
    id: 'direct-1', conversationId: 'direct-1', route: 'local', accountId: 'first', provider: 'anthropic', model: 'claude-test',
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    name: 'named', nameSource: 'user', messages: [],
  } as HarnessSession;
  state.accounts.push(account('first'), account('second'), account('third'));
  state.sessions.push(session);
  await writeState(state);
  return { state, session };
}

const storedAccount = async (): Promise<string | null | undefined> => (await readState()).sessions.find((item) => item.id === 'direct-1')?.accountId;

describe('the account a turn moves to', () => {
  it('becomes the conversation\'s, when nobody chose another meanwhile', async () => {
    const { state, session } = await seeded();
    await turnAccountRecorder(session, () => writeState(state))(account('second'));
    expect(await storedAccount()).toBe('second');
  });

  it('does not overwrite an account the user chose in another window during the turn', async () => {
    const { state, session } = await seeded();
    const window = await readState();
    window.sessions.find((item) => item.id === 'direct-1')!.accountId = 'third';
    await writeState(window);
    await turnAccountRecorder(session, () => writeState(state))(account('second'));
    await writeState(state);
    expect(await storedAccount()).toBe('third');
  });
});

describe('a direct API-key turn', () => {
  it('stops on Esc instead of retrying the request on every other account', async () => {
    const { state, session } = await seeded();
    const controller = new AbortController();
    stream.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    await expect(sendDirectApiTurn({
      state, session, account: state.accounts[0]!, model: 'claude-test', text: 'hello',
      prepared: { textContext: '', images: [] } as never, turnText: 'hello', startedAt: Date.now(), signal: controller.signal, run: {},
    })).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(session.accountId).toBe('first');
  });
});
