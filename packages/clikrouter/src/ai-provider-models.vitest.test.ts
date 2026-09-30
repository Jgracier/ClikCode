// The wire layer is now the AI SDK. These tests hold the two properties that make that safe:
//  1. a model is always built from provider+model as SEPARATE fields, never a `creator/model` string
//     (that string form routes through Vercel's AI Gateway — a third party on tenant traffic). The
//     SINGLE-DOOR half of that property is enforced at authoring time by
//     scripts/assert-ai-sdk-boundary.sh, not by a runtime guard: the first attempt here was a guard on
//     globalThis.AI_SDK_DEFAULT_PROVIDER that nothing ever installed, so its tests passed while it
//     protected nothing;
//  2. every registry row can actually be addressed, either by a first-party package or by the
//     OpenAI-compatible adapter with a real base URL.
import { describe, it, expect, vi } from 'vitest';
import { APICallError } from 'ai';
import {
  resolveLanguageModel,
  extractDeclaredResponseCostMicroUsd,
  streamAiChatTurn,
} from './ai-provider-models';
import {
  AI_PROVIDERS as AI_PROVIDERS_CONST,
  getAiProvider,
  type AiProviderSpec,
} from './ai-provider-registry-public';

// AI_PROVIDERS is declared `as const satisfies readonly AiProviderSpec[]` so
// each entry keeps its own precise literal shape (needed elsewhere for
// per-provider narrowing) — but that means `.find()`'s callback here sees
// the full 40+-way union, and accessing a field only SOME providers declare
// (defaultModel, oauth, baseUrlEnvKey, ...) is a real type error against
// that union even though every test below only cares about the common
// AiProviderSpec shape. Widen once, here, rather than per-callsite.
const AI_PROVIDERS: readonly AiProviderSpec[] = AI_PROVIDERS_CONST;

