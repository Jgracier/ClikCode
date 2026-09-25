import { describe, expect, it } from 'vitest';
import { opencodeConnect } from './opencode-discovery';

describe('opencode discovery', () => {
  it('offers every known provider that has no connected model, common ones first', () => {
    // Shape of ~/.cache/opencode/models.json (models.dev).
    const cache = JSON.stringify({
      deepinfra: { id: 'deepinfra', name: 'Deep Infra', env: ['DEEPINFRA_API_KEY'] },
      opencode: { id: 'opencode', name: 'OpenCode Zen', env: ['OPENCODE_API_KEY'] },
      openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] },
      anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'] },
      'github-copilot': { id: 'github-copilot', name: 'GitHub Copilot', env: [] },
    });
    const connect = opencodeConnect(cache, ['opencode/big-pickle', 'opencode/claude-fable-5']);
    expect(connect.map((item) => item.id)).toEqual(['anthropic', 'openai', 'github-copilot', 'deepinfra']);
    expect(connect[0]).toEqual({ id: 'anthropic', label: 'Anthropic', detail: 'sign in or paste a key', argv: ['auth', 'login', '--provider', 'anthropic'] });
    expect(connect[2]!.detail).toBe('sign in');
    expect(opencodeConnect('not json', [])).toEqual([]);
  });
});
