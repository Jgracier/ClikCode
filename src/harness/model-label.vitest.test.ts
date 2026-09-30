import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import { MODEL_OWNER_NAMES, modelLabel } from './model-label';

describe('modelLabel: a prefix that repeats the provider is dropped', () => {
  it('drops the harness own prefix in either spelling', () => {
    expect(modelLabel('opencode/big-pickle', 'opencode')).toBe('big-pickle');
    expect(modelLabel('opencode:claude-opus-4-5', 'opencode')).toBe('claude-opus-4-5');
    expect(modelLabel('kimi-code/k3', 'kimi')).toBe('k3');
    expect(modelLabel('kilo/openai/gpt-5.1-codex-max', 'kilo')).toBe('openai/gpt-5.1-codex-max');
    expect(modelLabel('kilo:openai/gpt-5.1-codex-max', 'kilo')).toBe('openai/gpt-5.1-codex-max');
    expect(modelLabel('nous:anthropic/claude-opus-5', 'hermes')).toBe('anthropic/claude-opus-5');
    expect(modelLabel('cursor-agent/gpt-5.5', 'cursor')).toBe('gpt-5.5');
    expect(modelLabel('cursor/gpt-5.5', 'cursor')).toBe('gpt-5.5');
    expect(modelLabel('gemini/gemini-3.1-pro', 'gemini')).toBe('gemini-3.1-pro');
    expect(modelLabel('google/gemini-3.1-pro', 'gemini')).toBe('gemini-3.1-pro');
    expect(modelLabel('qwen/qwen3-coder-plus', 'qwen')).toBe('qwen3-coder-plus');
    expect(modelLabel('copilot/gpt-5.4', 'copilot')).toBe('gpt-5.4');
    expect(modelLabel('github-copilot/gpt-5.4', 'copilot')).toBe('gpt-5.4');
    expect(modelLabel('clikcode-local/qwen3-8b', 'clikcode-local')).toBe('qwen3-8b');
    expect(modelLabel('gateway/auto', 'gateway')).toBe('auto');
    expect(modelLabel('kiro-cli/claude-sonnet-4.5', 'kiro')).toBe('claude-sonnet-4.5');
    expect(modelLabel('command-code/jev', 'command')).toBe('jev');
    expect(modelLabel('mistral-vibe/devstral-2', 'vibe')).toBe('devstral-2');
  });

  it('matches the provider by id, catalog provider, or display name', () => {
    expect(modelLabel('opencode/big-pickle', 'OpenCode')).toBe('big-pickle');
    expect(modelLabel('github-copilot/gpt-5.4', 'GitHub Copilot')).toBe('gpt-5.4');
    expect(modelLabel('kimi-code/k3', 'Kimi CLI')).toBe('k3');
    expect(modelLabel('nous:tencent/hy3', 'nous')).toBe('tencent/hy3');
    expect(modelLabel('opencode/big-pickle', undefined, 'OpenCode')).toBe('big-pickle');
    expect(modelLabel('OpenCode/big-pickle', 'opencode')).toBe('big-pickle');
  });

  it('strips only once', () => {
    expect(modelLabel('opencode/opencode/big-pickle', 'opencode')).toBe('opencode/big-pickle');
    expect(modelLabel('opencode:opencode/big-pickle', 'opencode')).toBe('opencode/big-pickle');
    expect(modelLabel('kilo/kilo-auto/balanced', 'kilo')).toBe('kilo-auto/balanced');
  });
});

