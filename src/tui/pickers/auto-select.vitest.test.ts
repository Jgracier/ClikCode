/** A new chat with no remembered provider picks one without asking: the first
 * installed harness (tier order) the user is signed in to, else the first
 * installed one. Installed is a PATH lookup -- never a version probe, which
 * run per harness took ~12 s to open a chat. CLIKCODE_HOME is throwaway; the
 * PATH lookup, the sign-in evidence and the selection itself are stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';

const vendor = vi.hoisted(() => ({ installed: new Set<string>(), selected: [] as string[] }));
vi.mock('../../harness/transport/native/inspect.js', async (original) => ({
  ...await original<object>(),
  inspectNativeHarnessForPicker: async (spec: { command: string }) => ({ installed: vendor.installed.has(spec.command) }),
  inspectNativeHarness: async () => { throw new Error('no version probe on the way to a new chat'); },
}));
vi.mock('../../harness/accounts/auth-files.js', async (original) => ({ ...await original<object>(), hasAuthEvidence: () => false }));
vi.mock('../../commands/ai/harness.js', async (original) => ({
  ...await original<object>(),
  aiHarnessSelect: async (command: string) => { vendor.selected.push(command); },
}));
const { autoSelectSessionHarness } = await import('./engine.js');

const byTier = (commands: string[]): string[] => allLocalHarnesses()
  .filter((harness) => harnessCanRunTurns(harness) && commands.includes(harness.command))
  .sort((left, right) => harnessTierRank(left) - harnessTierRank(right))
  .map((harness) => harness.command);

beforeEach(async () => {
  vendor.installed = new Set();
  vendor.selected = [];
  const state = await readState({ transcripts: [] });
  state.accounts = [];
  state.sessions = [];
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as HarnessSession);
  await writeState(state);
});
afterEach(() => vi.clearAllMocks());

describe('choosing a provider for a new chat', () => {
  it('the installed harness the user is signed in to beats an earlier tier', async () => {
    const [first, later] = byTier(['codex', 'opencode']);
    vendor.installed = new Set([first!, later!]);
    const state = await readState({ transcripts: [] });
    const provider = allLocalHarnesses().find((harness) => harness.command === later)!.provider;
    state.accounts.push({ id: 'a1', provider, label: 'mine', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:x:default' });
    await writeState(state);
    expect(await autoSelectSessionHarness('s1')).toBe(true);
    expect(vendor.selected).toEqual([later]);
  });

  it('signed in to none: the first installed in tier order', async () => {
    const [first, later] = byTier(['codex', 'opencode']);
    vendor.installed = new Set([later!, first!]);
    expect(await autoSelectSessionHarness('s1')).toBe(true);
    expect(vendor.selected).toEqual([first]);
  });

  it('nothing installed: false, nothing selected', async () => {
    expect(await autoSelectSessionHarness('s1')).toBe(false);
    expect(vendor.selected).toEqual([]);
  });
});
