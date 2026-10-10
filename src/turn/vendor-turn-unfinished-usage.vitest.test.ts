/** A vendor turn that does not complete still spent what its transport reported: the usage goes
 * into the invocation log once, with why the turn ended. Before, only a completed turn recorded
 * it, so a stopped or failed turn's tokens were lost. The vendor attempt is stubbed; the turn
 * driver, the accounts and the state store are real. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';

const attempt = vi.hoisted(() => ({ run: vi.fn() }));
const harness = vi.hoisted(() => ({ command: 'fakecli', provider: 'fake', displayName: 'Fake' }));
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  localHarnessForProvider: () => harness,
  localHarnessForCommand: () => harness,
  harnessCanRunTurns: () => true,
  harnessSupportsImages: () => false,
  harnessLoginArgvForModel: () => undefined,
  harnessReplyError: () => undefined,
}));
vi.mock('../harness/transport/native/inspect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/transport/native/inspect.js')>(),
  ensureNativeHarness: async () => undefined,
}));
vi.mock('../harness/provision.js', () => ({ provisionChosenHarness: async () => ({ mcpInstalled: [], mcpRemoved: [], mcpSkipped: [] }) }));
vi.mock('../search/mcp-entry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../search/mcp-entry.js')>(),
  builtClikcodeLauncher: () => undefined, conversationsForAcpSession: () => [], conversationsMcpEntry: () => undefined,
}));
vi.mock('../session/discovery/cli-listing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session/discovery/cli-listing.js')>(), adoptListedNativeId: async () => false,
}));
vi.mock('../harness/transport/select.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/transport/select.js')>(), sessionTurnTransport: () => 'acp',
}));
vi.mock('./turn-environment.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./turn-environment.js')>(), turnEnvironment: () => ({}),
}));
vi.mock('./vendor-session-attempt.js', () => ({ runVendorSessionAttempt: attempt.run }));

const { sendVendorTurn } = await import('./vendor-turn.js');

const account: AiHarnessAccount = { id: 'acct-1', provider: 'fake', label: 'me', status: 'ready', models: [] } as unknown as AiHarnessAccount;

describe('a vendor turn that does not complete', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-vendor-unfinished-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState();
    state.accounts.push(account);
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: 'acct-1', provider: 'fake', model: 'm1', effort: 'medium',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', workspace: home,
      title: 'named', name: 'named', nameSource: 'user',
    } as HarnessSession);
    await writeState(state);
  });
  afterEach(() => {
    attempt.run.mockReset();
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const turn = async (failure: Error): Promise<HarnessSession['id']> => {
    attempt.run.mockImplementation(async (input: { sharedObserver: { onUsage: (usage: object) => void } }) => {
      input.sharedObserver.onUsage({ input: 500, output: 10 });
      input.sharedObserver.onUsage({ input: 900, output: 25 });
      throw failure;
    });
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    await expect(sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-1')!, model: 'm1', text: 'go',
      prepared: { images: [], textContext: '' } as never, turnText: 'go', startedAt: Date.now(), run: {},
    })).rejects.toThrow(failure.message);
    return session.id;
  };

  it('records a failed turn once, as an error, on the account it ran on', async () => {
    await turn(new Error('the vendor fell over'));
    const recorded = (await readState()).invocations.filter((item) => item.sessionId === 's1');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ accountId: 'acct-1', inputTokens: 900, outputTokens: 25, stopReason: 'error' });
  });

  it('records a stopped turn once, as stopped', async () => {
    await turn(turnCancelledError());
    const recorded = (await readState()).invocations.filter((item) => item.sessionId === 's1');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ accountId: 'acct-1', inputTokens: 900, outputTokens: 25, stopReason: 'stopped' });
  });
});