describe('modelLabel: a prefix naming someone else stays', () => {
  it('keeps the lab of a Gateway model', () => {
    expect(modelLabel('openai/gpt-5.5', 'gateway', 'ClikDeploy Gateway')).toBe('openai/gpt-5.5');
    expect(modelLabel('anthropic/claude-opus-4-5', 'gateway')).toBe('anthropic/claude-opus-4-5');
  });

  it('keeps a lab or routed upstream under a multi-provider harness', () => {
    expect(modelLabel('anthropic/claude-sonnet-4', 'opencode')).toBe('anthropic/claude-sonnet-4');
    expect(modelLabel('anthropic:claude-sonnet-4', 'opencode')).toBe('anthropic/claude-sonnet-4');
    expect(modelLabel('openrouter/anthropic/claude-3-haiku', 'goose')).toBe('openrouter/anthropic/claude-3-haiku');
    expect(modelLabel('cursor-agent/gpt-5.5-medium', 'goose')).toBe('cursor-agent/gpt-5.5-medium');
    expect(modelLabel('copilot:gpt-5.4', 'hermes')).toBe('copilot/gpt-5.4');
    expect(modelLabel('claude-cli/claude-opus-5', 'openclaw')).toBe('claude-cli/claude-opus-5');
    expect(modelLabel('qwen/qwen3.7-flash', 'command')).toBe('qwen/qwen3.7-flash');
    expect(modelLabel('openai/gpt-5.5', 'cline')).toBe('openai/gpt-5.5');
  });

  it('never reads an ollama-style tag as a model', () => {
    expect(modelLabel('qwen:7b', 'qwen')).toBe('qwen:7b');
    expect(modelLabel('kimi:latest', 'kimi')).toBe('kimi:latest');
    expect(modelLabel('llama:instruct', 'aider')).toBe('llama:instruct');
    expect(modelLabel('qwen:instruct', 'qwen')).toBe('qwen:instruct');
    expect(modelLabel('ollama/qwen3:8b', 'goose')).toBe('ollama/qwen3:8b');
  });

  it('leaves unprefixed ids, empty values and unknown providers alone', () => {
    expect(modelLabel('gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelLabel('claude-opus-4-5', 'claude')).toBe('claude-opus-4-5');
    expect(modelLabel('', 'opencode')).toBe('');
    expect(modelLabel(undefined, 'opencode')).toBeUndefined();
    expect(modelLabel(null, 'opencode')).toBeUndefined();
    expect(modelLabel('opencode/big-pickle')).toBe('opencode/big-pickle');
    expect(modelLabel('opencode/big-pickle', undefined, '')).toBe('opencode/big-pickle');
    expect(modelLabel('acme/model-1', 'someone-new')).toBe('acme/model-1');
    expect(modelLabel('someone-new/model-1', 'someone-new')).toBe('model-1');
    expect(modelLabel('opencode/', 'opencode')).toBe('opencode/');
    expect(modelLabel('https://example.com/model', 'aider')).toBe('https://example.com/model');
  });

  it('applies to a vendor label that carries the prefix, and passes other labels through', () => {
    expect(modelLabel('OpenCode/Big Pickle', 'opencode')).toBe('Big Pickle');
    expect(modelLabel('Opus 5.5', 'claude')).toBe('Opus 5.5');
  });
});

describe('MODEL_OWNER_NAMES follows the harness catalog', () => {
  it('uses the same visible form for every harness while preserving upstreams', () => {
    for (const harness of allLocalHarnesses()) {
      expect(modelLabel(`${harness.provider}/model-x`, harness.command), harness.command).toBe('model-x');
      expect(modelLabel('other-lab/model-x', harness.command), harness.command).toBe('other-lab/model-x');
    }
  });

  it('names every harness under its command, with its provider id, binary and display name', () => {
    const bare = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const harness of allLocalHarnesses()) {
      const names = MODEL_OWNER_NAMES[harness.command];
      expect(names, harness.command).toBeDefined();
      const known = new Set([harness.command, ...names!].map(bare));
      for (const name of [harness.provider, harness.binary, harness.displayName]) {
        expect(known.has(bare(name)), `${harness.command}: ${name}`).toBe(true);
      }
    }
  });

  it('shares no name between two providers', () => {
    const bare = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const owner = new Map<string, string>();
    for (const [id, names] of Object.entries(MODEL_OWNER_NAMES)) {
      for (const name of new Set([id, ...names].map(bare))) {
        expect(owner.get(name), `${name} is both ${owner.get(name)} and ${id}`).toBeUndefined();
        owner.set(name, id);
      }
    }
  });
});
