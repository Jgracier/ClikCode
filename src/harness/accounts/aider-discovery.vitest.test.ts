import { describe, expect, it } from 'vitest';
import { aiderListedModels, openRouterModels, parseEnvFile } from './aider-discovery';

describe('aider discovery', () => {
  it('reads the OpenRouter key Aider’s sign-in writes', () => {
    expect(parseEnvFile('OPENROUTER_API_KEY="sk-or-v1-abc"\n# note\nEMPTY=""\n')).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-abc' });
  });

  it('keeps only the provider’s own names from `aider --list-models`', () => {
    // Aider 0.86.2 matches the query anywhere in the name.
    const printed = 'Models which match "openai/":\n- baseten/openai/gpt-oss-120b\n- openai/gpt-5.4\n- openai/o4-mini\n';
    expect(aiderListedModels(printed, 'openai/')).toEqual(['openai/gpt-5.4', 'openai/o4-mini']);
  });

  it('names OpenRouter’s live models as Aider takes them', () => {
    const json = JSON.stringify({ data: [{ id: 'openrouter/free', name: 'Free Models Router' }, { id: 'anthropic/claude-haiku-4.5' }] });
    expect(openRouterModels(json)).toEqual({
      models: ['openrouter/openrouter/free', 'openrouter/anthropic/claude-haiku-4.5'], labels: { 'openrouter/openrouter/free': 'Free Models Router' },
    });
    expect(openRouterModels('offline')).toEqual({ models: [], labels: {} });
  });
});
