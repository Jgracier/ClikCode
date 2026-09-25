import { describe, expect, it } from 'vitest';
import { openClawInventory } from './openclaw-discovery';

describe('openclaw discovery', () => {
  it('lists runnable models and offers a sign-in for providers with none', () => {
    // Shapes from `models list --all --refresh --json` and `plugins list --json` (2026.9.6).
    const catalog = 'Gateway is not running. Refreshing the local model catalog.\n' + JSON.stringify({ count: 3, models: [
      { key: 'anthropic/claude-opus-5', name: 'Claude Opus 5', available: false, tags: ['default', 'configured', 'alias:opus'] },
      { key: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', available: false, tags: ['configured'] },
      { key: 'claude-cli/claude-haiku-4-5', name: 'Claude Haiku 4.5 (Claude CLI)', available: true, tags: [] },
    ] });
    const plugins = JSON.stringify({ plugins: [
      { id: 'anthropic', name: 'Anthropic', enabled: true, providerIds: ['anthropic'], cliBackendIds: ['claude-cli'] },
      { id: 'openai', name: 'OpenAI', enabled: true, providerIds: ['openai'], cliBackendIds: [] },
      { id: 'google', name: 'Google', enabled: true, providerIds: ['google', 'google-gemini-cli'], cliBackendIds: ['google-gemini-cli'] },
      { id: 'apple-fm', name: 'Apple Foundation Models', enabled: false, providerIds: ['apple-fm'] },
      { id: 'a2a', name: 'A2A', enabled: true, providerIds: [] },
    ] });
    const inventory = openClawInventory(catalog, plugins)!;
    // The default runs through the Claude Code login even though its row says
    // unavailable; the other direct Anthropic model needs a key.
    expect(inventory.models).toEqual(['anthropic/claude-opus-5', 'claude-cli/claude-haiku-4-5']);
    expect(inventory.configured).toBe('anthropic/claude-opus-5');
    expect(inventory.connect.map((item) => [item.id, item.argv.join(' ')])).toEqual([
      ['anthropic', 'models auth login --provider anthropic'],
      ['google', 'models auth login --provider google'],
      ['openai', 'models auth login --provider openai'],
    ]);
    expect(openClawInventory('not json', plugins)).toBeUndefined();
  });
});
