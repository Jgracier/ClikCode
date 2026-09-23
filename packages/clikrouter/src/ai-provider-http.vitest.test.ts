import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateResponsesSse,
  buildAiAuthHeaders,
  buildAiChatRequest,
  extractChatText,
  extractServedModel,
  extractServiceTier,
  extractStopReason,
  extractToolCalls,
  extractUsage,
  readAiChatResponseBody,
} from './ai-provider-http';

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

// A Responses-ONLY provider (Ramp Router) is the case these cover: it publishes no
// /chat/completions at all, so "did we build the right URL" is not a style question — the
// chat-completions route is a documented 404 there.
describe('buildAiChatRequest — openai-responses dialect', () => {
  const base = {
    provider: 'router',
    model: 'some-account-scoped-id',
    apiKey: 'rtr_test_key',
    credentialSource: 'env' as const,
  };

  it('routes a PLAIN turn (no tools) to /responses, never /chat/completions', () => {
    const req = buildAiChatRequest({
      ...base,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });
    expect(req.dialect).toBe('openai-responses');
    expect(req.url).toBe('https://api.router.com/v1/responses');
    expect(req.url).not.toContain('/chat/completions');
    // Responses field names, all three of which differ from chat/completions.
    expect(req.body.instructions).toBe('You are helpful');
    expect(req.body.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.body.max_output_tokens).toBe(100);
    expect(req.body.messages).toBeUndefined();
    expect(req.body.max_tokens).toBeUndefined();
  });

  it('sends a Bearer token, not the anthropic x-api-key header', () => {
    const req = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    expect(req.headers.Authorization).toBe('Bearer rtr_test_key');
    expect(req.headers['x-api-key']).toBeUndefined();
  });

  it('carries tools FLAT, not nested under a function key', () => {
    const req = buildAiChatRequest({
      ...base,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'deploy', description: 'ship it', parameters: { type: 'object' } }],
    });
    expect(req.url).toBe('https://api.router.com/v1/responses');
    expect(req.body.tools).toEqual([
      { type: 'function', name: 'deploy', description: 'ship it', parameters: { type: 'object' } },
    ]);
  });

  it('never sends an empty input array — a system-only turn still gets a user item', () => {
    const req = buildAiChatRequest({
      ...base,
      system: 'Only a system prompt',
      messages: [],
    });
    expect(req.body.input).toEqual([{ role: 'user', content: 'Begin.' }]);
  });

  it('omits temperature unless the caller asked for one', () => {
    const withOut = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    expect(withOut.body.temperature).toBeUndefined();
    const withIt = buildAiChatRequest({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
    expect(withIt.body.temperature).toBe(0.2);
  });

  it('pairs stream:true with alwaysSse so the body reader aggregates SSE', async () => {
    const req = buildAiChatRequest({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(req.body.stream).toBe(true);
    // Without alwaysSse, JSON.parse over an SSE body yields {} — an empty completion that reads
    // as a working call returning nothing, which is the failure this pairing exists to prevent.
    expect(req.alwaysSse).toBe(true);
    const sse = [
      'event: response.completed',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] },
      })}`,
      '',
    ].join('\n');
    const body = await readAiChatResponseBody(req, { text: async () => sse });
    expect(extractChatText(req.dialect, body)).toBe('pong');
  });
});

// The two facts that arrive on every response and used to be dropped. The case that matters most
// is a routing gateway, where the served model is CHOSEN per request and the requested id is not
// evidence of what was billed.
describe('extractServedModel / extractServiceTier', () => {
  it('reads the served model off every dialect that names one', () => {
    // A gateway answering with a DIFFERENT model than the caller asked for — the whole point.
    expect(extractServedModel('openai-responses', { model: 'anthropic:claude-haiku-4-5' })).toBe(
      'anthropic:claude-haiku-4-5',
    );
    expect(extractServedModel('openai-chat', { model: 'gpt-5-2026-04-01' })).toBe('gpt-5-2026-04-01');
    expect(extractServedModel('anthropic-messages', { model: 'claude-opus-5' })).toBe('claude-opus-5');
    expect(extractServedModel('codex-responses', { model: 'gpt-5-codex' })).toBe('gpt-5-codex');
    // Gemini spells it differently, one envelope deep.
    expect(
      extractServedModel('code-assist', { response: { modelVersion: 'gemini-2.5-flash-001' } }),
    ).toBe('gemini-2.5-flash-001');
  });

  it('returns undefined rather than inventing a model when the vendor names none', () => {
    // NOT the requested model: "confirmed X" and "said nothing" must stay distinguishable.
    expect(extractServedModel('openai-chat', {})).toBeUndefined();
    expect(extractServedModel('openai-responses', { model: '' })).toBeUndefined();
    expect(extractServedModel('openai-chat', { model: 42 })).toBeUndefined();
    expect(extractServedModel('code-assist', { response: {} })).toBeUndefined();
  });

  it('reads service_tier only where the vendor publishes one', () => {
    expect(extractServiceTier('openai-responses', { service_tier: 'flex' })).toBe('flex');
    expect(extractServiceTier('openai-chat', { service_tier: 'default' })).toBe('default');
    // Anthropic and Code Assist have no such concept — undefined is correct, not missing.
    expect(extractServiceTier('anthropic-messages', { service_tier: 'flex' })).toBeUndefined();
    expect(extractServiceTier('code-assist', { service_tier: 'flex' })).toBeUndefined();
    expect(extractServiceTier('openai-chat', {})).toBeUndefined();
  });

  it('survives a malformed or absent body without throwing', () => {
    for (const body of [undefined, null, 'not-json', 0]) {
      expect(() => extractServedModel('openai-chat', body)).not.toThrow();
      expect(() => extractServiceTier('openai-chat', body)).not.toThrow();
      expect(extractServedModel('openai-chat', body)).toBeUndefined();
      expect(extractServiceTier('openai-chat', body)).toBeUndefined();
    }
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

  // credentialSource is 'api-key' on purpose: generativelanguage is the API-KEY
  // surface. This case used to pass 'oauth' here while asserting this url, which
  // is the combination that 403s in production — an OAuth token has no access to
  // that host at all. The OAuth arm is asserted separately below.
  it('builds google openai-compat chat url for an API key', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza-test',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('openai-chat');
    expect(req.url).toContain('generativelanguage.googleapis.com');
    expect(req.url).toContain('/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer AIza-test');
  });

  it('routes a google OAuth credential to Code Assist, not the API-key host', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'ya29.x',
      credentialSource: 'oauth',
      projectId: 'my-companion-project',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('code-assist');
    expect(req.url).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
    );
    expect(req.headers.Authorization).toBe('Bearer ya29.x');
    expect(req.headers['X-Goog-Api-Client']).toContain('gemini-cli/');
    // `project` is mandatory — the endpoint 500s on every call without it.
    expect(req.body.project).toBe('my-companion-project');
    expect(req.body.model).toBe('gemini-2.5-flash');
    const inner = req.body.request as Record<string, unknown>;
    expect(inner.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(inner.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are helpful' }],
    });
  });

  it('maps an assistant turn to the Vertex `model` role on code-assist', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'ya29.x',
      credentialSource: 'oauth',
      projectId: 'p',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    const inner = req.body.request as { contents: Array<{ role: string }> };
    expect(inner.contents.map((c) => c.role)).toEqual(['user', 'model']);
  });

  it('routes an openai OAuth credential to the Codex backend, not api.openai.com', () => {
    const req = buildAiChatRequest({
      provider: 'openai',
      model: 'gpt-5.1-codex',
      apiKey: 'oauth-token',
      credentialSource: 'oauth',
      accountId: 'acct_123',
      system: 'Be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('codex-responses');
    expect(req.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(req.headers.Authorization).toBe('Bearer oauth-token');
    expect(req.headers['chatgpt-account-id']).toBe('acct_123');
    expect(req.headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(req.headers.originator).toBe('codex_cli_rs');
    expect(req.headers.accept).toBe('text/event-stream');
    // All three are required by that backend, not stylistic choices.
    expect(req.body.store).toBe(false);
    expect(req.body.stream).toBe(true);
    expect(req.body.instructions).toBe('Be terse');
    expect(req.body.include).toEqual(['reasoning.encrypted_content']);
    // `input_text`, never the plain `text` type, which this backend rejects.
    expect(req.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(req.alwaysSse).toBe(true);
  });

  // The Codex backend rejects max_output_tokens outright (400, live-verified
  // 2026-08-10), so the builder must omit it — but the caller who asked for a
  // cap must hear about the drop, once per process, not have it silently eaten.
  it('drops maxTokens on the codex lane, warning once and never sending the param', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const build = () =>
        buildAiChatRequest({
          provider: 'openai',
          model: 'gpt-5.1-codex',
          apiKey: 'oauth-token',
          credentialSource: 'oauth',
          maxTokens: 512,
          messages: [{ role: 'user', content: 'hi' }],
        });
      const first = build();
      const second = build();
      // The vendor 400s on the param, so it must be absent under every spelling.
      for (const req of [first, second]) {
        expect(req.dialect).toBe('codex-responses');
        expect(req.body.max_output_tokens).toBeUndefined();
        expect(req.body.max_tokens).toBeUndefined();
        expect(req.body.max_completion_tokens).toBeUndefined();
      }
      // Once per process — the second identical call must not warn again.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/maxTokens.*cannot be enforced/s);
    } finally {
      warn.mockRestore();
    }
  });

  // The chokepoint guard. Anthropic's HTTP API DOES answer a Claude
  // subscription token, so without this a lane that forgot to route to the
  // harness would spend the subscription on an unsupported surface and look
  // fine until the rate-limited bucket started returning 429s.
  it('refuses to build an HTTP request for a harness-transport subscription', () => {
    expect(() =>
      buildAiChatRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/cannot be dispatched over HTTP.*harness/s);
  });

  // xAI's subscription has NO HTTP surface this platform may drive: its CLI proxy
  // (cli-chat-proxy.grok.com) answered every bare-client turn 426 `Grok CLI version (none) is
  // outdated` because it gates on the CLI's own version header, and api.x.ai
  // 403s the bearer on chat. The row is therefore 'harness' (the vendor's own CLI is the transport,
  // baked into the worker image), and the chokepoint REFUSES an OAuth credential the same way it
  // refuses Anthropic's — pointing the lane at runHarnessChat. An API key for the same provider is
  // untouched: it still builds the ordinary api.x.ai request, with none of the CLI-proxy headers.
  it('refuses an xAI OAuth credential toward the harness, while its API key still builds', () => {
    expect(() =>
      buildAiChatRequest({
        provider: 'xai',
        model: 'grok-4-1-fast',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/subscriptionTransport: harness.*runHarnessChat/s);

    const req = buildAiChatRequest({
      provider: 'xai',
      model: 'grok-4-1-fast',
      apiKey: 'xai-api-key',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer xai-api-key');
    expect(req.headers['X-XAI-Token-Auth']).toBeUndefined();
    expect(req.headers['x-grok-model-override']).toBeUndefined();
  });

  // huggingface now dispatches its subscription DIRECT — its OAuth token spends on the SAME
  // OpenAI-compatible host the API key uses (router.huggingface.co), as a Bearer, with no oauthChat
  // override and no harness. (microsoft-foundry is the same shape against its operator base URL.)
  it('builds a direct openai-chat request for a huggingface OAuth credential', () => {
    const req = buildAiChatRequest({
      provider: 'huggingface',
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      apiKey: 'hf-oauth-token',
      credentialSource: 'oauth',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('openai-chat');
    expect(req.url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer hf-oauth-token');
  });

  // The guard still fires for a provider that genuinely has NO subscription transport — here a plain
  // API-key provider handed an OAuth credential: there is simply no subscription surface to build for.
  it('refuses to build one for a provider with no subscription transport', () => {
    expect(() =>
      buildAiChatRequest({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/no working subscription dispatch/);
  });

  it('still builds normally for an anthropic API key', () => {
    const req = buildAiChatRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-x',
      credentialSource: 'platform-secret',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('anthropic-messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-x');
  });

  it('leaves an openai API key on the public API', () => {
    const req = buildAiChatRequest({
      provider: 'openai',
      model: 'gpt-5.1',
      apiKey: 'sk-test',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.dialect).toBe('openai-chat');
    expect(req.url).toContain('api.openai.com');
    expect(req.alwaysSse).toBeUndefined();
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

describe('aggregateResponsesSse', () => {
  it('returns the terminal response object from a completed stream', () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      'data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}]}}',
      'data: [DONE]',
    ].join('\n');
    // The extractors then read it exactly as an openai-responses body.
    expect(extractChatText('codex-responses', aggregateResponsesSse(sse))).toBe(
      'Hello',
    );
  });

  it('falls back to accumulated deltas when the stream is truncated', () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"par"}',
      'data: {"type":"response.output_text.delta","delta":"tial"}',
      'data: {"type":"response.output_te',
    ].join('\n');
    expect(extractChatText('codex-responses', aggregateResponsesSse(sse))).toBe(
      'partial',
    );
  });

  it('surfaces a failed stream as the error body, not as empty prose', () => {
    const sse =
      'data: {"type":"response.failed","response":{"error":{"message":"nope"}}}';
    const out = aggregateResponsesSse(sse) as { error?: { message?: string } };
    expect(out.error?.message).toBe('nope');
    // Critically NOT a blank successful turn.
    expect(extractChatText('codex-responses', out)).toBe('');
  });

  it('reads an SSE body only when the dialect says the surface streams', async () => {
    const streamed = await readAiChatResponseBody(
      { url: '', headers: {}, body: {}, dialect: 'codex-responses', alwaysSse: true },
      {
        text: async () =>
          'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
      },
    );
    expect(extractChatText('codex-responses', streamed)).toBe('ok');

    const plain = await readAiChatResponseBody(
      { url: '', headers: {}, body: {}, dialect: 'openai-chat' },
      { text: async () => '{"choices":[{"message":{"content":"hi"}}]}' },
    );
    expect(extractChatText('openai-chat', plain)).toBe('hi');
  });
});

describe('code-assist extraction', () => {
  const body = {
    response: {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'Hello ' },
              { text: 'world' },
              { functionCall: { name: 'lookup', args: { id: 7 } } },
            ],
          },
        },
      ],
    },
  };

  it('unwraps the Code Assist envelope to read text', () => {
    expect(extractChatText('code-assist', body)).toBe('Hello world');
  });

  it('reads functionCall parts, whose args are already objects', () => {
    expect(extractToolCalls('code-assist', body)).toEqual([
      { name: 'lookup', args: { id: 7 } },
    ]);
  });

  it('parses usageMetadata one envelope deep, summing thoughts into output', () => {
    // Realistic Code Assist terminal payload: usageMetadata sits beside
    // candidates inside the `response` envelope. thoughtsTokenCount is billed
    // as output, and @ai-sdk/google's convertGoogleUsage sums it the same way.
    const withUsage = {
      response: {
        ...body.response,
        usageMetadata: {
          promptTokenCount: 910,
          candidatesTokenCount: 84,
          thoughtsTokenCount: 40,
          cachedContentTokenCount: 512,
          totalTokenCount: 1034,
        },
      },
    };
    expect(extractUsage('code-assist', withUsage)).toEqual({
      inputTokens: 910,
      outputTokens: 124,
      // promptTokenCount INCLUDES cachedContentTokenCount on this surface.
      uncachedInputTokens: 398,
      cachedInputTokens: 512,
      // thoughtsTokenCount is Google's reasoning counter; already summed into
      // outputTokens above, surfaced on its own for diagnosis.
      reasoningTokens: 40,
    });
    expect(extractStopReason('code-assist', withUsage)).toBe('STOP');
  });

  it('maps output from candidates alone when no thoughts are reported', () => {
    const noThoughts = {
      response: {
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
      },
    };
    expect(extractUsage('code-assist', noThoughts)).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      // No cached content reported: the whole prompt was billed at full rate.
      uncachedInputTokens: 12,
    });
  });

  it('leaves usage absent when the envelope carries no usageMetadata', () => {
    expect(extractUsage('code-assist', body)).toEqual({});
    expect(extractUsage('code-assist', {})).toEqual({});
  });
});
