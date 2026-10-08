import { describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';

vi.mock('../../runtime/lazy-bridge.js', () => ({
  harnessSupportsPermissionMode: () => true,
}));
vi.mock('../../harness/accounts/model-catalog.js', () => ({
  harnessModelLabel: (_harness: unknown, model: string) => model,
  nativeModelCatalog: async () => ({ models: [] }),
}));
vi.mock('../../harness/accounts/effort-choices.js', () => ({
  effortChoicesFor: async () => ({ values: [] }),
}));

const { withArgValues } = await import('./arg-values.js');

const harness = {
  command: 'grok', provider: 'xai', displayName: 'Grok', localAuth: ['vendor-cli'], loginArgv: ['login'],
} as AiLocalHarnessDefinition;
const session = {
  id: 'chat', route: 'local', accountId: null, provider: 'grok', nativeHarness: 'grok', model: null,
  effort: 'medium', createdAt: '', updatedAt: '', status: 'active',
} as HarnessSession;

function account(label: string, provider: string, status: AiHarnessAccount['status'] = 'ready'): AiHarnessAccount {
  return { id: label, provider, label, authKind: 'vendor-cli', models: [], status, credentialRef: label };
}

describe('/account palette values', () => {
  it('lists only the chosen provider, matching the catalog id and the command', () => {
    const entries = withArgValues(
      [{ label: '/account', value: '/account' }],
      session,
      harness,
      { accounts: [account('work', 'xai'), account('old', 'grok', 'needs_login'), account('personal', 'openai')], sessions: [] },
    );
    expect(entries[0]?.argValues?.()).toEqual([
      { value: 'work' },
      { value: 'old', detail: 'needs login' },
      { value: 'add grok', label: '+ Add account…', detail: '· Grok' },
    ]);
  });

  it('lists nothing when the chat has no provider yet', () => {
    const entries = withArgValues(
      [{ label: '/account', value: '/account' }],
      { ...session, provider: undefined, nativeHarness: undefined },
      undefined,
      { accounts: [account('work', 'xai'), account('personal', 'openai')], sessions: [] },
    );
    expect(entries[0]?.argValues?.()).toEqual([]);
  });

  it('offers the other side of swarm', () => {
    const off = withArgValues([{ label: '/swarm', value: '/swarm' }], session, harness, { accounts: [], sessions: [] });
    expect(off[0]?.argValues?.()).toEqual([{ value: 'on', label: 'Turn swarm on' }]);
    const on = withArgValues(
      [{ label: '/swarm', value: '/swarm' }],
      { ...session, swarm: true },
      harness,
      { accounts: [], sessions: [] },
    );
    expect(on[0]?.argValues?.()).toEqual([{ value: 'off', label: 'Turn swarm off' }]);
  });
});
