import { afterEach, describe, expect, it } from 'vitest';
import { buildAiAuthHeaders, buildAiChatRequest, extractChatText } from './ai-provider-http';

afterEach(() => {
  delete process.env.CUSTOM_OPENAI_BASE_URL;
});

describe('buildAiAuthHeaders', () => {
  it('uses x-api-key + anthropic-version for anthropic API keys', () => {
    const h = buildAiAuthHeaders('anthropic', {
      apiKey: 'sk-ant-api03-x',
      credentialSource: 'platform-secret',
    });
    expect(h['x-api-key']).toBe('sk-ant-api03-x');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h.Authorization).toBeUndefined();
  });

  it('uses Bearer + oauth beta for anthropic OAuth tokens', () => {
    const h = buildAiAuthHeaders('anthropic', {
      apiKey: 'sk-ant-oat01-x',
      credentialSource: 'oauth',
    });
    expect(h.Authorization).toBe('Bearer sk-ant-oat01-x');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('uses Bearer for Anthropic OAuth model probes', () => {
    const h = buildAiAuthHeaders(
      'anthropic',
      { apiKey: 'oauth-token', credentialSource: 'oauth' },
      { forProbe: true },
    );
    expect(h.Authorization).toBe('Bearer oauth-token');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('uses Bearer for openai and google', () => {
    expect(
      buildAiAuthHeaders('openai', { apiKey: 'sk-x', credentialSource: 'env' }).Authorization,
    ).toBe('Bearer sk-x');
    expect(
      buildAiAuthHeaders('google', { apiKey: 'ya29.x', credentialSource: 'oauth' }).Authorization,
    ).toBe('Bearer ya29.x');
  });

  it('omits authorization for a keyless private endpoint', () => {
    expect(
      buildAiAuthHeaders('custom-openai', { apiKey: '', credentialSource: 'env' }),
    ).toEqual({});
  });

  it('uses the Azure api-key header for Microsoft Foundry', () => {
    expect(
      buildAiAuthHeaders('microsoft-foundry', {
        apiKey: 'foundry-key',
        credentialSource: 'platform-secret',
      })
    ).toEqual({ 'api-key': 'foundry-key' });
  });

  it('uses Bearer for a Microsoft Foundry OAUTH token, not the api-key header', () => {
    // The regression this pins: microsoft-foundry declares both
    // `authHeader: "api-key"` (right for its Foundry keys) and `oauth: true`.
    // Connecting the account mints a Microsoft Entra ID token for scope
    // https://cognitiveservices.azure.com/.default, and Foundry accepts an
    // Entra token ONLY as `Authorization: Bearer` — the api-key header is the
    // key-based alternative, not a second way to send a token. Sending the
    // Entra token as `api-key` produced a connection the AI tab showed as
    // healthy and that failed 401 on every inference call, which is the
    // authenticates-but-cannot-call mode that got two other providers reverted.
    expect(
      buildAiAuthHeaders('microsoft-foundry', {
        apiKey: 'entra-access-token',
        credentialSource: 'oauth',
      })
    ).toEqual({ Authorization: 'Bearer entra-access-token' });
  });

  it('uses xi-api-key for ElevenLabs (Bearer is invisible to their API)', () => {
    // MEASURED: no header → 404 workspace_not_found; xi-api-key:bogus → 401
    // invalid_api_key. Bearer never authenticates, so the probe would never
    // report auth_failed if we reused the default mode.
    expect(
      buildAiAuthHeaders('elevenlabs', {
        apiKey: 'el_test_key',
        credentialSource: 'platform-secret',
      }),
    ).toEqual({ 'xi-api-key': 'el_test_key' });
  });
});

describe('buildAiChatRequest', () => {
  it('builds anthropic messages dialect', () => {
    const req = buildAiChatRequest({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-x',
      credentialSource: 'env',
      system: 'You are helpful',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
      ],
      maxTokens: 100,
    });
    expect(req.dialect).toBe('anthropic-messages');
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.body.model).toBe('claude-haiku-4-5');
    expect(req.body.system).toBe('You are helpful');
    expect(req.body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'more' },
    ]);
  });

  it('builds google openai-compat chat url', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'ya29.x',
      credentialSource: 'oauth',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('openai-chat');
    expect(req.url).toContain('generativelanguage.googleapis.com');
    expect(req.url).toContain('/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer ya29.x');
  });

  it('builds a configurable OpenAI-compatible endpoint request', () => {
    process.env.CUSTOM_OPENAI_BASE_URL = 'http://models.internal:8000/v1/';
    const req = buildAiChatRequest({
      provider: 'custom-openai',
      model: 'local-model',
      apiKey: '',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.url).toBe('http://models.internal:8000/v1/chat/completions');
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('uses Perplexity Sonar\'s provider-specific compatible chat path', () => {
    const req = buildAiChatRequest({
      provider: 'perplexity',
      model: 'sonar-pro',
      apiKey: 'pplx-key',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'latest news' }],
    });
    expect(req.url).toBe('https://api.perplexity.ai/v1/sonar');
    expect(req.headers.Authorization).toBe('Bearer pplx-key');
  });
});

describe('extractChatText', () => {
  it('reads anthropic content blocks', () => {
    expect(
      extractChatText('anthropic-messages', {
        content: [{ type: 'text', text: 'hello' }],
      }),
    ).toBe('hello');
  });

  it('reads openai choices', () => {
    expect(
      extractChatText('openai-chat', {
        choices: [{ message: { content: 'hi' } }],
      }),
    ).toBe('hi');
  });

  it('reads openai choice content arrays like OpenRouter', () => {
    expect(
      extractChatText('openai-chat', {
        choices: [
          {
            message: {
              content: [
                { type: 'output_text', text: 'Hello' },
                { type: 'output_text', text: ' world.' },
              ],
            },
          },
        ],
      }),
    ).toBe('Hello world.');
  });
});
