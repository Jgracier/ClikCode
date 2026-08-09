import { describe, it, expect } from 'vitest';
import { buildAiChatRequest } from './ai-provider-http';

describe('output-cap parameter name per provider', () => {
  it('openai gets max_completion_tokens (its newer models reject max_tokens)', () => {
    const b = buildAiChatRequest({
      provider: 'openai', model: 'gpt-5.6-luna', apiKey: 'k',
      credentialSource: 'env', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2048,
    } as never);
    expect(b.body).toHaveProperty('max_completion_tokens', 2048);
    expect(b.body).not.toHaveProperty('max_tokens');
  });
  it('an openai-COMPATIBLE provider keeps max_tokens', () => {
    const b = buildAiChatRequest({
      provider: 'xai', model: 'grok-4', apiKey: 'k',
      credentialSource: 'env', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1234,
    } as never);
    expect(b.body).toHaveProperty('max_tokens', 1234);
    expect(b.body).not.toHaveProperty('max_completion_tokens');
  });
});
