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
  resolveSpeechModel,
  resolveTranscriptionModel,
  resolveEmbeddingModel,
  resolveImageModel,
  modalityFactoryProviderIds,
  hasModalityDispatch,
  hasFirstPartyProvider,
  firstPartyProviderIds,
  isPermanentAiCallFailure,
  isAccountScopedAiCallFailure,
  isBillingAiCallFailure,
  resolveRateLimitRetryAfterMs,
  extractDeclaredResponseCostMicroUsd,
  streamAiChatTurn,
  type AiDispatchedModality,
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
  subscriptionUsesHarness,
  type AiProviderSpec,
} from './ai-provider-registry';
import { resolveProviderUrl } from './ai-provider-http';

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

  it('builds a RESPONSES model for an openai-responses row, not the compatible chat adapter', () => {
    // The split-brain this guards: `createOpenAICompatible` builds {baseURL}/chat/completions,
    // which a Responses-only gateway (Ramp Router) documents as a 404. Getting this wrong leaves
    // the hand-rolled HTTP lane working while every SDK-dispatched turn fails, so assert the
    // SURFACE the SDK picked rather than mere truthiness.
    expect(hasFirstPartyProvider('router')).toBe(false);
    const model = resolveLanguageModel({ provider: 'router', model: 'acct-scoped-id', apiKey: 'k' });
    // `LanguageModel` is `string | LanguageModelV2`; only the object form carries the surface id.
    expect(typeof model).not.toBe('string');
    const built = model as Exclude<typeof model, string>;
    expect(built.provider).toBe('openai.responses');
    // …and it is NOT the compatible chat adapter, which would name itself '<id>.chat'.
    expect(built.provider).not.toBe('router.chat');
    expect(built.modelId).toBe('acct-scoped-id');
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
      // A HARNESS-transport row is addressable through the vendor's own CLI, which is a transport
      // this test cannot express as a URL. github-copilot is the first such row: its subscription is
      // spendable and it has no inference endpoint at all (GitHub Models, the only one it ever had,
      // was retired 2026-07-30), so "no chatBaseUrl" is the CORRECT state for it rather than the
      // defect this guard hunts. Excluded on the registry datum, never on the id — a second
      // harness-only vendor is covered by the same line. Everything else still has to carry a URL.
      if (subscriptionUsesHarness(p)) return false;
      // A compatible row needs somewhere to send the request; `baseUrlEnvKey` rows are supplied at
      // deploy time, so they count as reachable.
      return !p.chatBaseUrl && !p.baseUrlEnvKey;
    }).map((p) => p.id);
    expect(unreachable).toEqual([]);
  });

  it('covers 13 first-party language-model providers; non-language dispatch lives in its own tables', () => {
    // Was 17: the "google-vertex" factory was removed 2026-08-13 as
    // unreachable — no registry row has ever carried that id, so the factory
    // could never be selected (resolveLanguageModel keys factories by
    // registry row id).
    // Was 16: "aws-bedrock", "google" and "deepinfra" were removed 2026-08-13
    // — each declared openAiCompatible while its first-party package built a
    // different route off the same base, measured 404 live. See the
    // openAiCompatible-contract describe block at the bottom of this file.
    const ids = firstPartyProviderIds();
    expect(ids).toHaveLength(13);
    // The LANGUAGE table stays language-only: adding a speech or transcription
    // provider here would surface it in the admin console's model picker as a
    // selectable remediation model and then fail at request time. Those
    // providers now HAVE dispatch — through resolveSpeechModel & co.'s own
    // per-modality tables, asserted in the suite below — just never this one.
    for (const nonLm of ['elevenlabs', 'deepgram', 'assemblyai', 'voyage', 'lmnt', 'hume', 'revai']) {
      expect(ids).not.toContain(nonLm);
    }
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
describe('per-modality factory tables — speech / transcription / embedding / image', () => {
  const DISPATCHED: readonly AiDispatchedModality[] = [
    'speech',
    'transcription',
    'embedding',
    'image',
  ];

  const RESOLVERS: Record<AiDispatchedModality, (input: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    env?: Record<string, string | undefined>;
  }) => unknown> = {
    speech: resolveSpeechModel,
    transcription: resolveTranscriptionModel,
    embedding: resolveEmbeddingModel,
    image: resolveImageModel,
  };

  /** A real model id for a row, from the registry's own data. */
  function modelIdFor(spec: AiProviderSpec): string {
    return spec.staticModels?.[0] ?? spec.defaultModel ?? 'stub-model';
  }

  /** Rows whose declared modalities include `modality`. */
  function declaringRows(modality: AiDispatchedModality): string[] {
    return AI_PROVIDERS.filter((p) => providerModalities(p).includes(modality))
      .map((p) => p.id)
      .sort();
  }

  it('each table names EXACTLY the providers whose registry rows declare that modality', () => {
    // Both inclusions at once. A table entry without the row marker is
    // dispatch the console cannot offer; a row marker without the entry is
    // the original connect-form-only defect. `video` is deliberately not in
    // DISPATCHED: fal/xai/replicate really export video models, but the `ai`
    // package's video surface is still experimental, so declared-video rows
    // have no resolver yet and are not held to this.
    for (const modality of DISPATCHED) {
      expect(modalityFactoryProviderIds(modality), modality).toEqual(declaringRows(modality));
    }
  });

  it('the four tables carry the full audio/vision/embedding fleet, not a token sample', () => {
    // The concrete rosters, named so a silent shrink is visible in review.
    expect(modalityFactoryProviderIds('speech')).toEqual([
      'deepgram', 'elevenlabs', 'fal', 'hume', 'lmnt', 'microsoft-foundry', 'mistral', 'openai', 'xai',
    ]);
    expect(modalityFactoryProviderIds('transcription')).toEqual([
      'assemblyai', 'deepgram', 'elevenlabs', 'fal', 'gladia', 'groq', 'microsoft-foundry', 'mistral', 'openai', 'revai', 'xai',
    ]);
    expect(modalityFactoryProviderIds('embedding')).toEqual([
      'cohere', 'fireworks', 'microsoft-foundry', 'mistral', 'openai', 'perplexity', 'together', 'voyage',
    ]);
    expect(modalityFactoryProviderIds('image')).toEqual([
      'fal', 'fireworks', 'luma', 'microsoft-foundry', 'openai', 'replicate', 'together', 'xai',
    ]);
  });

  it('EVERY table entry constructs a model from a stub credential with zero network traffic', () => {
    // Construction must be pure: a factory that phones home at build time
    // would bill a tenant for resolving a model it never called. fetch is
    // stubbed to a thrower, so any request fails the test loudly.
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('model CONSTRUCTION must not make network calls');
    }));
    try {
      for (const modality of DISPATCHED) {
        for (const id of modalityFactoryProviderIds(modality)) {
          const spec = AI_PROVIDERS.find((p) => p.id === id)!;
          const model = RESOLVERS[modality]({
            provider: id,
            model: modelIdFor(spec),
            apiKey: 'stub-credential',
            // microsoft-foundry's whole base is operator-supplied
            // (chatBaseUrl "{baseUrl}"); the per-call override stands in for
            // it exactly as the language resolver's own tests do.
            ...(spec.chatBaseUrl === '{baseUrl}'
              ? { baseUrl: 'https://stub-resource.example.test/v1' }
              : {}),
          });
          expect(model, `${modality}:${id}`).toBeTruthy();
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses an unknown provider with the same named error as the language resolver', () => {
    for (const modality of DISPATCHED) {
      expect(
        () => RESOLVERS[modality]({ provider: 'not-a-provider', model: 'm', apiKey: 'k' }),
        modality,
      ).toThrow(/unknown AI provider/);
    }
  });

  it('refuses a KNOWN provider that lacks the modality, naming what it does declare', () => {
    // anthropic's @ai-sdk package stubs every non-language method with a
    // NoSuchModelError thrower, so it must not be resolvable for any of these.
    for (const modality of DISPATCHED) {
      expect(hasModalityDispatch('anthropic', modality)).toBe(false);
      expect(
        () => RESOLVERS[modality]({ provider: 'anthropic', model: 'm', apiKey: 'k' }),
        modality,
      ).toThrow(new RegExp(`anthropic has no ${modality} models`));
    }
    // …and a single-modality row is refused OUTSIDE its modality: Voyage
    // embeds, it does not speak.
    expect(() => resolveSpeechModel({ provider: 'voyage', model: 'voyage-4', apiKey: 'k' })).toThrow(
      /voyage has no speech models/,
    );
    expect(() =>
      resolveEmbeddingModel({ provider: 'elevenlabs', model: 'eleven_v3', apiKey: 'k' }),
    ).toThrow(/elevenlabs has no embedding models/);
  });

  it('openai embeddings: the flagship first-party path builds the SDK embedding surface', () => {
    // The registry row now declares "embedding" and the table dispatches it —
    // the pair of facts the cross-check test holds for every provider, spelled
    // out here for the one most callers will actually use.
    expect(hasModalityDispatch('openai', 'embedding')).toBe(true);
    expect(providerModalities(getAiProvider('openai')!)).toContain('embedding');
    const model = resolveEmbeddingModel({
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'k',
    });
    // EmbeddingModel is `string | EmbeddingModelV*`; only the object form
    // carries the surface id. Assert the surface, not mere truthiness — the
    // same discipline the openai-responses language test above uses.
    expect(typeof model).not.toBe('string');
    const built = model as Exclude<typeof model, string>;
    expect(built.modelId).toBe('text-embedding-3-small');
    expect(String(built.provider)).toContain('openai');
  });

  it('openai embeddings: an unknown MODEL id still constructs (model ids are catalog data, not code)', () => {
    // Same contract as the language resolver: the table keys on the provider,
    // never the model id — a new embedding model is a catalog update, not a
    // code change, so construction must not gate on a known-ids list.
    expect(
      resolveEmbeddingModel({ provider: 'openai', model: 'text-embedding-99-future', apiKey: 'k' }),
    ).toBeTruthy();
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
    // 33, not 32: the self-hosted model-deployments row is genuinely
    // text-routable (a chat runtime, dispatched via per-candidate baseUrl).
    expect(routable.has('self-hosted')).toBe(true);
    // 52, not 33: nineteen rows were added 2026-08-13 across two parallel batches, every one of
    // them text and only text. Named individually rather than bumped, per the rule above — this
    // list IS the justification for the number, and it is also the guard that would catch an
    // audio/visual row being added to those blocks by mistake.
    //
    // Seventeen plain OpenAI-compatible chat endpoints:
    for (const id of [
      'byteplus',
      'scaleway',
      'ovhcloud',
      'publicai',
      'opencode-zen',
      'tencent',
      'modelscope',
      'upstage',
      'chutes',
      'venice',
      'featherless',
      'redpill',
      'ionet',
      'akashml',
      'prime-intellect',
      'vercel-gateway',
      'reka',
    ]) {
      expect(routable.has(id), id).toBe(true);
    }
    // …plus two subscription lanes. `chutes` is deliberately absent from this second list: it
    // appears once above, because the api-key row and the OIDC subscription collapsed onto ONE
    // row carrying both `envKey` and `oauth`/`subscriptionTransport`.
    //   opencode-go    — OpenCode Go plan, OpenAI-compatible at opencode.ai/zen/go/v1
    //   github-copilot — harness-transport: routable through the Copilot CLI, with NO chatBaseUrl,
    //                    which is exactly why the "addressable" guard above had to learn about
    //                    harness rows.
    expect(routable.has('opencode-go')).toBe(true);
    expect(routable.has('github-copilot')).toBe(true);
    // 53, not 52: Hetzner Inference (added 2026-08-18) — a plain OpenAI-compatible
    // text(+vision) chat endpoint at inference.hetzner.com/api/v1, text-routable.
    expect(routable.has('hetzner')).toBe(true);
    // 54, not 53: Ramp Router (added 2026-08-20) — a text-only routing gateway. It is the first
    // routable row that is NOT openAiCompatible: it speaks `openai-responses`, so it is reached at
    // /v1/responses rather than /chat/completions. Routability is a MODALITY question, not a
    // dialect one, which is exactly why it belongs in this set.
    expect(routable.has('router')).toBe(true);
    // 55, not 54: Command Code (added 2026-08-20) — a HARNESS row, so it is routable with no
    // chatBaseUrl at all, exactly like github-copilot above. Its transport is the vendor's CLI;
    // routability is still a modality question and this row is text.
    expect(routable.has('command-code')).toBe(true);
    // 56, not 55: EigenAI (wired 2026-09-10) — OpenAI-compatible text chat at
    // api-web.eigenai.com/api/v1. Its manifest row had existed with no registry entry.
    expect(routable.has('eigenai')).toBe(true);
    expect(routable.size).toBe(57);
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

  it('treats 402 (Payment Required) as permanent — MEASURED: two providers hit this in the same routing window, 2026-08-13', () => {
    // Before this, 402 fell through to the generic 5-minute MODEL_COOLDOWN_MS,
    // the same as a random transient blip — a depleted credit balance does
    // not refill itself in 5 minutes.
    expect(isPermanentAiCallFailure(apiCallError(402, true))).toBe(true);
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

describe('isBillingAiCallFailure — single-observation provider exclusion', () => {
  it('is true ONLY for 402', () => {
    expect(isBillingAiCallFailure(apiCallError(402))).toBe(true);
    // 401/403 stay account-scoped but NOT billing: they can plausibly be one
    // malformed key or one un-entitled model, so they still have to clear the
    // two-distinct-model threshold before the whole provider is cut off. A
    // 402 needs no corroboration — the account cannot pay, full stop.
    expect(isBillingAiCallFailure(apiCallError(401))).toBe(false);
    expect(isBillingAiCallFailure(apiCallError(403))).toBe(false);
    expect(isBillingAiCallFailure(apiCallError(404))).toBe(false);
    expect(isBillingAiCallFailure(apiCallError(429))).toBe(false);
  });

  it('is false for non-APICallError failures', () => {
    expect(isBillingAiCallFailure(new Error('Payment Required'))).toBe(false);
    expect(isBillingAiCallFailure(undefined)).toBe(false);
  });

  it('agrees with the other classifiers on a real 402', () => {
    // A 402 is simultaneously permanent (do not retry on a 5-min timer),
    // account-scoped (it is about the credential), and billing (escalate the
    // provider now). All three must hold or the escalation path is unreachable.
    const err = apiCallError(402);
    expect(isPermanentAiCallFailure(err)).toBe(true);
    expect(isAccountScopedAiCallFailure(err)).toBe(true);
    expect(isBillingAiCallFailure(err)).toBe(true);
  });
});

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

describe('resolveRateLimitRetryAfterMs — MEASURED (groq, 2026-08-13): a per-minute token budget clears well under the generic 5-minute default', () => {
  it('reads a Retry-After header given as integer seconds', () => {
    expect(resolveRateLimitRetryAfterMs(rateLimitedError({ 'retry-after': '30' }))).toBe(30_000);
  });

  it('reads a Retry-After header given as an HTTP-date', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const ms = resolveRateLimitRetryAfterMs(rateLimitedError({ 'retry-after': future }));
    expect(ms).toBeGreaterThan(40_000);
    expect(ms).toBeLessThanOrEqual(45_000);
  });

  it('clamps to the [1s, 30min] bound rather than trusting an extreme header verbatim', () => {
    expect(resolveRateLimitRetryAfterMs(rateLimitedError({ 'retry-after': '0' }))).toBe(1_000);
    expect(resolveRateLimitRetryAfterMs(rateLimitedError({ 'retry-after': '999999' }))).toBe(30 * 60 * 1000);
  });

  it('returns undefined — never a shorter-than-safe guess — when there is no usable header', () => {
    expect(resolveRateLimitRetryAfterMs(rateLimitedError())).toBeUndefined();
    expect(resolveRateLimitRetryAfterMs(rateLimitedError({ 'retry-after': 'not-a-value' }))).toBeUndefined();
  });

  it('only applies to 429 — a permanent-shaped 401/402/403/404 never reads this header', () => {
    expect(resolveRateLimitRetryAfterMs(apiCallError(402))).toBeUndefined();
    expect(resolveRateLimitRetryAfterMs(new Error('boom'))).toBeUndefined();
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
describe('openAiCompatible rows: probe and chat derive from the SAME base URL', () => {
  const compatible = AI_PROVIDERS.filter((p) => p.openAiCompatible && isTextRoutable(p));

  it('covers a meaningful share of the registry (a filter typo must not silently empty this)', () => {
    expect(compatible.length).toBeGreaterThan(20);
  });

  it('CATALOG: an operator-supplied base is read the SAME way by the probe and by chat', () => {
    // The rows where ONE stored value has to serve both readers — the exact
    // condition bedrock got wrong. `{baseUrl}` is the registry's placeholder
    // for "whatever the operator typed into baseUrlEnvKey", so a row that
    // carries it in one field and a hardcoded host in the other is declaring
    // two different endpoints for one credential.
    //
    // Rows with a FIXED chatBaseUrl are deliberately not held to a
    // shared-prefix rule: several probe a genuinely different service host on
    // purpose (baseten's control plane at api.baseten.co vs its inference
    // plane, huggingface's whoami-v2, cloudflare's account API). There is no
    // shared stored value there to disagree about — the WIRE test below is
    // what covers those.
    const mismatched = compatible.flatMap((p) => {
      const usesOperatorBase =
        p.chatBaseUrl === '{baseUrl}' || Boolean(p.probe.url?.includes('{baseUrl}'));
      if (!usesOperatorBase) return [];
      // Where the value comes from is not this test's business: three rows fill
      // it from baseUrlEnvKey, and self-hosted fills it per-candidate from a
      // model-deployment row. Both readers agreeing is.
      if (p.chatBaseUrl !== '{baseUrl}') {
        return [`${p.id}: probe reads the operator's base but chat is pinned to ${p.chatBaseUrl}`];
      }
      // No probe URL at all = nothing to disagree with. self-hosted is the
      // case: its "models" are live ModelDeployment rows, not an endpoint.
      if (!p.probe.url) return [];
      if (!p.probe.url.startsWith('{baseUrl}')) {
        return [`${p.id}: chat reads the operator's base but the probe is pinned to ${p.probe.url}`];
      }
      return [];
    });
    expect(mismatched).toEqual([]);
    // …and this is not vacuous: microsoft-foundry, custom-openai and
    // self-hosted are the rows whose whole base is supplied at runtime.
    expect(compatible.filter((p) => p.chatBaseUrl === '{baseUrl}').length).toBeGreaterThanOrEqual(3);
  });

  it('CATALOG: a row that TEMPLATES its base off one operator value probes that same base', () => {
    // The second way a base URL is operator-influenced, and the one aws-bedrock
    // moved to: the row owns the whole URL and substitutes ONE segment
    // (`{urlParam}` ← urlParamEnvKey). That removes the typo surface, but it
    // reintroduces the original defect — two hardcoded URLs in one row — the
    // moment the probe URL is written independently of chatBaseUrl. Same
    // invariant, stated for the shape that can now express it.
    const templated = compatible.filter(
      (p) => p.chatBaseUrl?.includes('{urlParam}') && p.probe.kind === 'openai-models'
    );
    expect(templated.map((p) => p.id)).toContain('aws-bedrock');
    expect(
      templated.flatMap((p) =>
        p.probe.url?.startsWith(`${p.chatBaseUrl}/`)
          ? []
          : [`${p.id}: probe ${p.probe.url} is not under its own chat base ${p.chatBaseUrl}`]
      )
    ).toEqual([]);
  });

  it('a templated row declares how its URL segment is supplied AND collected', () => {
    // Three facts that only work together: the placeholder, the env key that
    // fills it, and the prompt that lets an admin SET that key. bedrock's
    // predecessor had the first two on a free-text base URL and the third
    // rendered a whole URL field — which is how an operator came to store a
    // base with no /v1 and get a bare 404 that never checked the key.
    for (const p of AI_PROVIDERS.filter((row) => row.chatBaseUrl?.includes('{urlParam}'))) {
      expect(p.urlParamEnvKey, `${p.id} templates {urlParam} with no env key`).toBeTruthy();
      // Every key a card holds is set on that card, so the segment needs a prompt.
      expect(p.urlParamPrompt, `${p.id} templates {urlParam} with no prompt to set it`).toBeTruthy();
    }
  });

  it('aws-bedrock builds a complete /v1 base from a region alone', () => {
    // The requirement in one line: region in, working URL out — INCLUDING the
    // version prefix the operator used to have to remember.
    const bedrock = AI_PROVIDERS.find((p) => p.id === 'aws-bedrock')!;
    process.env.AWS_BEDROCK_REGION = 'ap-southeast-2';
    try {
      expect(resolveProviderUrl(bedrock, bedrock.chatBaseUrl!)).toBe(
        'https://bedrock-mantle.ap-southeast-2.api.aws/v1'
      );
      expect(resolveProviderUrl(bedrock, bedrock.probe.url!)).toBe(
        'https://bedrock-mantle.ap-southeast-2.api.aws/v1/models'
      );
    } finally {
      delete process.env.AWS_BEDROCK_REGION;
    }
  });

  it('aws-bedrock no longer reads a stored base URL — the region is the only input', () => {
    // The migration in apps/web platform-secrets.ts converts a stored
    // AWS_BEDROCK_BASE_URL into a region before the first hydrate. This pins
    // the reason that migration is REQUIRED rather than optional: with the
    // field gone from the row, a stored base URL has nothing to substitute
    // into and would be silently ignored.
    const bedrock = AI_PROVIDERS.find((p) => p.id === 'aws-bedrock')!;
    expect(bedrock.baseUrlEnvKey).toBeUndefined();
    process.env.AWS_BEDROCK_BASE_URL = 'https://bedrock-mantle.us-east-1.api.aws/v1';
    try {
      expect(resolveProviderUrl(bedrock, bedrock.chatBaseUrl!)).toContain('{urlParam}');
    } finally {
      delete process.env.AWS_BEDROCK_BASE_URL;
    }
  });

  it('rejects a malformed region and accepts every real AWS region shape', () => {
    const prompt = AI_PROVIDERS.find((p) => p.id === 'aws-bedrock')!.urlParamPrompt!;
    const shape = new RegExp(prompt.pattern);
    // Every geo pattern AWS actually ships, including the 4-segment GovCloud
    // ids — a shape check that rejected those would reject a working region.
    for (const region of ['us-east-1', 'ap-southeast-4', 'eu-central-2', 'us-gov-west-1', 'il-central-1'])
      expect(shape.test(region), region).toBe(true);
    // The values a URL field used to accept, and the empty/garbage cases.
    for (const bad of [
      'https://bedrock-mantle.us-east-1.api.aws',
      'us-east-1/v1',
      'US-EAST-1',
      'useast1',
      'us-east-',
      '',
      '../../etc',
    ])
      expect(shape.test(bad), bad).toBe(false);
  });

  // The ONE row that still builds a non-OpenAI route off its own
  // OpenAI-compatible base. @ai-sdk/cohere posts to `{base}/chat` (its native
  // v2 route) while the row's base is Cohere's /compatibility/v1 surface.
  // NOT fixed here because it is not PROVEN broken the way the other three
  // were: POST .../compatibility/v1/chat and .../compatibility/v1/chat/
  // completions BOTH answered 401 "no api key supplied" unauthenticated, so
  // the measurement cannot tell a live route from an auth check that runs
  // before routing. It is suspicious rather than settled — the row's own
  // `noNativeTools` veto records "every dispatch WITH tools fails with a bare
  // Not Found while bare completions work", which is exactly what a
  // wrong-route-with-a-tolerant-body would look like. Confirming it needs a
  // live Cohere key; until then this pins the divergence instead of hiding it.
  const KNOWN_NON_OPENAI_ROUTE: readonly string[] = ['cohere'];

  it('WIRE: every openAiCompatible row sends chat to an OpenAI-family route under its own base', async () => {
    // One sentinel base for every row, supplied as the per-call override, so
    // this asks the one question that matters: given a base, where does the
    // request ACTUALLY go? `/chat/completions` and `/responses` are the two
    // OpenAI-dialect surfaces (AI SDK 5 first-party providers default to
    // Responses); anything else means the row's `openAiCompatible: true` and
    // the thing building its requests disagree — the bedrock defect.
    //
    // Deliberately NOT compared against the row's `chatPath`: that field is
    // consumed by the hand-rolled builder in ai-provider-http.ts, a different
    // reader. Perplexity is the proof it would be the wrong yardstick — its
    // chatPath is /v1/sonar while the SDK uses /chat/completions, and BOTH are
    // live routes (measured: 401 on each, 404 on /v1/chat/completions).
    const OPENAI_ROUTES = ['/chat/completions', '/responses'];
    const BASE = 'https://sentinel.example.test/v1';
    const wrong: string[] = [];
    const diverged: string[] = [];
    for (const p of compatible) {
      // Harness-transport rows dispatch through a vendor CLI, not an HTTP base.
      if (subscriptionUsesHarness(p)) continue;
      const seen: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          seen.push(String(url));
          return new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }),
      );
      try {
        await streamAiChatTurn({
          provider: p.id,
          model: p.defaultModel ?? 'probe-model',
          apiKey: 'k',
          baseUrl: BASE,
          messages: [{ role: 'user', content: 'hi' }],
        }).catch(() => undefined);
      } finally {
        vi.unstubAllGlobals();
      }
      if (seen.length === 0) {
        wrong.push(`${p.id}: built a model that made no request at all`);
        continue;
      }
      const url = seen[0];
      const path = url.startsWith(`${BASE}/`) ? url.slice(BASE.length) : undefined;
      if (path === undefined) {
        wrong.push(`${p.id}: chat left the configured base entirely — went to ${url}`);
      } else if (!OPENAI_ROUTES.some((route) => path.split('?')[0] === route)) {
        diverged.push(p.id);
      }
    }
    expect(wrong).toEqual([]);
    // A NEW name here is this defect reappearing: the row promises the OpenAI
    // dialect and something is building a different route off the same base.
    // Removing a name is a fix and is equally required to update this list.
    expect(diverged.sort()).toEqual([...KNOWN_NON_OPENAI_ROUTE].sort());
  });

  it('no openAiCompatible row is ALSO claimed by a first-party factory that builds a different URL shape', () => {
    // The structural restatement of the wire test: it names the rows that
    // legitimately pair OpenAI compatibility with a first-party package.
    // Anything NEW appearing here is the bedrock defect reappearing under a
    // different provider name, and must be justified against the wire test
    // above before this list is edited.
    //
    //   microsoft-foundry — createAzure. Safe ONLY because the base is
    //     operator-supplied and non-'.openai.azure.com': @ai-sdk/azure v4.0.28
    //     branches on the HOSTNAME (isAzureOpenAIBaseURL), sending
    //     {base}{path} for a Foundry host but {base}/v1{path}?api-version=…
    //     for an *.openai.azure.com one. The factory is KEPT because the row
    //     declares `authHeader: 'api-key'` and createOpenAICompatible can only
    //     send Bearer — dropping it would break auth outright. The hazard is
    //     real but narrower than bedrock's, and it is pinned directly below
    //     rather than assumed away.
    const claimed = AI_PROVIDERS
      .filter((p) => p.openAiCompatible && hasFirstPartyProvider(p.id))
      .map((p) => p.id)
      .sort();
    expect(claimed).toContain('microsoft-foundry');
    // aws-bedrock is the row this suite was written for: OpenAI-compatible,
    // and deliberately NOT first-party.
    expect(hasFirstPartyProvider('aws-bedrock')).toBe(false);
    expect(getAiProvider('aws-bedrock')?.openAiCompatible).toBe(true);
  });

  it('microsoft-foundry: createAzure rewrites the base for an *.openai.azure.com host — the ONE remaining hazard, pinned not hidden', async () => {
    // Not a bug being tolerated silently: an operator who pastes an Azure
    // OpenAI resource URL gets chat aimed at {base}/v1/chat/completions while
    // the probe still reads {base}/models. This test states the exact
    // condition so that a future fix (or a vendor SDK change) is a deliberate
    // edit here, with evidence, rather than a surprise in production.
    const BASE = 'https://example-resource.openai.azure.com/openai';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seen.push(String(url));
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    try {
      await streamAiChatTurn({
        provider: 'microsoft-foundry',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: BASE,
        messages: [{ role: 'user', content: 'hi' }],
      }).catch(() => undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    // {base}/v1/… — the SDK inserted a /v1 the operator did not type, and
    // appended ?api-version…
    expect(seen[0]).toContain(`${BASE}/v1/`);
    expect(seen[0]).toContain('api-version=');
    // …while the row's probe reads {base}/models. Same stored value, two
    // different bases — the bedrock shape, surviving only because it is
    // confined to one hostname suffix.
    expect(getAiProvider('microsoft-foundry')?.probe.url).toBe('{baseUrl}/models');
  });
});
