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
  hasFirstPartyProvider,
  firstPartyProviderIds,
  isPermanentAiCallFailure,
  isAccountScopedAiCallFailure,
  streamAiChatTurn,
} from './ai-provider-models';
import {
  AI_PROVIDERS as AI_PROVIDERS_CONST,
  providersByCategory,
  textRoutableProviders,
  providerCategory,
  providerModalities,
  isTextRoutable,
  getAiProvider,
  subscriptionDispatchesDirect,
  type AiProviderSpec,
} from './ai-provider-registry';

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

describe('resolveLanguageModel', () => {
  it('builds a first-party model for a first-party row', () => {
    const model = resolveLanguageModel({ provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' });
    expect(model).toBeTruthy();
    expect(hasFirstPartyProvider('anthropic')).toBe(true);
  });

  it('builds an OpenAI-compatible model for a row with no first-party package', () => {
    // moonshot is one of the ~15 OpenAI-shaped rows that never declared a dialect.
    expect(hasFirstPartyProvider('moonshot')).toBe(false);
    expect(resolveLanguageModel({ provider: 'moonshot', model: 'kimi-k2', apiKey: 'k' })).toBeTruthy();
  });

  it('refuses an unknown provider instead of inventing an endpoint', () => {
    expect(() => resolveLanguageModel({ provider: 'not-a-provider', model: 'm' })).toThrow(
      /unknown AI provider/,
    );
  });

  it('falls back to the row default model, and refuses when there is no model at all', () => {
    const withDefault = AI_PROVIDERS.find((p) => p.defaultModel && !p.oauth);
    if (withDefault) {
      expect(resolveLanguageModel({ provider: withDefault.id, model: '', apiKey: 'k' })).toBeTruthy();
    }
    // custom-openai is the deliberately blank row: no default model to fall back to.
    const blank = AI_PROVIDERS.find((p) => !p.defaultModel);
    if (blank) {
      expect(() => resolveLanguageModel({ provider: blank.id, model: '', apiKey: 'k' })).toThrow();
    }
  });

  it('prefers an env base-URL override over the row default (self-hosting is a deploy fact)', () => {
    const row = AI_PROVIDERS.find((p) => p.baseUrlEnvKey && !hasFirstPartyProvider(p.id));
    if (!row?.baseUrlEnvKey) return;
    const model = resolveLanguageModel({
      provider: row.id,
      model: 'm',
      apiKey: 'k',
      env: { [row.baseUrlEnvKey]: 'https://self-hosted.example/v1' },
    });
    expect(model).toBeTruthy();
  });

  it('EVERY TEXT-ROUTABLE row is addressable — first-party, or compatible with a real base URL', () => {
    // Scoped to chat providers on purpose. Audio and visual rows are built by different SDK builders
    // (speech / transcription / image / video) and have no chat-completions URL to carry, so holding
    // them to this invariant would assert something the modality does not have.
    const unreachable = AI_PROVIDERS.filter((p) => {
      if (!isTextRoutable(p)) return false;
      if (hasFirstPartyProvider(p.id)) return false;
      // A compatible row needs somewhere to send the request; `baseUrlEnvKey` rows are supplied at
      // deploy time, so they count as reachable.
      return !p.chatBaseUrl && !p.baseUrlEnvKey;
    }).map((p) => p.id);
    expect(unreachable).toEqual([]);
  });

  it('covers 17 first-party language-model providers and no speech/transcription ones', () => {
    const ids = firstPartyProviderIds();
    expect(ids).toHaveLength(17);
    // Adding a speech or transcription provider here would surface it in the admin console's model
    // picker as a selectable remediation model and then fail at request time.
    for (const nonLm of ['elevenlabs', 'deepgram', 'assemblyai', 'voyage', 'lmnt', 'hume', 'revai']) {
      expect(ids).not.toContain(nonLm);
    }
  });
});

describe('modality grouping and text-only routing', () => {
  it('groups into exactly the three console sections, text first', () => {
    const groups = providersByCategory();
    expect(groups.map((g) => g.label)).toEqual(['Text', 'Audio', 'Image & Video']);
  });

  it('every provider lands in exactly one section', () => {
    const groups = providersByCategory();
    const total = groups.reduce((n, g) => n + g.providers.length, 0);
    expect(total).toBe(AI_PROVIDERS.length);
    const ids = groups.flatMap((g) => g.providers.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('NOTHING audio or visual is routable for text — a transcriber cannot answer a completion', () => {
    const routable = new Set(textRoutableProviders());
    for (const id of ['elevenlabs', 'lmnt', 'hume', 'deepgram', 'revai', 'gladia', 'assemblyai', 'fal', 'luma', 'replicate']) {
      expect(routable.has(id)).toBe(false);
    }
    // …and the text lane still has everything it had before.
    expect(routable.has('openai')).toBe(true);
    expect(routable.has('anthropic')).toBe(true);
    // 32, not 31: the Nous Research row was added with a real `chatBaseUrl`, so it is genuinely
    // text-routable. Every future move of this number must name its provider the same way — a
    // silent bump is how an audio row would sneak into the text lane unnoticed.
    expect(routable.has('nous')).toBe(true);
    expect(routable.size).toBe(32);
  });

  it('embeddings group under Text but are still NOT routable', () => {
    // Grouping and routability are different questions; Voyage is the case that proves it.
    const voyage = AI_PROVIDERS.find((p) => p.id === 'voyage')!;
    expect(providerCategory(voyage)).toBe('text');
    expect(isTextRoutable(voyage)).toBe(false);
  });

  it('fal declares four modalities and still lands in one section', () => {
    const fal = AI_PROVIDERS.find((p) => p.id === 'fal')!;
    expect(providerModalities(fal)).toContain('video');
    expect(providerModalities(fal)).toContain('transcription');
    expect(providerCategory(fal)).toBe('visual');
  });

  it('luma claims no video, because @ai-sdk/luma exposes no video model at this version', () => {
    const luma = AI_PROVIDERS.find((p) => p.id === 'luma')!;
    expect(providerModalities(luma)).not.toContain('video');
  });

  it('audio/visual rows carry NO token pricing — the unit would be wrong, and wrong beats empty', () => {
    // AiProviderModel prices in $/Mtok; these are billed per character, minute,
    // image or second. A real probe (ElevenLabs /v1/models) is fine — it
    // discovers model ids — but staticModels must stay bare ids with no
    // invented inMTok/outMTok, and the registry itself must not declare prices.
    for (const p of AI_PROVIDERS.filter((x) => providerCategory(x) !== 'text')) {
      expect(
        p.staticModels === undefined || p.staticModels.every((id) => typeof id === 'string'),
        `${p.id} staticModels must be bare ids`,
      ).toBe(true);
      // No chat dialect means we never route them as token-priced chat.
      expect(p.chatDialect, p.id).toBeUndefined();
      expect(p.openAiCompatible, p.id).toBeFalsy();
    }
  });
});

describe('isPermanentAiCallFailure', () => {
  it('treats 401/403/404 as permanent regardless of isRetryable', () => {
    expect(isPermanentAiCallFailure(apiCallError(401, true))).toBe(true);
    expect(isPermanentAiCallFailure(apiCallError(403, true))).toBe(true);
    expect(isPermanentAiCallFailure(apiCallError(404, true))).toBe(true);
  });

  it('treats a non-retryable status of any other code as permanent too', () => {
    expect(isPermanentAiCallFailure(apiCallError(400, false))).toBe(true);
  });

  it('treats a retryable 429/503 as transient', () => {
    expect(isPermanentAiCallFailure(apiCallError(429, true))).toBe(false);
    expect(isPermanentAiCallFailure(apiCallError(503, true))).toBe(false);
  });

  it('is false for anything that is not an APICallError at all (aborts, plain Errors)', () => {
    expect(isPermanentAiCallFailure(new Error('boom'))).toBe(false);
    expect(isPermanentAiCallFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isPermanentAiCallFailure(undefined)).toBe(false);
  });
});

describe('isAccountScopedAiCallFailure — the gate on provider-wide escalation', () => {
  it('is true for 401/402/403 — evidence about the shared credential', () => {
    expect(isAccountScopedAiCallFailure(apiCallError(401))).toBe(true);
    expect(isAccountScopedAiCallFailure(apiCallError(402))).toBe(true);
    expect(isAccountScopedAiCallFailure(apiCallError(403))).toBe(true);
  });

  it('is FALSE for 404 — a wrong/deprecated model id says nothing about other models', () => {
    // This is the exact distinction this session's correction depends on:
    // isPermanentAiCallFailure(404) is true (cool THIS model for 24h), but
    // isAccountScopedAiCallFailure(404) must stay false (never escalate the
    // whole provider over one stale catalog entry).
    expect(isPermanentAiCallFailure(apiCallError(404))).toBe(true);
    expect(isAccountScopedAiCallFailure(apiCallError(404))).toBe(false);
  });

  it('is false for rate limits, server errors, and non-APICallError failures', () => {
    expect(isAccountScopedAiCallFailure(apiCallError(429))).toBe(false);
    expect(isAccountScopedAiCallFailure(apiCallError(500))).toBe(false);
    expect(isAccountScopedAiCallFailure(new Error('network blip'))).toBe(false);
    expect(isAccountScopedAiCallFailure(undefined)).toBe(false);
  });
});

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

describe('streamAiChatTurn — direct-transport OAuth subscription dispatch', () => {
  // openai's registry row declares subscriptionTransport: 'direct' with an
  // oauthChat surface (codex-responses, always SSE, aggregated back into the
  // Responses shape) — this is the whole reason a caller can pass
  // credentialSource: 'oauth' at all without shelling out to a CLI.
  it('bypasses the AI SDK entirely and dispatches through the codex-responses surface', async () => {
    const sse =
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello from codex"}]}]}}\n\n';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-request-id': 'abc' }),
      text: async () => sse,
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await streamAiChatTurn({
        provider: 'openai',
        model: 'gpt-5.6-luna',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        accountId: 'acct-123',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.text).toBe('hello from codex');
      expect(result.toolCalls).toEqual([]);
      expect(result.headers).toEqual({ 'x-request-id': 'abc' });
      // Proof the AI SDK's own factory/streamText path was never touched: the
      // only network call is the one this test's fetch mock made.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('chatgpt.com');
      expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-123');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls onDelta exactly once with the full text (no incremental channel on this transport)', async () => {
    const sse =
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"one shot"}]}]}}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => sse,
    })));
    try {
      const deltas: string[] = [];
      await streamAiChatTurn({
        provider: 'openai',
        model: 'gpt-5.6-luna',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: (d) => deltas.push(d),
      });
      expect(deltas).toEqual(['one shot']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws a real APICallError with the response statusCode on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => '{"error":"invalid token"}',
    })));
    try {
      const err = await streamAiChatTurn({
        provider: 'openai',
        model: 'gpt-5.6-luna',
        apiKey: 'oauth-token',
        credentialSource: 'oauth',
        messages: [{ role: 'user', content: 'hi' }],
      }).catch((e) => e);
      expect(APICallError.isInstance(err)).toBe(true);
      expect((err as APICallError).statusCode).toBe(401);
      // The whole reason this constructs a real APICallError instead of a
      // plain Error: isPermanentAiCallFailure must classify a dead
      // subscription credential exactly like a dead API key.
      expect(isPermanentAiCallFailure(err)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // anthropic's subscriptionTransport is 'harness', not 'direct' — the branch
  // predicate itself (subscriptionDispatchesDirect) is what keeps a
  // credentialSource: 'oauth' call for it OUT of dispatchOauthSurfaceChatTurn,
  // covered directly rather than through a full streamAiChatTurn call: the AI
  // SDK's own factory also uses global fetch, so stubbing it here couldn't
  // distinguish "the direct branch was skipped" from "the SDK path made its
  // own real network call" without mocking the entire SDK, which the
  // preceding describe block already does for a different assertion.
  it('the branch predicate is false for a harness-transport provider (anthropic)', () => {
    expect(subscriptionDispatchesDirect(getAiProvider('anthropic'))).toBe(false);
  });
});

