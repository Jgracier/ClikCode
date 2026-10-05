/** What carries a turn on after it ran out of usage on every account, shared
 * by the terminal and the editor. CLIKCODE_HOME is throwaway; no vendor runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../../harness/definition';
import type { HarnessPrompter } from '../../harness/prompter';
import type { HarnessSession } from '../../session/model';
import { readState } from '../../session/state/read';
import { writeState } from '../../session/state/write';
import { forceStoreSession, unforceStoreSession } from '../../session/ephemeral';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt';
import { carryOnAfterExhaustion, type ExhaustionRetryGuard } from './resume-in';

const saved = process.env.CLIKCODE_HOME;
let root: string;
const noPicker = {} as HarnessPrompter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-exhaustion-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  for (const id of ['s1', 's2']) unforceStoreSession(id);
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

const account = (id: string, spent: boolean): AiHarnessAccount => ({
  id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready',
  ...(spent ? { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() } : {}),
} as unknown as AiHarnessAccount);

async function chat(accounts: AiHarnessAccount[], fields: Partial<HarnessSession> = {}, id = 's1'): Promise<void> {
  const state = await readState();
  state.accounts.push(...accounts.filter((item) => !state.accounts.some((known) => known.id === item.id)));
  const now = new Date().toISOString();
  state.sessions.push({
    id, conversationId: id, route: 'local', accountId: accounts[0]?.id ?? null, provider: 'anthropic', model: null, nativeHarness: 'claude',
    effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted', createdAt: now, updatedAt: now, status: 'active',
    messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'done' }], ...fields,
  } as HarnessSession);
  forceStoreSession(id);
  await writeState(state);
}

const queue = (): NonNullable<HarnessSession['queuedTurns']> => [
  { id: 'q1', text: 'and then this', submittedAt: '' },
  { id: 'q2', text: '/model opus', submittedAt: '', kind: 'command' },
  { id: 'q3', text: 'and this too', submittedAt: '' },
  { id: 'q4', text: 'background shell finished', submittedAt: '', kind: 'notification' },
];

describe('running out of usage', () => {
  it('retries on the same provider at most once per interrupted turn, though the retry sends the continuation', async () => {
    await chat([account('a1', false)], { pendingTurn: { prompt: 'fix the parser', response: 'half', startedAt: '', updatedAt: '', outputStarted: true } });
    const guard: ExhaustionRetryGuard = {};
    expect(await carryOnAfterExhaustion(noPicker, 's1', 'fix the parser', guard)).toEqual({ retry: INTERRUPTED_TURN_REQUEST });
    // The continuation ran out as well: no second same-provider retry.
    expect(await carryOnAfterExhaustion(noPicker, 's1', INTERRUPTED_TURN_REQUEST, guard)).toEqual({ stayed: [] });
  });

  it('hands the messages queued behind back once, when nothing here can run them and the chat stays', async () => {
    await chat([account('a1', true)], { queuedTurns: queue() });
    expect(await carryOnAfterExhaustion(noPicker, 's1', 'fix the parser', {})).toEqual({ stayed: ['and then this', 'and this too'] });
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.queuedTurns?.map((item) => item.id)).toEqual(['q2', 'q4']);
  });

  it('leaves the queue alone while an account of the provider can still take it', async () => {
    await chat([account('a1', false)], { queuedTurns: queue() });
    const guard: ExhaustionRetryGuard = { autoResent: 's1\nfix the parser' };
    expect(await carryOnAfterExhaustion(noPicker, 's1', 'fix the parser', guard)).toEqual({ stayed: [] });
    expect((await readState()).sessions.find((item) => item.id === 's1')!.queuedTurns).toHaveLength(4);
  });
});
