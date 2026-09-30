import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, getAiProvider, type AiProviderSpec } from './ai-provider-registry-public';

const providers: readonly AiProviderSpec[] = AI_PROVIDERS;

describe('AI provider registry', () => {
  it('keeps provider ids and API-key settings unique', () => {
    const ids = providers.map((provider) => provider.id);
    const keys = providers.flatMap((provider) => (provider.envKey ? [provider.envKey] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('holds only model APIs: an agent CLI naming itself is not a provider a key can be sent to', () => {
    expect(getAiProvider('anthropic')?.chatDialect).toBe('anthropic-messages');
    for (const tool of ['github-copilot', 'command-code', 'aider', 'goose']) expect(getAiProvider(tool)).toBeUndefined();
  });

  it('templates a base URL only where it names the variable that fills it', () => {
    for (const provider of providers) {
      expect(Boolean(provider.chatBaseUrl?.includes('{urlParam}')), provider.id).toBe(Boolean(provider.urlParamEnvKey));
    }
  });
});