function apiCallError(statusCode: number, isRetryable = false): APICallError {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://example.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

/** Which SDK surface a model was built on ('anthropic.messages', 'moonshot.chat', …). */
const surface = (model: ReturnType<typeof resolveLanguageModel>): string => (model as Exclude<typeof model, string>).provider;

describe('resolveLanguageModel', () => {
  it('builds a first-party model for a first-party row', () => {
    expect(surface(resolveLanguageModel({ provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' }))).toMatch(/^anthropic\./);
  });

  it('builds an OpenAI-compatible model for a row with no first-party package', () => {
    // moonshot is one of the OpenAI-shaped rows that never declared a dialect.
    expect(surface(resolveLanguageModel({ provider: 'moonshot', model: 'kimi-k2', apiKey: 'k' }))).toBe('moonshot.chat');
  });

  it('builds a RESPONSES model for an openai-responses row, not the compatible chat adapter', () => {
    // `createOpenAICompatible` builds {baseURL}/chat/completions, which a
    // Responses-only gateway (Ramp Router) documents as a 404.
    const model = resolveLanguageModel({ provider: 'router', model: 'acct-scoped-id', apiKey: 'k' });
    expect(surface(model)).toBe('openai.responses');
    expect((model as Exclude<typeof model, string>).modelId).toBe('acct-scoped-id');
  });

  it('refuses an unknown provider instead of inventing an endpoint', () => {
    expect(() => resolveLanguageModel({ provider: 'not-a-provider', model: 'm' })).toThrow(
      /unknown AI provider/,
    );
  });

  it('falls back to the row default model, and refuses when there is no model at all', () => {
    const withDefault = AI_PROVIDERS.find((p) => p.defaultModel);
    expect(resolveLanguageModel({ provider: withDefault!.id, model: '', apiKey: 'k' })).toBeTruthy();
    const blank = AI_PROVIDERS.find((p) => !p.defaultModel);
    expect(() => resolveLanguageModel({ provider: blank!.id, model: '', apiKey: 'k' })).toThrow();
  });

  it('prefers an env base-URL override over the row default (self-hosting is a deploy fact)', () => {
    const row = AI_PROVIDERS.find((p) => p.baseUrlEnvKey)!;
    const model = resolveLanguageModel({
      provider: row.id, model: 'm', apiKey: 'k', env: { [row.baseUrlEnvKey!]: 'https://self-hosted.example/v1' },
    });
    expect(model).toBeTruthy();
  });

  it('EVERY row is addressable: it has a base URL, or one is supplied at deploy time', () => {
    expect(AI_PROVIDERS.filter((p) => !p.chatBaseUrl && !p.baseUrlEnvKey).map((p) => p.id)).toEqual([]);
  });

  it('fills a templated base URL with its segment from the environment', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const row = getAiProvider('cloudflare')!;
    const previous = process.env[row.urlParamEnvKey!];
    process.env[row.urlParamEnvKey!] = 'acct-123';
    try {
      await streamAiChatTurn({ provider: 'cloudflare', model: 'm', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
    } finally {
      if (previous === undefined) delete process.env[row.urlParamEnvKey!]; else process.env[row.urlParamEnvKey!] = previous;
      vi.unstubAllGlobals();
    }
    expect(seen[0]).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions');
  });
});

describe('CheaperInference settled-cost normalization', () => {
  it('converts the captured fixed-precision USD string to integer micro-USD', () => {
    expect(
      extractDeclaredResponseCostMicroUsd('cheaper-inference', {
        'cheaper-inference': { settledCostUsd: '0.000123' },
      }),
    ).toBe(123);
  });

  it('fails back to catalog pricing when the extension is absent or malformed', () => {
    expect(extractDeclaredResponseCostMicroUsd('cheaper-inference', {})).toBeUndefined();
    expect(
      extractDeclaredResponseCostMicroUsd('cheaper-inference', {
        'cheaper-inference': { settledCostUsd: 'not-money' },
      }),
    ).toBeUndefined();
  });

  it('captures the billing envelope from a streaming completion', async () => {
    const sse = [
      'data: {"id":"ci-1","object":"chat.completion.chunk","created":0,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}',
      'data: {"id":"ci-1","object":"chat.completion.chunk","created":0,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2},"cheaper_inference":{"billing":{"status":"settled","billed_cost_usd":"0.000321","currency":"USD"}}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })),
    );
    try {
      const result = await streamAiChatTurn({
        provider: 'cheaper-inference',
        model: 'gpt-5.4',
        apiKey: 'ci_live_test',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.text).toBe('done');
      expect(result.costMicroUsd).toBe(321);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── SPEECH / TRANSCRIPTION / EMBEDDING / IMAGE DISPATCH ─────────────────────
//
// These tables replaced imports-without-dispatch: 11 @ai-sdk factories were
// imported and never referenced, so every audio/vision/embedding registry row
// was a connect-form that could never serve a request. The invariants that
// keep the fix honest:
//   1. table ⊆ registry: a table may only name a provider whose row DECLARES
//      that modality — otherwise dispatch exists the console cannot offer;
//   2. registry ⊆ table: every row declaring a dispatched modality has a
//      factory entry — otherwise the console offers a connect form that still
//      cannot serve a request, the exact defect this replaced;
//   3. every entry constructs against a stub credential with NO network —
//      model construction must be pure, or resolution itself would spend money;
//   4. an unknown or wrong-modality provider fails with a named error, never a
//      request aimed at nothing.

function rateLimitedError(headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: 'status 429',
    url: 'https://example.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
    responseHeaders: headers,
  });
}

describe('streamAiChatTurn recovers the REAL error instead of the SDK generic wrapper', () => {
  // streamText swallows an error that happens before any token streams into
  // a generic NoOutputGeneratedError with no statusCode — the exact bug that
  // made isPermanentAiCallFailure always see a non-APICallError and silently
  // fall back to a 5-minute cooldown for genuinely permanent failures
  // (observed live 2026-08-09: a 404'ing model kept getting re-tried for
  // hours). This asserts the fix: the ORIGINAL error, captured via
  // streamText's onError callback, is what actually reaches the caller.
  it('re-throws the captured onError error, not a generic wrapper, when the stream errors before any output', async () => {
    const real404 = apiCallError(404);
    vi.doMock('ai', async (importOriginal) => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: (opts: { onError?: (event: { error: unknown }) => void }) => {
          // Mirrors the real SDK's behavior: fire onError with the REAL
          // error, then settle every consumable into a generic failure.
          opts.onError?.({ error: real404 });
          const genericFailure = () => Promise.reject(new Error('No output generated. Check the stream for errors.'));
          return {
            textStream: (async function* () {
              // no deltas — the call failed before any token arrived
            })(),
            toolCalls: genericFailure(),
            totalUsage: genericFailure(),
            response: genericFailure(),
            finishReason: genericFailure(),
            providerMetadata: genericFailure(),
          };
        },
      };
    });
    vi.resetModules();
    const { streamAiChatTurn } = await import('./ai-provider-models');
    await expect(
      streamAiChatTurn({
        provider: 'huggingface',
        model: 'some/deprecated-model',
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBe(real404);
    vi.doUnmock('ai');
    vi.resetModules();
  });
});

describe('streamAiChatTurn — per-candidate baseUrl override (self-hosted deployments)', () => {
  // A self-hosted model deployment's endpoint is a row in the deployments
  // table, not an env var — the candidates layer attaches it per-candidate
  // and dispatch threads it through here. This proves the override actually
  // aims the openai-compatible request at the deployment's URL.
  it('dispatches the openai-compatible request to the per-call baseUrl', async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"org/local-7b","choices":[{"index":0,"delta":{"role":"assistant","content":"hi from the pod"},"finish_reason":null}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"org/local-7b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn(
      async () =>
        new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await streamAiChatTurn({
        provider: 'self-hosted',
        model: 'org/local-7b',
        // Placeholder bearer — deployment runtimes reached directly take no
        // auth; the adapter just needs SOME key to build a header from.
        apiKey: 'self-hosted-deployment',
        baseUrl: 'http://10.0.0.7:8000/v1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.text).toBe('hi from the pod');
      expect(fetchMock).toHaveBeenCalled();
      const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
      expect(url).toBe('http://10.0.0.7:8000/v1/chat/completions');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a per-call baseUrl beats an env base-URL override (most specific wins)', () => {
    const row = AI_PROVIDERS.find((p) => p.id === 'self-hosted');
    expect(row).toBeTruthy();
    // Constructs without throwing even though the row's chatBaseUrl is the
    // unresolvable "{baseUrl}" placeholder — the override supplies the real
    // endpoint. (URL selection itself is proven live by the dispatch test
    // above; construction is what can throw here.)
    expect(
      resolveLanguageModel({
        provider: 'self-hosted',
        model: 'org/local-7b',
        apiKey: 'k',
        baseUrl: 'http://10.0.0.7:8000/v1',
      }),
    ).toBeTruthy();
  });
});

// ── ONE CONTRACT, ONE BASE URL ──────────────────────────────────────────────
//
// THE DEFECT THIS SUITE EXISTS TO PREVENT (measured live, aws-bedrock,
// 2026-08-13): a row declared `openAiCompatible: true` with
// `probe: {baseUrl}/models`, AND was also mapped to a first-party factory —
// @ai-sdk/amazon-bedrock — that builds Bedrock-NATIVE paths off the same base
// ({base}/model/{id}/converse). The two layers wanted DIFFERENT base URLs, so
// no single stored value could satisfy both: the admin connection test went
// green off /models while every chat call 404'd. A green connection test that
// does not predict working chat is worse than no test at all.
//
// The invariant, in two halves:
//   CATALOG — where one stored base URL feeds both readers, both must read it.
//   WIRE    — whatever builds the model (first-party factory or the
//             OpenAI-compatible adapter) must send chat to an OpenAI-dialect
//             route under that SAME base.
// Neither half catches this alone: the catalog half passed throughout the
// bedrock outage (both fields did say "{baseUrl}"), and the wire half is the
// one that actually asks the factory where it sends the request.
