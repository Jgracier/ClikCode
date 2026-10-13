/** A vendor with no image input is told so: nothing is sent in its place. The vendor attempt is stubbed. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
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

describe('a vendor that takes no images', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-vendor-images-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState();
    state.accounts.push(account);
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: 'acct-1', provider: 'fake', model: 'm1', effort: 'medium',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', workspace: home,
      title: 'named', name: 'named', nameSource: 'user', attachments: ['/tmp/shot.png'],
    } as HarnessSession);
    await writeState(state);
  });
  afterEach(() => {
    attempt.run.mockReset();
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('is told so and sent nothing: no prompt, and no prose about where the files are', async () => {
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    await expect(sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-1')!, model: 'm1', text: 'what is this?',
      prepared: { images: ['/tmp/shot.png'], textContext: '' } as never, turnText: 'what is this?', startedAt: Date.now(), run: {},
    })).rejects.toThrow(/Image attachments are not available for Fake/);
    expect(attempt.run).not.toHaveBeenCalled();
    expect(session.attachments).toEqual(['/tmp/shot.png']);
  });
});
