import { describe, expect, it } from 'vitest';
import { gooseDrivenEnvironment } from './goose-driven-account.js';
import type { AiHarnessAccount } from '../harness/definition.js';

const goose = { modelStrategy: 'goose-providers' } as const;
const driven = (command: string) => ({
  claude: { provider: 'anthropic', profileEnv: 'CLAUDE_CONFIG_DIR' }, codex: { provider: 'openai', profileEnv: 'CODEX_HOME' },
  cursor: { provider: 'cursor', profileEnv: 'HOME' },
} as Record<string, { provider: string; profileEnv: string }>)[command];
const account = (id: string, provider: string, env: string | undefined, more: Partial<AiHarnessAccount> = {}): AiHarnessAccount => ({
  id, provider, label: id, authKind: 'vendor-cli', status: 'ready',
  ...(env ? { nativeProfile: { env, path: `/profiles/${id}` } } : {}), ...more,
} as AiHarnessAccount);

describe('the account Goose drives another CLI as', () => {
  it('points the driven CLI at a signed-in account of its own', () => {
    const accounts = [account('spent', 'anthropic', 'CLAUDE_CONFIG_DIR', { quotaState: 'exhausted' }), account('held', 'anthropic', 'CLAUDE_CONFIG_DIR', { verification: { at: 'now' } }),
      account('out', 'anthropic', 'CLAUDE_CONFIG_DIR', { status: 'needs_login' }), account('good', 'anthropic', 'CLAUDE_CONFIG_DIR'), account('codex', 'openai', 'CODEX_HOME')];
    expect(gooseDrivenEnvironment(goose, 'claude-code/opus', accounts, driven)).toEqual({ CLAUDE_CONFIG_DIR: '/profiles/good' });
    expect(gooseDrivenEnvironment(goose, 'codex/gpt-6-luna', accounts, driven)).toEqual({ CODEX_HOME: '/profiles/codex' });
    // Every signed-in one has run out: still a signed-in one, whose refusal says so.
    expect(gooseDrivenEnvironment(goose, 'claude-code/opus', accounts.slice(0, 3), driven)).toEqual({ CLAUDE_CONFIG_DIR: '/profiles/spent' });
  });

  it('changes nothing for Goose\'s own providers, a default-profile account, a home-directory profile or another harness', () => {
    const accounts = [account('a', 'anthropic', 'CLAUDE_CONFIG_DIR'), account('c', 'cursor', 'HOME')];
    expect(gooseDrivenEnvironment(goose, 'anthropic/claude-sonnet-4', accounts, driven)).toEqual({});
    expect(gooseDrivenEnvironment(goose, null, accounts, driven)).toEqual({});
    expect(gooseDrivenEnvironment(goose, 'cursor-agent/gpt-5', accounts, driven)).toEqual({});
    expect(gooseDrivenEnvironment(goose, 'claude-code/opus', [...accounts, account('default', 'anthropic', undefined)], driven)).toEqual({});
    expect(gooseDrivenEnvironment(goose, 'claude-code/opus', [], driven)).toEqual({});
    expect(gooseDrivenEnvironment({ modelStrategy: 'claude-table' }, 'claude-code/opus', accounts, driven)).toEqual({});
  });
});
