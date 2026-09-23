import { describe, expect, it } from 'vitest';
import { impliedHarnessCommand, providerImpliedBy } from './infer-provider.js';
import type { AiHarnessAccount } from '../../harness/definition.js';

const account = (
  provider: string, label: string, models: string[], status: AiHarnessAccount['status'] = 'ready',
) => ({ provider, label, models, status });

const ACCOUNTS = [
  account('anthropic', 'work', ['claude-opus-5', 'claude-sonnet-5']),
  account('openai', 'personal', ['gpt-5', 'shared-model']),
  account('google', 'lab', ['gemini-3-pro', 'shared-model']),
];

describe('the provider a command already named', () => {
  it('derives it from a model only one account publishes', () => {
    expect(providerImpliedBy({ head: 'model', args: 'claude-opus-5' }, ACCOUNTS)).toBe('anthropic');
    expect(providerImpliedBy({ head: 'model', args: 'gpt-5' }, ACCOUNTS)).toBe('openai');
  });

  it('ignores case and stray spacing, which a typed name has', () => {
    expect(providerImpliedBy({ head: 'model', args: '  GPT-5 ' }, ACCOUNTS)).toBe('openai');
  });

  it('asks when two providers publish the same model', () => {
    // A real choice, not a missing one.
    expect(providerImpliedBy({ head: 'model', args: 'shared-model' }, ACCOUNTS)).toBeUndefined();
  });

  it('derives nothing from a model nobody has', () => {
    expect(providerImpliedBy({ head: 'model', args: 'nonexistent-9' }, ACCOUNTS)).toBeUndefined();
  });

  it('derives nothing from a word that names no model', () => {
    // "whatever this harness publishes" is a statement about a provider, not
    // evidence of one.
    expect(providerImpliedBy({ head: 'model', args: 'auto' }, ACCOUNTS)).toBeUndefined();
    expect(providerImpliedBy({ head: 'model', args: '' }, ACCOUNTS)).toBeUndefined();
  });

  it('skips an account that could not run anything', () => {
    const offline = [account('anthropic', 'work', ['claude-opus-5'], 'offline')];
    expect(providerImpliedBy({ head: 'model', args: 'claude-opus-5' }, offline)).toBeUndefined();
  });

  it('derives it from an account label, however it was typed', () => {
    expect(providerImpliedBy({ head: 'account', args: 'personal' }, ACCOUNTS)).toBe('openai');
    expect(providerImpliedBy({ head: 'accounts', args: 'use lab' }, ACCOUNTS)).toBe('google');
  });

  it('derives it from a signed-out account too, which is the point of naming one', () => {
    const out = [account('anthropic', 'work', [], 'needs_login')];
    expect(providerImpliedBy({ head: 'account', args: 'work' }, out)).toBe('anthropic');
  });

  it('derives nothing from an /accounts subcommand that names no account', () => {
    for (const args of ['', 'add', 'remove personal', 'failover on']) {
      expect(providerImpliedBy({ head: 'accounts', args }, ACCOUNTS), args).toBeUndefined();
    }
  });

  it('derives /login when there is only one place to sign in', () => {
    expect(providerImpliedBy({ head: 'login', args: '' }, ACCOUNTS)).toBeUndefined();
    expect(providerImpliedBy({ head: 'login', args: '' }, [ACCOUNTS[0]!])).toBe('anthropic');
  });

  it('derives nothing for a command whose argument says nothing about a provider', () => {
    expect(providerImpliedBy({ head: 'effort', args: 'high' }, ACCOUNTS)).toBeUndefined();
    expect(providerImpliedBy({ head: 'permissions', args: 'bypass' }, ACCOUNTS)).toBeUndefined();
  });
});

describe('the harness a command implies', () => {
  const harnesses: Record<string, { command: string }> = { anthropic: { command: 'claude' }, openai: { command: 'codex' } };
  const lookup = (provider: string) => harnesses[provider];

  it('is the harness of the one provider the command names', () => {
    expect(impliedHarnessCommand({ head: 'model', args: 'claude-opus-5' }, ACCOUNTS, lookup)).toBe('claude');
    expect(impliedHarnessCommand({ head: 'account', args: 'personal' }, ACCOUNTS, lookup)).toBe('codex');
  });

  it('is nothing when the provider is ambiguous, or has no harness', () => {
    expect(impliedHarnessCommand({ head: 'model', args: 'shared-model' }, ACCOUNTS, lookup)).toBeUndefined();
    expect(impliedHarnessCommand({ head: 'account', args: 'lab' }, ACCOUNTS, lookup)).toBeUndefined();
  });
});
