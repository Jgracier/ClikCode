import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, localHarnessForCommand, localHarnessForProvider, selectLocalHarnessRoute, type AiHarnessAccount } from './ai-local-harness';

const account: AiHarnessAccount = {
  id: 'local-codex',
  provider: 'openai',
  label: 'Work Codex',
  authKind: 'oauth',
  models: ['gpt-5.6'],
  status: 'ready',
  credentialRef: 'keychain://clikdeploy/work-codex',
};

const candidate = {
  accountId: account.id,
  provider: 'openai',
  model: 'gpt-5.6',
  accessClass: 'subscription' as const,
  estimatedCostPerMTok: null,
  contextWindowTokens: 128_000,
};

describe('selectLocalHarnessRoute', () => {
  it('uses the shared router while returning only an account identity, never a credential reference', () => {
    expect(selectLocalHarnessRoute([account], [candidate], { route: 'local', strategy: 'auto' })).toMatchObject({
      route: 'local', accountId: 'local-codex', provider: 'openai', model: 'gpt-5.6',
    });
  });

  it('does not route through an account that is not ready', () => {
    expect(selectLocalHarnessRoute([{ ...account, status: 'needs_login' }], [candidate], {
      route: 'local', strategy: 'auto',
    })).toEqual({ route: 'local', reason: 'no ready local account has an eligible model' });
  });

  it('does not inspect local accounts for an explicitly selected gateway route', () => {
    expect(selectLocalHarnessRoute([account], [candidate], { route: 'gateway', strategy: 'auto' })).toEqual({
      route: 'gateway', reason: 'gateway route explicitly selected',
    });
  });
});

describe('local harness catalog', () => {
  it('uses one reversible command/provider mapping for every supported local harness', () => {
    expect(AI_LOCAL_HARNESSES.map((item) => item.command)).toEqual([
      'claude', 'codex', 'gemini', 'opencode', 'copilot', 'aider', 'goose', 'amp', 'pi',
      'droid', 'kiro', 'qwen', 'cline', 'roo', 'kilo', 'cursor', 'windsurf', 'crush',
      'hermes', 'command',
    ]);
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(localHarnessForCommand(harness.command)).toEqual(harness);
      expect(localHarnessForProvider(harness.provider)).toEqual(harness);
    }
  });
});
