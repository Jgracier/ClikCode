import { describe, expect, it } from 'vitest';
import { piConfiguredModel, piConnect, piModels, piProviderLabel } from './pi-discovery.js';
import { gooseConnect, gooseModelsDevModels, gooseProviders, modelsDevProvider, providerKeyNames } from './goose-discovery.js';
import { acpSessionModels } from './acp-query.js';

describe('pi discovery', () => {
  it('reads provider/model from the --list-models table', () => {
    // Pi 0.86 output with ANTHROPIC_API_KEY set.
    const listing = [
      'provider   model                       context  max-out  thinking  images',
      'anthropic  claude-fable-5              1M       128K     yes       yes   ',
      'anthropic  claude-haiku-4-5-20251001   200K     64K      yes       yes   ',
    ].join('\n');
    expect(piModels(listing)).toEqual(['anthropic/claude-fable-5', 'anthropic/claude-haiku-4-5-20251001']);
  });

  it('starts on the model Pi itself is set to, as provider/id, only while Pi still lists it', () => {
    const listed = ['openai-codex/gpt-5.3-codex-spark', 'openai-codex/gpt-5.5'];
    const settings = JSON.stringify({ theme: 'dark', defaultProvider: 'openai-codex', defaultModel: 'gpt-5.5' });
    expect(piConfiguredModel(settings, listed)).toBe('openai-codex/gpt-5.5');
    expect(piConfiguredModel(settings, ['openai-codex/gpt-5.3-codex-spark'])).toBeUndefined();
    expect(piConfiguredModel('{"theme":"dark"}', listed)).toBeUndefined();
    expect(piConfiguredModel('not json', listed)).toBeUndefined();
    expect(piConfiguredModel(undefined, listed)).toBeUndefined();
  });

  it('counts a provider key only when it holds one: an empty variable is no key', () => {
    expect(providerKeyNames({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-x', OPENROUTER_API_KEY: '  ', HOME: '/h', GROQ_API_KEY: 'g' })).toEqual(['GROQ_API_KEY', 'OPENAI_API_KEY']);
  });

  it('finds no models in the signed-out notice, whose doc paths are not models', () => {
    const notice = [
      'No models available. Use /login to log into a provider via OAuth or API key. See:',
      '  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
    ].join('\n');
    expect(piModels(notice)).toEqual([]);
  });

  it('offers unconnected providers, signed in to inside Pi', () => {
    const connect = piConnect([
      { id: 'zai', label: 'ZAI' }, { id: 'anthropic', label: 'Anthropic' }, { id: 'xai', label: 'xAI' },
    ], ['xai/grok-5']);
    expect(connect.map((item) => item.id)).toEqual(['anthropic', 'zai']);
    expect(connect[0]).toEqual({ id: 'anthropic', label: 'Anthropic', detail: 'sign in inside Pi', argv: [] });
  });

  it('names a provider after its module, skipping the API-key variant', () => {
    expect(piProviderLabel('name: "Anthropic API key", name: "Anthropic", name: "Anthropic (Claude Pro/Max)"', 'anthropic')).toBe('Anthropic');
    expect(piProviderLabel('', 'zai')).toBe('zai');
  });
});

describe('goose discovery', () => {
  // Shapes of Goose 1.51's `_goose/unstable/providers/*` ACP results.
  const status = { statuses: [
    { providerId: 'anthropic', isConfigured: false }, { providerId: 'claude-code', isConfigured: true },
    { providerId: 'openrouter', isConfigured: true }, { providerId: 'zeta', isConfigured: false },
  ] };
  const setup = { providers: [{ providerId: 'anthropic', name: 'Anthropic' }] };
  const catalog = { providers: [{ providerId: 'openrouter', name: 'OpenRouter' }] };

  it('lists every provider with its name and sign-in state', () => {
    expect(gooseProviders(status, setup, catalog)).toEqual([
      { id: 'anthropic', label: 'Anthropic', configured: false },
      { id: 'claude-code', label: 'claude-code', configured: true },
      { id: 'openrouter', label: 'OpenRouter', configured: true },
      { id: 'zeta', label: 'zeta', configured: false },
    ]);
  });

  it('sets up an unconfigured provider in goose configure, common ones first', () => {
    const connect = gooseConnect(gooseProviders(status, setup, catalog));
    expect(connect.map((item) => item.id)).toEqual(['anthropic', 'zeta']);
    expect(connect[0]).toEqual({
      id: 'anthropic', label: 'Anthropic', detail: 'set up in goose configure', argv: ['configure'],
    });
  });

  it('takes an API provider’s models from the models.dev cache', () => {
    const cache = JSON.stringify({ openrouter: { models: { 'anthropic/claude-5': {}, 'x/y': {} } } });
    expect(gooseModelsDevModels(cache, 'openrouter')).toEqual(['openrouter/anthropic/claude-5', 'openrouter/x/y']);
    expect(gooseModelsDevModels(cache, 'groq')).toEqual([]);
    expect(gooseModelsDevModels('nope', 'groq')).toEqual([]);
  });
});

describe('ACP session models', () => {
  it('reads availableModels and the current model', () => {
    // Cline 3.0 `session/new`.
    const result = { models: { currentModelId: 'anthropic/claude-sonnet-5', availableModels: [
      { modelId: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }, { modelId: 'x-ai/grok-4.7', name: 'x-ai/grok-4.7' }, { name: 'no id' },
    ] } };
    expect(acpSessionModels(result)).toEqual({
      models: ['anthropic/claude-sonnet-5', 'x-ai/grok-4.7'], labels: { 'anthropic/claude-sonnet-5': 'Claude Sonnet 5' }, current: 'anthropic/claude-sonnet-5',
    });
    expect(acpSessionModels(undefined)).toEqual({ models: [], labels: {} });
  });
});

describe('models.dev', () => {
  it('lists a provider’s models with their names (Copilot’s picker)', () => {
    const cache = JSON.stringify({ 'github-copilot': { name: 'GitHub Copilot', models: { 'gpt-5.4': { name: 'GPT-5.4' }, 'kimi-k3': {} } } });
    expect(modelsDevProvider(cache, 'github-copilot')).toEqual({ models: ['gpt-5.4', 'kimi-k3'], labels: { 'gpt-5.4': 'GPT-5.4' } });
    expect(modelsDevProvider(cache, 'nope')).toEqual({ models: [], labels: {} });
    expect(modelsDevProvider('offline', 'github-copilot')).toEqual({ models: [], labels: {} });
  });
});
