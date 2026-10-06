import { expect, it } from 'vitest';
import { compareProviders, PROVIDER_ORDER } from './options.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';

const harness = (command: string, tier: 'primary' | 'secondary' = 'secondary') => ({ command, tier } as AiLocalHarnessDefinition);

it('lists the chosen providers first, in their order, installed or not', () => {
  const rows = ['gemini', 'openclaw', 'cline', 'kiro', 'hermes', 'opencode', 'antigravity', 'cursor', 'grok', 'codex', 'claude', 'aider']
    .map((command) => ({ harness: harness(command, command === 'gemini' ? 'primary' : 'secondary'), installed: command !== 'codex' }));
  expect(rows.sort(compareProviders).map((row) => row.harness.command)).toEqual([...PROVIDER_ORDER, 'gemini', 'aider']);
  expect(PROVIDER_ORDER).toEqual(['claude', 'codex', 'grok', 'cursor', 'antigravity', 'opencode', 'hermes', 'kiro', 'cline', 'openclaw']);
});

it('puts installed providers first among the rest', () => {
  const rows = [{ harness: harness('aider'), installed: false }, { harness: harness('goose'), installed: true }];
  expect(rows.sort(compareProviders).map((row) => row.harness.command)).toEqual(['goose', 'aider']);
});
