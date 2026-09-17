/**
 * ONE WIRE LAYER FOR EVERY API-KEY PROVIDER — a registry row in, an AI SDK language model out.
 *
 * This replaces `ai-provider-http.ts`, which hand-rolled three dialects (`openai-chat`,
 * `anthropic-messages`, `openai-responses`), the `anthropic-version` / `anthropic-beta` header
 * branching, and the `tool_use` ↔ `tool_calls` translation. The SDK owns all of that now, so a new
 * provider costs a row and (at most) one line in the table below instead of a dialect.
 *
 * ── SCOPE, DELIBERATELY ────────────────────────────────────────────────────────────────────────
 * API-KEY CREDENTIALS ONLY. A subscription (`credentialSource === 'oauth'`) never comes here: those
 * tokens are not valid on the metered endpoints — the measured answer was
 * `401 "Missing scopes: model.request"` — so they go through the vendor's own CLI harness
 * (`remediation-harness-runner.ts`), which stays hand-written on purpose. One credential kind, one
 * route, no overlap.
 *
 * ── WHY A TABLE AND NOT A SWITCH ───────────────────────────────────────────────────────────────
 * A provider's factory is an IMPORT, and imports cannot be expressed as catalog data. So the table
 * is the one unavoidable code-side fact: one line per provider, no conditionals, no behaviour. Every
 * other decision — key env var, base URL, default model, whether the provider is OpenAI-shaped —
 * stays where it belongs, in the registry row. A provider ABSENT from the LANGUAGE table is not an
 * error: it falls through to the OpenAI-compatible adapter using its own `chatBaseUrl`, which is how
 * ~40 of the registry's 66 rows work (very few ever declared a dialect — most restate the default).
 * The non-language tables (speech / transcription / embedding / image, below) have NO such fallback:
 * those endpoints are not uniformly OpenAI-shaped, so absence there is a named error, never a guess.
 */

import type {
  EmbeddingModel,
  ImageModel,
  LanguageModel,
  SpeechModel,
  TranscriptionModel,
} from "ai";
import { APICallError, jsonSchema, streamText, tool } from "ai";
import type { JSONValue, Instructions } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createXai } from "@ai-sdk/xai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createFireworks } from "@ai-sdk/fireworks";
import { createCerebras } from "@ai-sdk/cerebras";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createBaseten } from "@ai-sdk/baseten";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// Audio, visual and embedding packages. Same rule as above: an import cannot be catalog data, so the
// per-modality factory tables below (FIRST_PARTY_SPEECH/TRANSCRIPTION/EMBEDDING/IMAGE_FACTORIES,
// consumed by resolveSpeechModel & co.) are the one code-side fact and everything else stays in the
// registry row. Every method named in those tables was READ from the installed package's own
// dist/*.d.ts + dist/index.js — several packages type a modality method that only throws
// NoSuchModelError (a ProviderV4 interface stub), and a stub must never earn a table entry.
import { createElevenLabs } from "@ai-sdk/elevenlabs";
import { createLMNT } from "@ai-sdk/lmnt";
import { createHume } from "@ai-sdk/hume";
import { createDeepgram } from "@ai-sdk/deepgram";
import { createRevai } from "@ai-sdk/revai";
import { createGladia } from "@ai-sdk/gladia";
import { createAssemblyAI } from "@ai-sdk/assemblyai";
import { createVoyage } from "@ai-sdk/voyage";
import { createFal } from "@ai-sdk/fal";
import { createLuma } from "@ai-sdk/luma";
import { createReplicate } from "@ai-sdk/replicate";
import {
  getAiProvider,
  modelReasoningEffort,
  providerModalities,
  subscriptionDispatchesDirect,
  type AiModality,
  type AiProviderSpec,
} from "./ai-provider-registry-public";
import {
  buildAiChatRequest,
  readAiChatResponseBody,
  extractChatText,
  extractToolCalls,
  extractStopReason,
  extractUsage,
  extractServedModel,
  extractServiceTier,
  extractProviderCostMicroUsd,
  type AiToolSpec,
} from "./ai-provider-http";

interface FactoryOptions {
  apiKey?: string;
  baseURL?: string;
}

/** Returns the provider's own callable: `provider(modelId)` → LanguageModel. */
type ProviderFactory = (
  opts: FactoryOptions,
) => (modelId: string) => LanguageModel;

/**
 * Registry id → first-party factory. Keyed by OUR row id, so a vendor renaming its package changes
 * one line here and nothing else in the platform.
 */
const FIRST_PARTY_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  openai: (o) => createOpenAI(o),
  anthropic: (o) => createAnthropic(o),
  // ── THREE ROWS DELIBERATELY ABSENT (2026-08-13) ────────────────────────────
  // Each declared `openAiCompatible: true` — i.e. "my chatBaseUrl serves the
  // OpenAI dialect" — while ALSO being mapped here to a first-party package
  // that builds a DIFFERENT route off that same base. One stored base URL
  // cannot satisfy both readers, so the /models connection test went green off
  // the OpenAI-compatible base while every chat call 404'd on the native one.
  // Absent from this table, each falls through to createOpenAICompatible and
  // the row's own base — one contract, one base URL. All three were MEASURED
  // live from the control plane (POST, no credential; 404 = no such route,
  // 401/400 = the route exists and answered):
  //
  //   aws-bedrock  @ai-sdk/amazon-bedrock@5.0.40 builds {base}/model/{id}/
  //     converse|invoke. {host}/models 404 · {host}/v1/models 401 (OpenAI-shaped
  //     body) · {host}/v1/chat/completions 405-on-GET. See the row in
  //     providers.ts for the full transcript and the /v1 requirement.
  //
  //   google  @ai-sdk/google builds {base}/models/{id}:streamGenerateContent,
  //     the NATIVE Gemini dialect, against the row's OpenAI-compat shim base.
  //     .../v1beta/openai/models/gemini-2.5-flash:streamGenerateContent 404 ·
  //     .../v1beta/openai/chat/completions 400 "model is not specified".
  //     The OAuth/Code Assist lane is unaffected — it never reaches this table
  //     (see oauthChat / dispatchOauthSurfaceChatTurn).
  //
  //   deepinfra  @ai-sdk/deepinfra's `baseURL` means the API ROOT and it
  //     appends /openai/chat/completions itself, while the row's chatBaseUrl
  //     already ends in /openai — so the two composed to a doubled segment.
  //     .../v1/openai/openai/chat/completions 404 {"detail":"Not Found"} ·
  //     .../v1/openai/chat/completions 401 "missing API key".
  //
  // The invariant is enforced, not just commented: see the
  // "openAiCompatible rows: probe and chat derive from the SAME base URL"
  // suite in ai-provider-models.vitest.test.ts.
  "microsoft-foundry": (o) => createAzure(o),
  xai: (o) => createXai(o),
  mistral: (o) => createMistral(o),
  groq: (o) => createGroq(o),
  cohere: (o) => createCohere(o),
  deepseek: (o) => createDeepSeek(o),
  together: (o) => createTogetherAI(o),
  fireworks: (o) => createFireworks(o),
  cerebras: (o) => createCerebras(o),
  perplexity: (o) => createPerplexity(o),
  baseten: (o) => createBaseten(o),
};

/** True when this row is served by a first-party package rather than the compatible adapter. */
export function hasFirstPartyProvider(providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    FIRST_PARTY_FACTORIES,
    providerId,
  );
}

/** Every provider id this module can build a model for — first-party or OpenAI-compatible. */
export function firstPartyProviderIds(): string[] {
  return Object.keys(FIRST_PARTY_FACTORIES).sort();
}

/**
 * The base URL for a row: an explicit env override wins over the row's own default, matching how
 * `resolveApiKeyCredential` already treats `baseUrlEnvKey` (a self-hosted or proxied endpoint is a
 * deployment fact, not a catalog fact).
 */
function resolveBaseUrl(
  spec: AiProviderSpec,
  env: Record<string, string | undefined>,
  override?: string,
): string | undefined {
  // A per-call override is the MOST deployment-specific fact there is — it
  // wins over both the env override and the row default. This is how a
  // candidate that IS a live endpoint (a self-hosted model deployment, whose
  // base URL is a row in the deployments table, not an env var) gets
  // dispatched through the same code path as every catalog provider.
  const fromCall = String(override || "").trim();
  if (fromCall) return fromCall;
  const fromEnv = spec.baseUrlEnvKey
    ? String(env[spec.baseUrlEnvKey] || "").trim()
    : "";
  return fromEnv || spec.chatBaseUrl || undefined;
}

export interface ResolveModelInput {
  provider: string;
  model: string;
  apiKey?: string;
  /** Per-call endpoint override (see resolveBaseUrl). Used for candidates
   *  whose endpoint is resolved per-deployment at routing time rather than
   *  from env/catalog — the self-hosted model-deployment bridge. */
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Build the language model for a provider+model pair.
 *
 * NEVER takes a `"provider/model"` STRING, and that is the entire point of the signature. AI SDK 5+
 * treats a bare `creator/model-name` string as a request to route through Vercel's AI Gateway, so the
 * most natural-looking port of the old `pick: { provider, model }` call site would have silently sent
 * every tenant's remediation traffic through a third party we do not own. Taking the two fields
 * separately makes that shape unrepresentable here.
 *
 * Throws when the row is unknown or has no usable endpoint: a model that cannot be addressed must
 * fail loudly at construction rather than produce a request aimed at nothing.
 */
export function resolveLanguageModel(input: ResolveModelInput): LanguageModel {
  const spec = getAiProvider(input.provider);
  if (!spec) throw new Error(`unknown AI provider: ${input.provider}`);
  const modelId = String(input.model || spec.defaultModel || "").trim();
  if (!modelId) throw new Error(`no model id for provider ${input.provider}`);

  const env = input.env ?? process.env;
  const baseURL = resolveBaseUrl(spec, env, input.baseUrl);
  const opts: FactoryOptions = {
    apiKey: input.apiKey,
    ...(baseURL ? { baseURL } : {}),
  };

  const firstParty = FIRST_PARTY_FACTORIES[spec.id];
  if (firstParty) return firstParty(opts)(modelId);

  // OpenAI-shaped fallback. `createOpenAICompatible` REQUIRES a baseURL — there is no sensible
  // default for "some other vendor's endpoint" — so a row reaching here without one is a catalog gap
  // to fix, not something to guess at.
  if (!baseURL) {
    throw new Error(
      `provider ${spec.id} has no first-party AI SDK package and no chatBaseUrl/${spec.baseUrlEnvKey ?? "baseUrlEnvKey"} to reach`,
    );
  }

  // RESPONSES-ONLY rows take OpenAI's Responses surface against THEIR base URL, not the compatible
  // adapter. `createOpenAICompatible` builds `{baseURL}/chat/completions`, which is precisely the
  // route these gateways do not serve — Ramp Router documents it as a 404 — so the compatible
  // adapter would leave the SDK lane permanently broken while the hand-rolled HTTP lane
  // (buildAiChatRequest) worked, which is the same split-brain the three absent first-party rows
  // above were removed to fix. Keyed on the DIALECT, never on a provider id, so a second
  // Responses-only vendor needs no code here.
  if (spec.chatDialect === "openai-responses") {
    return createOpenAI(opts).responses(modelId);
  }

  return createOpenAICompatible({
    name: spec.id,
    apiKey: input.apiKey,
    baseURL,
    ...(spec.responseCostUsdPath
      ? { metadataExtractor: responseCostMetadataExtractor(spec.id, spec.responseCostUsdPath) }
      : {}),
  })(modelId);
}

// ── SPEECH / TRANSCRIPTION / EMBEDDING / IMAGE DISPATCH ─────────────────────
//
// Same architecture as FIRST_PARTY_FACTORIES above: keyed by OUR registry row
// id, one line per provider, no behaviour. Two deliberate differences from the
// language table:
//
//   1. NO OpenAI-compatible fallback. `createOpenAICompatible` only speaks the
//      chat/completions dialect family; a speech, transcription, embedding or
//      image endpoint has no uniform wire shape to fall back to, so a row
//      absent from its modality table is a NAMED error at construction rather
//      than a request aimed at the wrong route.
//   2. Some vendors' SDK factories take NO model id (xai speech/transcription
//      and gladia transcription serve one fixed model; hume's speech model id
//      is the empty sentinel) — those entries simply ignore the resolved id,
//      which callers still supply from the row's staticModels.
//
// EVERY entry was verified against the installed package's dist output, not
// vendor docs and not memory. The traps this avoided, worth recording so the
// next audit does not "fix" them back in:
//   - Most @ai-sdk packages TYPE textEmbeddingModel()/imageModel() because the
//     ProviderV4 interface requires them, but implement them as
//     NoSuchModelError throwers (groq, deepgram, elevenlabs, assemblyai,
//     gladia, revai, cerebras, deepseek, anthropic, xai embeddings; mistral,
//     cohere, perplexity, hume, lmnt images; fal/replicate embeddings). A
//     table built from the .d.ts alone would dispatch straight into a throw.
//   - @ai-sdk/replicate authenticates with `apiToken`, not `apiKey`.
//   - @ai-sdk/perplexity REALLY does implement embeddings at the installed
//     version, however surprising. @ai-sdk/baseten's embedding factory is
//     also real but requires a per-deployment modelURL and throws at
//     construction without one — a catalog model id cannot address it, so
//     baseten is deliberately absent here and undeclared in the registry.
//   - The pure-audio packages (elevenlabs, lmnt, hume, deepgram, revai,
//     gladia, assemblyai) accept `apiKey` only — no `baseURL` setting exists,
//     so a base-URL override is silently inapplicable there.
//   - @ai-sdk/google is NOT installed (the google row dispatches language via
//     the OpenAI-compat shim), so google embedding/image have no factory to
//     name and are deliberately absent.
//   - Video is real in @ai-sdk/xai, @ai-sdk/fal and @ai-sdk/replicate but the
//     `ai` package's video surface is still experimental
//     (Experimental_VideoModelV4); no video table is declared yet.

/** Returns a callable that builds this modality's model from a model id. */
type ModalityFactory<M> = (opts: FactoryOptions) => (modelId: string) => M;

/** Registry id → text-to-speech factory. Method verified real (non-stub) in each installed package. */
const FIRST_PARTY_SPEECH_FACTORIES: Readonly<
  Record<string, ModalityFactory<SpeechModel>>
> = {
  openai: (o) => (m) => createOpenAI(o).speech(m),
  "microsoft-foundry": (o) => (m) => createAzure(o).speech(m),
  // Fixed-model surface: XaiProvider.speech() takes no id (grok voice).
  xai: (o) => () => createXai(o).speech(),
  mistral: (o) => (m) => createMistral(o).speech(m),
  elevenlabs: (o) => (m) => createElevenLabs(o).speech(m),
  lmnt: (o) => (m) => createLMNT(o).speech(m),
  // HumeProvider.speech() takes no id — the SDK's model id is the '' sentinel;
  // the row's staticModels surface it as "default".
  hume: (o) => () => createHume(o).speech(),
  deepgram: (o) => (m) => createDeepgram(o).speech(m),
  fal: (o) => (m) => createFal(o).speech(m),
};

/** Registry id → speech-to-text factory. */
const FIRST_PARTY_TRANSCRIPTION_FACTORIES: Readonly<
  Record<string, ModalityFactory<TranscriptionModel>>
> = {
  openai: (o) => (m) => createOpenAI(o).transcription(m),
  "microsoft-foundry": (o) => (m) => createAzure(o).transcription(m),
  // Fixed-model surface: XaiProvider.transcription() takes no id.
  xai: (o) => () => createXai(o).transcription(),
  mistral: (o) => (m) => createMistral(o).transcription(m),
  groq: (o) => (m) => createGroq(o).transcription(m),
  elevenlabs: (o) => (m) => createElevenLabs(o).transcription(m),
  deepgram: (o) => (m) => createDeepgram(o).transcription(m),
  // @ai-sdk/revai types a CLOSED model-id union ('machine' | 'low_cost' |
  // 'fusion') with no `(string & {})` widening and does not export the type.
  // Model ids are catalog data here (the row's staticModels carry that exact
  // set), so the assertion states the boundary rather than closing the table
  // over a vendor union it cannot import.
  revai: (o) => (m) =>
    createRevai(o).transcription(m as Parameters<ReturnType<typeof createRevai>['transcription']>[0]),
  // Fixed-model surface: GladiaProvider.transcription() takes no id.
  gladia: (o) => () => createGladia(o).transcription(),
  assemblyai: (o) => (m) => createAssemblyAI(o).transcription(m),
  fal: (o) => (m) => createFal(o).transcription(m),
};

/** Registry id → text-embedding factory. */
const FIRST_PARTY_EMBEDDING_FACTORIES: Readonly<
  Record<string, ModalityFactory<EmbeddingModel>>
> = {
  openai: (o) => (m) => createOpenAI(o).textEmbeddingModel(m),
  "microsoft-foundry": (o) => (m) => createAzure(o).textEmbeddingModel(m),
  mistral: (o) => (m) => createMistral(o).textEmbeddingModel(m),
  cohere: (o) => (m) => createCohere(o).textEmbeddingModel(m),
  together: (o) => (m) => createTogetherAI(o).textEmbeddingModel(m),
  fireworks: (o) => (m) => createFireworks(o).textEmbeddingModel(m),
  perplexity: (o) => (m) => createPerplexity(o).textEmbeddingModel(m),
  voyage: (o) => (m) => createVoyage(o).textEmbeddingModel(m),
};

/** Registry id → image-generation factory. */
const FIRST_PARTY_IMAGE_FACTORIES: Readonly<
  Record<string, ModalityFactory<ImageModel>>
> = {
  openai: (o) => (m) => createOpenAI(o).image(m),
  "microsoft-foundry": (o) => (m) => createAzure(o).image(m),
  xai: (o) => (m) => createXai(o).image(m),
  together: (o) => (m) => createTogetherAI(o).image(m),
  fireworks: (o) => (m) => createFireworks(o).image(m),
  fal: (o) => (m) => createFal(o).image(m),
  luma: (o) => (m) => createLuma(o).image(m),
  // @ai-sdk/replicate's credential setting is `apiToken`, not `apiKey`.
  replicate: (o) => (m) =>
    createReplicate({
      apiToken: o.apiKey,
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    }).image(m),
};

/** The four dispatched non-language modalities. `text` and `video` are deliberately not members:
 *  text has its own resolver above, and video has no stable surface in the installed `ai` package. */
export type AiDispatchedModality = Extract<
  AiModality,
  "speech" | "transcription" | "embedding" | "image"
>;

const MODALITY_FACTORY_TABLES = {
  speech: FIRST_PARTY_SPEECH_FACTORIES,
  transcription: FIRST_PARTY_TRANSCRIPTION_FACTORIES,
  embedding: FIRST_PARTY_EMBEDDING_FACTORIES,
  image: FIRST_PARTY_IMAGE_FACTORIES,
} as const;

/** Every provider id that can actually be dispatched for `modality` — the table keys, sorted.
 *  The registry cross-check test holds these ⊆ the rows DECLARING that modality, so the console
 *  can trust a declared modality to be dispatchable and vice versa. */
export function modalityFactoryProviderIds(
  modality: AiDispatchedModality,
): string[] {
  return Object.keys(MODALITY_FACTORY_TABLES[modality]).sort();
}

/** True when `providerId` has a real (non-stub) factory for `modality`. */
export function hasModalityDispatch(
  providerId: string,
  modality: AiDispatchedModality,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    MODALITY_FACTORY_TABLES[modality],
    providerId,
  );
}

/**
 * Shared core for the four non-language resolvers. Mirrors resolveLanguageModel
 * exactly — same registry lookup, same model-id defaulting, same base-URL
 * precedence (per-call override > env override > row default) — minus the
 * OpenAI-compatible fallback, which does not exist for these modalities (see
 * the table header above). Errors are constructed to name the exact gap: an
 * unknown row, a row that declares the modality but lost its table entry, or a
 * row that simply has no models of this kind.
 */
function resolveModalityModel<M>(
  modality: AiDispatchedModality,
  table: Readonly<Record<string, ModalityFactory<M>>>,
  input: ResolveModelInput,
): M {
  const spec = getAiProvider(input.provider);
  if (!spec) throw new Error(`unknown AI provider: ${input.provider}`);
  const factory = table[spec.id];
  if (!factory) {
    const declared = providerModalities(spec);
    throw new Error(
      declared.includes(modality)
        ? `provider ${spec.id} declares ${modality} but has no dispatch entry in the ${modality} factory table — the installed @ai-sdk package must expose a real (non-stub) ${modality} factory before the row may declare it`
        : `provider ${spec.id} has no ${modality} models (declares: ${declared.join(", ")})`,
    );
  }
  const modelId = String(input.model || spec.defaultModel || "").trim();
  if (!modelId) throw new Error(`no model id for provider ${input.provider}`);
  const env = input.env ?? process.env;
  const baseURL = resolveBaseUrl(spec, env, input.baseUrl);
  const opts: FactoryOptions = {
    apiKey: input.apiKey,
    ...(baseURL ? { baseURL } : {}),
  };
  return factory(opts)(modelId);
}

/** Build the text-to-speech model for a provider+model pair. Same signature contract as
 *  resolveLanguageModel: provider and model are SEPARATE fields, never a joined string. */
export function resolveSpeechModel(input: ResolveModelInput): SpeechModel {
  return resolveModalityModel("speech", FIRST_PARTY_SPEECH_FACTORIES, input);
}

/** Build the speech-to-text model for a provider+model pair. */
export function resolveTranscriptionModel(
  input: ResolveModelInput,
): TranscriptionModel {
  return resolveModalityModel(
    "transcription",
    FIRST_PARTY_TRANSCRIPTION_FACTORIES,
    input,
  );
}

/** Build the text-embedding model for a provider+model pair. */
export function resolveEmbeddingModel(input: ResolveModelInput): EmbeddingModel {
  return resolveModalityModel(
    "embedding",
    FIRST_PARTY_EMBEDDING_FACTORIES,
    input,
  );
}

/** Build the image-generation model for a provider+model pair. */
export function resolveImageModel(input: ResolveModelInput): ImageModel {
  return resolveModalityModel("image", FIRST_PARTY_IMAGE_FACTORIES, input);
}

// ── One streamed, tool-calling chat turn ────────────────────────────────────
//
// The SDK is the ONLY thing in this file that may be imported from `ai` (see
// scripts/assert-ai-sdk-boundary.sh), so callers that want a streamed turn with
// NATIVE tool calling come through here rather than hand-rolling a dialect.
//
// What this replaces at the call site: a hand-built fetch, an SSE reader, a
// regex scan over partially-arrived JSON to guess whether the turn was final,
// and a hand-written JSON-string-escape decoder. The SDK already knows which
// dialect the provider speaks, how to stream it, and how to read tool calls
// back out — including on `anthropic-messages`, which the hand-rolled path
// could not stream at all.

/** One callable tool, dialect-agnostic. `parameters` is a JSON Schema object. */
export interface AiChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiChatTurnInput {
  provider: string;
  model: string;
  apiKey?: string;
  /** Per-call endpoint override, threaded to resolveLanguageModel — see
   *  ResolveModelInput.baseUrl. Ignored on the OAuth direct-transport path
   *  (those surfaces own their URLs). */
  baseUrl?: string;
  /**
   * Absent/'platform-secret'/'env' (any API key) dispatches through the AI
   * SDK exactly as before. 'oauth' on a provider whose registry row declares
   * `subscriptionTransport: 'direct'` (Codex, Code Assist) is dispatched
   * through the SAME hand-rolled request/response pipeline
   * ai-provider-http.ts already built and tested for those non-standard
   * surfaces, since neither speaks the standard chat-completions/messages
   * API an AI-SDK provider factory expects. This branch is router-level and
   * credential-driven — every caller (ClikAgent, ClikNet, ClikEvents, admin
   * test tools) gets it automatically with no agent-specific code anywhere.
   * 'oauth' on a `harness`-transport or unspendable provider is never valid
   * input here — see resolveEffectiveCredential's own doc comment for where
   * that's already refused before a credential ever reaches this function.
   */
  credentialSource?: "oauth" | "platform-secret" | "env";
  /** Required by the Codex direct-transport surface alongside the bearer
   *  token; ignored otherwise. See ChatTurnInput.accountId in
   *  ai-provider-http.ts for the full reasoning. */
  accountId?: string;
  /** Required by the Code Assist direct-transport surface; ignored
   *  otherwise. See ChatTurnInput.projectId in ai-provider-http.ts. */
  projectId?: string;
  system?: string;
  /**
   * Ask the provider to CACHE this prompt's stable prefix.
   *
   * Only meaningful on a provider whose registry row declares
   * `promptCaching: 'explicit'` — Anthropic caches nothing without a
   * breakpoint on the request. On an 'automatic' provider this is ignored,
   * because there is no parameter to send: the vendor decides, and the only
   * lever is prompt ordering.
   *
   * OPT-IN, and deliberately not defaulted on. An explicit cache WRITE costs
   * about 1.25x the base input rate, so caching a prefix used exactly once is a
   * 25% loss. It pays from the second reuse inside the TTL — which is the
   * normal case for an agent loop and the abnormal case for a one-shot call, so
   * the caller is the only layer that knows which it is.
   */
  cachePrompt?: boolean;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: AiChatTool[];
  /**
   * Forces the model to actually invoke one of `tools` rather than legally
   * answering in prose instead — the AI SDK translates this uniformly across
   * every AI-SDK-dispatched provider (OpenAI, Anthropic, Google, xAI,
   * Mistral, Groq, and the generic OpenAI-compatible adapter used for
   * DeepInfra/Novita/HuggingFace/OpenRouter). A model that genuinely cannot
   * comply throws a classifiable APICallError instead of silently declining.
   * Only meaningful alongside `tools`; ignored when `tools` is absent.
   *
   * ONLY set this on a turn where EVERY legitimate response requires a tool
   * call — see ai-model-health-probe.ts, whose entire prompt IS "call this
   * tool now". model-call.ts's live ClikAgent chat path deliberately never
   * sets this: its tools are the account's whole capability surface,
   * attached whether or not THIS message needs one, so forcing a call there
   * would turn an ordinary no-tool-needed question into a hallucinated tool
   * invocation — a worse failure than the prose-refusal this was built to
   * replace. That live path still detects refusal via
   * looksLikeCapabilityRefusal (ai-model-capability.ts) for exactly this
   * reason.
   */
  toolChoice?: "required";
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Called with each text delta as it arrives. Absent = buffer, no streaming.
   * A direct-transport OAuth dispatch (see `credentialSource` above) has no
   * incremental delta channel of its own — Codex answers as one aggregated
   * SSE stream that is collected into a single final text before this
   * function ever sees it — so `onDelta`, if given, fires exactly ONCE with
   * the complete text rather than token-by-token. A real degradation for a
   * live-typing UI, but a correct one: the alternative is silently never
   * calling it at all, which would look like the model produced no output.
   */
  onDelta?: (text: string) => void;
  /**
   * Passed straight to the SDK's `providerOptions.openai.reasoningEffort` (the only vendor with
   * registry data for this — see `modelReasoningEffort` in ai-provider-registry.ts). Callers should
   * source this from `modelReasoningEffort(provider, model)` rather than inventing a value: sending
   * it to a model that doesn't support the parameter is a hard 400 on some vendors, so it must only
   * ever be set when the registry says the model is reasoning-capable.
   */
  reasoningEffort?: import("./ai-provider-registry").AiReasoningEffort;
}

export interface AiChatTurnWarning {
  type: string;
  feature?: string;
  details?: string;
}

export interface AiChatTurnResult {
  /** The model's prose for this turn (may be empty on a pure tool-calling turn). */
  text: string;
  /**
   * The AI SDK's own structured warnings for this call — e.g.
   * `{ type: "unsupported", feature: "tools" }`, confirmed live in the
   * installed @ai-sdk/openai-compatible adapter's own source: some
   * dispatch paths SILENTLY DROP an unsupported parameter and warn rather
   * than throwing. A caller that only checks for a thrown error (as this
   * whole codebase's tool-calling-capability detection originally did)
   * would wrongly conclude "the call succeeded, so tools are supported"
   * when they were actually stripped before the request ever went out. See
   * ai-model-capability.ts's hasUnsupportedToolsWarning.
   */
  warnings?: AiChatTurnWarning[];
  /**
   * Native tool calls the model made. `args` is already a decoded object with
   * the schema's own types — numbers arrive as numbers, so nothing downstream
   * has to re-coerce a stringified argument back.
   */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * Observed token usage. `inputTokens` is what a context budget calibrates on.
   *
   * THE DECOMPOSITION IS THE POINT. `inputTokens` is the TOTAL, and the AI SDK
   * normalizes that consistently across vendors whose own wire formats disagree
   * (Anthropic reports `input_tokens` EXCLUDING cache and lists the cache
   * counters separately; OpenAI reports an `input_tokens` that already includes
   * them). Reading only the total and one cache counter therefore could not be
   * priced correctly without a per-vendor branch — so all three sub-counts are
   * carried, and the invariant
   *
   *     inputTokens === uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens
   *
   * holds for every provider the SDK serves. A field is absent when the vendor
   * reported nothing for it, never 0 standing in for silence.
   */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    /** Input tokens billed at the FULL rate — neither read from nor written to cache. */
    uncachedInputTokens?: number;
    /** Cache-READ input tokens; discounted (up to 10x) where a vendor prices them. */
    cachedInputTokens?: number;
    /** Cache-WRITE input tokens; billed at a PREMIUM (typically 1.25x) where a vendor prices them. */
    cacheWriteInputTokens?: number;
    /**
     * Reasoning tokens, already INCLUDED in `outputTokens`. Carried separately
     * because the split is the only way to see a model that spent its whole
     * output budget thinking and returned nothing — a real, diagnosed failure
     * mode on this platform (see the registry's `modelWindows` note) that the
     * combined total renders invisible.
     */
    reasoningTokens?: number;
  };
  /** Provider response headers, when the transport exposes them (rate limits). */
  headers?: Record<string, string>;
  /** Unified finish reason for the turn (e.g. 'stop', 'length', 'tool-calls'), when the SDK resolves one. */
  stopReason?: string;
  /**
   * The model the vendor says actually served this turn, verbatim — see `extractServedModel`.
   *
   * Undefined when the vendor named none. It is deliberately NOT defaulted to the requested model:
   * "we asked for X and the vendor confirmed X" and "we asked for X and the vendor said nothing"
   * are different facts, and collapsing them would manufacture a confirmation that never happened.
   */
  servedModel?: string;
  /** Vendor's service/capacity tier for this call (e.g. 'flex', 'default'), verbatim — see
   *  `extractServiceTier`. Cost-relevant: tiers of the same model bill differently. */
  serviceTier?: string;
  /**
   * Vendor-reported EXACT micro-USD cost for this call, when the provider's SDK surfaces one in
   * `providerMetadata` (currently: Perplexity, see `extractPerplexityCostMicroUsd`). Undefined for
   * every other provider — callers pass this straight to `attributeAiInvocation`'s `costMicroUsd`,
   * which falls back to its own token-rate estimate when it's undefined.
   */
  costMicroUsd?: number;
}

/**
 * Perplexity's AI SDK provider (`@ai-sdk/perplexity`) parses the response's `usage.cost.total_cost`
 * (USD, see `extractProviderCostMicroUsd` in ai-provider-http.ts for the same field on the raw-fetch
 * path and the docs citation) into `providerMetadata.perplexity.cost.totalCost` — camelCased, per the
 * installed package's own `convert-perplexity-usage`/response mapping (verified by reading
 * `@ai-sdk/perplexity`'s dist source directly, not guessed). Same USD × 1,000,000 → micro-USD
 * conversion as the raw-fetch path. Returns undefined for every other provider or when the SDK
 * didn't attach the metadata (e.g. mid-stream chunks before usage arrives).
 */
export function extractPerplexityCostMicroUsd(
  provider: string,
  providerMetadata: Record<string, unknown> | undefined,
): number | undefined {
  const metadataKey = getAiProvider(provider)?.sdkCostMetadataKey;
  if (!metadataKey || !providerMetadata) return undefined;
  const meta = providerMetadata[metadataKey] as
    Record<string, unknown> | undefined;
  const cost = meta?.cost as Record<string, unknown> | undefined;
  const totalCost = cost?.totalCost;
  if (typeof totalCost !== "number" || !Number.isFinite(totalCost))
    return undefined;
  return Math.max(0, Math.round(totalCost * 1_000_000));
}

/**
 * The vendor's OWN reported USD cost for a call, read from the raw usage
 * object at the path the registry row declares (`usageCostUsdPath`).
 *
 * Summed ACROSS STEPS, because that is where the number actually survives: the
 * AI SDK's `totalUsage` aggregator rebuilds a fresh usage object from the token
 * counters and does not carry `raw` forward, while each individual step keeps
 * the provider's untouched payload. A multi-step tool-calling turn is several
 * billed requests, so the sum is also the correct total rather than a
 * convenient one.
 *
 * Returns undefined when the row declares no path, when no step carried a
 * usable number, or when the value is not finite — every one of which leaves
 * the caller on its existing catalog-rate estimate.
 */
export function extractDeclaredUsageCostMicroUsd(
  provider: string,
  steps: ReadonlyArray<{ usage?: { raw?: unknown } }>,
): number | undefined {
  const path = getAiProvider(provider)?.usageCostUsdPath;
  if (!path || path.length === 0) return undefined;
  let totalUsd = 0;
  let sawOne = false;
  for (const step of steps) {
    let cursor: unknown = step.usage?.raw;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    const usd = typeof cursor === "string" ? Number(cursor) : cursor;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) continue;
    totalUsd += usd;
    sawOne = true;
  }
  if (!sawOne) return undefined;
  return Math.max(0, Math.round(totalUsd * 1_000_000));
}

/** Settled provider cost captured from a complete response or stream chunk by
 * the compatible adapter's metadata hook. Kept in USD until this boundary so
 * it follows the same conversion and rounding rule as raw-usage costs. */
export function extractDeclaredResponseCostMicroUsd(
  provider: string,
  providerMetadata: Record<string, unknown> | undefined,
): number | undefined {
  if (!getAiProvider(provider)?.responseCostUsdPath) return undefined;
  const metadata = providerMetadata?.[provider];
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>).settledCostUsd;
  const usd = typeof raw === "string" ? Number(raw) : raw;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  return Math.max(0, Math.round(usd * 1_000_000));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** Capture a vendor extension before @ai-sdk/openai-compatible validates the
 * standard OpenAI fields and drops unknown top-level properties. */
function responseCostMetadataExtractor(provider: string, path: readonly string[]) {
  const read = (body: unknown): number | string | undefined => {
    const raw = valueAtPath(body, path);
    const usd = typeof raw === "string" ? Number(raw) : raw;
    return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
      ? (raw as number | string)
      : undefined;
  };
  return {
    async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
      const settledCostUsd = read(parsedBody);
      return settledCostUsd === undefined
        ? undefined
        : { [provider]: { settledCostUsd } };
    },
    createStreamExtractor() {
      let settledCostUsd: number | string | undefined;
      return {
        processChunk(chunk: unknown) {
          const found = read(chunk);
          if (found !== undefined) settledCostUsd = found;
        },
        buildMetadata() {
          return settledCostUsd === undefined
            ? undefined
            : { [provider]: { settledCostUsd } };
        },
      };
    },
  };
}

/**
 * Whether a failed `streamAiChatTurn` call is a PERMANENT configuration
 * problem (a deprecated/renamed model id, an invalid credential, an
 * unauthorized scope, an exhausted/lapsed billing account — 401/402/403/404,
 * or the SDK's own `isRetryable: false` verdict) versus a TRANSIENT one
 * (rate-limited, momentarily unavailable, a plain network hiccup). Callers
 * use this to decide how long a routing cooldown should last: retrying a 404
 * five minutes later is pure waste — nothing about elapsed time makes a
 * renamed model id valid again — while a 429 or 503 genuinely can clear up
 * on its own shortly. An AbortError (our own ROUTED_MODEL_TIMEOUT_MS firing)
 * is neither — a slow response under load is not evidence the model itself
 * is broken, so callers should exclude aborts from calling this at all.
 *
 * 402 (Payment Required) was MEASURED here as a live incident, not a
 * hypothetical: two DIFFERENT providers (mistral, huggingface) both
 * returned it within the same ~300ms routing window, and — before this —
 * both got the plain 5-minute reactive cooldown (MODEL_COOLDOWN_MS), the
 * same as a random transient blip. A depleted credit balance or a lapsed
 * subscription does not refill itself in 5 minutes; treating it as
 * transient meant the router would burn a routed attempt on the same known-
 * broken credential again on every chat turn for the rest of that window
 * and the next, and the one after that. It belongs with 401/403/404: none
 * of the four resolve on a timer, all four need something OUTSIDE the
 * request (an admin action, a renamed model fixed, credits topped up) —
 * which is exactly what the proactive health probe's event-driven
 * `clearModelCooldown` already exists to detect early, the moment any of
 * them actually starts working again, well before the 24h backstop.
 */
export function isPermanentAiCallFailure(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (
    error.statusCode === 401 ||
    error.statusCode === 402 ||
    error.statusCode === 403 ||
    error.statusCode === 404
  )
    return true;
  return error.isRetryable === false;
}

/**
 * When a 429 (rate-limited) failure's response carries a `retry-after`
 * header, read the real wait time instead of guessing — MEASURED (groq,
 * 2026-08-13): "Limit 12000, Requested 17857" on a per-MINUTE token budget,
 * a window that clears in well under the router's generic 5-minute
 * MODEL_COOLDOWN_MS default, so the flat cooldown was making the router
 * wait roughly 4 minutes longer than the provider itself required. Returns
 * undefined when the error isn't a 429, carries no usable header, or the
 * header value is unparseable — callers fall back to the generic default in
 * every one of those cases, never a shorter-than-safe guess.
 *
 * Accepts both header shapes the HTTP spec allows: an integer count of
 * seconds ("Retry-After: 30") and an HTTP-date ("Retry-After: Wed, 21 Oct
 * 2026 07:28:00 GMT"). Clamped to [1s, 30min] — a provider sending 0 (retry
 * instantly, which would defeat the whole point of a cooldown) or an
 * absurdly large value (a misconfigured header holding a model out of
 * rotation for a whole day on one 429) is bounded rather than trusted
 * verbatim; the cooldown's OWN backstop mechanisms (the proactive probe,
 * the flat ceiling) are what real long-term exclusion should come from.
 */
export function resolveRateLimitRetryAfterMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  if (error.statusCode !== 429) return undefined;
  const headers = error.responseHeaders as Record<string, string> | undefined;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const MIN_MS = 1_000;
  const MAX_MS = 30 * 60 * 1000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(seconds * 1000)));
  }
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const deltaMs = asDate - Date.now();
    if (deltaMs > 0) return Math.min(MAX_MS, Math.max(MIN_MS, deltaMs));
  }
  return undefined;
}

/**
 * Whether a failure says something about the CREDENTIAL/ACCOUNT itself,
 * rather than just the one model id that happened to be called. The same
 * credential is used for every model at a given provider, so a 401/402/403
 * (unauthorized, payment required, forbidden) on ANY model is real evidence
 * the credential is broadly unusable. A 404, deliberately excluded here, says
 * only "this specific model id doesn't exist" — it is completely silent
 * about whether the other 189 models a provider like HuggingFace hosts are
 * fine, and must never be treated as evidence they aren't. Used to decide
 * whether a failure should count toward provider-wide cooldown escalation
 * (ai-model-cooldown.ts) — deliberately a narrower, higher-confidence check
 * than isPermanentAiCallFailure above, since escalating wrongly costs every
 * OTHER model at that provider a wasted routing window, not just this one.
 */
/**
 * The provider refused this REQUEST for being too big — not this MODEL for
 * being broken.
 *
 * The distinction is the whole point. Everything else `isPermanentAiCallFailure`
 * catches is a durable property of the model or the credential: a renamed id, a
 * dead key, a revoked entitlement. "Reduce your message size" is a property of
 * what WE sent, and the very next request may be a tenth the size.
 *
 * WHAT TREATING IT AS PERMANENT COST, measured 2026-08-26: groq answers an
 * over-budget prompt with 413 and the text "Request too large ... on tokens per
 * minute (TPM): Limit 8000, Requested 10909". 413 is neither 429 nor 5xx, so the
 * AI SDK marks it non-retryable, so isPermanentAiCallFailure returned true, so
 * both qwen models were cooled for TWENTY-FOUR HOURS — for the offence of being
 * sent a prompt the platform had built too large. Every subsequent oversized
 * turn re-cooled them for another 24h, so the exclusion renewed itself
 * indefinitely and no amount of fixing the prompt could bring them back inside
 * the window. Two perfectly healthy models, locked out by our own bug.
 *
 * Detected by SHAPE, not by provider: a status code where one is published, and
 * the vendor-independent phrasings otherwise, because most providers report this
 * as a 400 or a 429 with the explanation only in the body.
 */
export function isRequestTooLargeFailure(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  // 413 Content Too Large is the only status that means this unambiguously.
  if (error.statusCode === 413) return true;
  const text = `${error.message} ${typeof error.responseBody === 'string' ? error.responseBody : ''}`;
  return /request too large|reduce your message size|maximum context length|context[_ ]length[_ ]exceeded|prompt is too long|too many (?:input )?tokens/i.test(
    text,
  );
}

/**
 * The token ceiling a provider NAMED while refusing an oversized request.
 *
 * Vendors state it outright — groq's "Limit 8000, Requested 10909" — and it is
 * the same number the rate-limit headers carry, from a provider that may not
 * have sent those headers. Learning it here means one refusal is enough to stop
 * the router ever sending that provider an over-budget request again, instead of
 * rediscovering the ceiling on every turn.
 *
 * Returns null unless the text genuinely names a limit; a guessed ceiling would
 * exclude a provider that never published one.
 */
export function parseNamedTokenLimit(error: unknown): number | null {
  if (!APICallError.isInstance(error)) return null;
  const text = `${error.message} ${typeof error.responseBody === 'string' ? error.responseBody : ''}`;
  const match = /\blimit[^0-9]{0,12}([0-9][0-9,_]{2,})/i.exec(text);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1].replace(/[,_]/g, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isAccountScopedAiCallFailure(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  return (
    error.statusCode === 401 || error.statusCode === 402 || error.statusCode === 403
  );
}

/**
 * Specifically a BILLING failure: the credential is valid and the model id
 * is real, the account simply cannot pay right now (402 Payment Required —
 * exhausted credits, a lapsed subscription, a free tier used up).
 *
 * Split out from isAccountScopedAiCallFailure because 402 is the one member
 * of that set that says something about the WHOLE PROVIDER with certainty
 * from a SINGLE observation: a 401/403 can plausibly be one malformed key or
 * one model the account lacks entitlement for, but "payment required" is a
 * property of the account, and every other model behind that same account
 * will answer identically. Escalating it needs no corroborating second
 * failure — which matters because the two-distinct-model threshold
 * (CONSECUTIVE_PROVIDER_FAILURE_THRESHOLD) is unreachable once cooldowns
 * have already reduced a provider to its last uncooled model, exactly the
 * state a billing outage produces. MEASURED LIVE 2026-08-15: mistral
 * returned 402 ("Check your subscription") on every routed attempt for
 * hours while five of its other models sat in cooldown, so no second model
 * could ever fail to trigger the escalation, and the router re-picked the
 * dead model on every single turn.
 */
export function isBillingAiCallFailure(error: unknown): boolean {
  return APICallError.isInstance(error) && error.statusCode === 402;
}

/**
 * The vendor's explanation, trimmed to something safe to put in a log line and a
 * message field. Empty string when the body says nothing useful, so the caller's
 * template degrades to exactly what it produced before rather than to " —".
 */
function summarizeErrorBody(body: string | undefined): string {
  if (typeof body !== 'string') return '';
  // Collapse whitespace so a pretty-printed JSON body does not become a
  // twenty-line log entry, then take the head.
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const MAX = 300;
  return `: ${flat.length > MAX ? `${flat.slice(0, MAX)}…` : flat}`;
}

/**
 * Build an APICallError with a real statusCode from a failed direct-transport
 * HTTP response, so isPermanentAiCallFailure/isAccountScopedAiCallFailure
 * (both of which only recognize APICallError instances) classify a dead Codex
 * or Code Assist credential exactly the same way they already classify a dead
 * AI-SDK one — one failure-shape contract for every caller of this function,
 * regardless of which transport actually served (or refused) the request.
 */
function oauthSurfaceApiCallError(
  url: string,
  requestBody: Record<string, unknown>,
  status: number,
  responseHeaders: Record<string, string>,
  responseBody: string,
): APICallError {
  return new APICallError({
    // THE VENDOR'S OWN REASON GOES IN THE MESSAGE, not just in responseBody.
    //
    // `responseBody` below has always carried it, and every consumer that
    // matters records `error.message` alone: the routing-decision log, the
    // per-model outcome store, the admin AI panel. So for eleven days a real,
    // fixable Google Code Assist failure was recorded platform-wide as the bare
    // string "400 response from subscription surface" — a status with no cause,
    // in the one place an operator would look. (It is now a 403; nobody could
    // tell, because neither number came with an explanation.)
    //
    // Truncated hard and redacted, because this string lands in logs and in an
    // admin UI: a vendor error body can be large and can echo request content
    // back. 300 chars is comfortably enough for the sentence that names the
    // cause and far short of anything worth streaming into a log line.
    message: `${status} response from subscription surface${summarizeErrorBody(responseBody)}`,
    url,
    requestBodyValues: requestBody,
    statusCode: status,
    responseHeaders,
    responseBody,
    // Same retryability convention the AI SDK itself applies: a server error
    // or rate limit can clear up on its own; anything else (400/401/403/404)
    // is a configuration problem no amount of waiting fixes.
    isRetryable: status >= 500 || status === 429,
  });
}

/**
 * Run one chat turn against a DIRECT-transport OAuth subscription (Codex,
 * Code Assist) — the non-standard surfaces ai-provider-http.ts already has a
 * complete, hand-rolled request/response pipeline for, since neither speaks
 * the standard API shape an AI-SDK provider factory expects. Returns the
 * exact same AiChatTurnResult shape the AI-SDK path returns, so callers never
 * know which transport actually served a given turn.
 */
async function dispatchOauthSurfaceChatTurn(
  input: AiChatTurnInput,
): Promise<AiChatTurnResult> {
  const tools: AiToolSpec[] = (input.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const built = buildAiChatRequest({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey ?? "",
    credentialSource: "oauth",
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxTokens: input.maxOutputTokens } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    // Reasoning effort must cross into the raw-HTTP oauth surface too — the SDK
    // path applies it via providerOptions, but this branch bypasses the SDK, so
    // without this the Codex subscription (the one live subscription) reasoned at
    // the backend default and paid the worst-case latency. See
    // responsesReasoningFragment in ai-provider-http.ts.
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  });

  const response = await fetch(built.url, {
    method: "POST",
    headers: built.headers,
    body: JSON.stringify(built.body),
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  const headers = Object.fromEntries(response.headers.entries());
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw oauthSurfaceApiCallError(built.url, built.body, response.status, headers, responseBody);
  }
  const data = await readAiChatResponseBody(built, response);

  const text = extractChatText(built.dialect, data);
  // No incremental delta channel on this transport (see AiChatTurnInput's own
  // doc comment) — one call with the complete text, not a per-token stream.
  if (text) input.onDelta?.(text);

  return {
    text,
    toolCalls: extractToolCalls(built.dialect, data),
    // Both direct-transport surfaces report usage on their terminal payload —
    // Codex on the `response.completed` event's `response.usage`, Code Assist
    // as `usageMetadata` inside its envelope. Parsed into the exact shape the
    // AI-SDK path produces, so recordAiCallTelemetry / attributeAiInvocation /
    // budget.observe work unchanged; fields the body doesn't carry stay
    // absent, not invented (see extractUsage's own doc comment).
    usage: extractUsage(built.dialect, data),
    headers,
    stopReason: extractStopReason(built.dialect, data),
    // What actually ran, and on which capacity tier — see the extractors' own doc comments. Both
    // are already in this body; not reading them is the only reason they were ever lost.
    ...((): { servedModel?: string } => {
      const servedModel = extractServedModel(built.dialect, data);
      return servedModel ? { servedModel } : {};
    })(),
    ...((): { serviceTier?: string } => {
      const serviceTier = extractServiceTier(built.dialect, data);
      return serviceTier ? { serviceTier } : {};
    })(),
    ...((() => {
      const costMicroUsd = extractProviderCostMicroUsd(input.provider, built.dialect, data);
      return costMicroUsd !== undefined ? { costMicroUsd } : {};
    })()),
  };
}

/**
 * Run one chat turn: streams text deltas through `onDelta` and returns the
 * turn's prose, its native tool calls, and the observed usage.
 *
 * Tools are declared WITHOUT an `execute`, deliberately: the caller owns the
 * agent loop (confirmation gating, per-tool auth, result threading), so the SDK
 * must report a tool call and stop rather than run it.
 */
export async function streamAiChatTurn(
  input: AiChatTurnInput,
): Promise<AiChatTurnResult> {
  // Credential-driven, not caller-driven: ANY caller (ClikAgent, ClikNet,
  // ClikEvents, admin test tools) that happens to resolve a direct-transport
  // OAuth credential gets routed correctly with no agent-specific branching
  // of its own. A harness-transport subscription never reaches here with
  // credentialSource 'oauth' in the first place — resolveEffectiveCredential
  // refuses to hand one out except in 'harness' mode, whose callers dispatch
  // it through their own separate runHarnessChat, never through this function.
  // NORMALIZE reasoning effort ONCE, here, for every dispatch path. When the
  // caller didn't pin an effort, fall back to the registry's per-model default
  // (modelReasoningEffort) — which is "low" for the reasoning models this
  // platform serves — so a reasoning turn runs at its intended, lowest-latency
  // effort UNIFORMLY: the raw-HTTP oauth/Codex surface (below) and the SDK path
  // (providerOptions.openai.reasoningEffort, further down) alike. Without this,
  // each caller had to remember to pass it, none did, and every reasoning turn
  // paid the backend's heavier default (MEASURED 2026-09-05: ~2.4x worst-case
  // latency on gpt-5.6-terra). A non-reasoning model yields undefined and the
  // parameter is simply never sent.
  const effort = input.reasoningEffort ?? modelReasoningEffort(input.provider, input.model);
  if (effort && effort !== input.reasoningEffort) {
    input = { ...input, reasoningEffort: effort };
  }

  if (input.credentialSource === "oauth" && subscriptionDispatchesDirect(getAiProvider(input.provider))) {
    return dispatchOauthSurfaceChatTurn(input);
  }

  const model = resolveLanguageModel({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  });

  const toolSet = Object.fromEntries(
    (input.tools ?? []).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(
          t.parameters as Parameters<typeof jsonSchema>[0],
        ),
      }),
    ]),
  );

  // An error that happens BEFORE any token streams (an immediate 401/402/404
  // from the provider — the common case for a dead credential or a
  // deprecated model id) never reaches the caller as itself: streamText logs
  // it to console internally and the stream instead settles into a generic
  // NoOutputGeneratedError with no statusCode at all once consumed below.
  // Without capturing the REAL error here, isPermanentAiCallFailure (which
  // needs the original APICallError.statusCode) always sees the generic
  // wrapper and returns false — meaning a permanently-dead model (a 404 that
  // will never resolve) only ever gets the 5-minute transient cooldown and
  // keeps getting re-tried by the router forever instead of the 24h backstop.
  // Observed live 2026-08-09: nvidia's deprecated model id 404'd on every
  // single routed attempt across hours of real traffic for exactly this
  // reason.
  // VERIFIED key for the reasoning option: @ai-sdk/openai's providerOptionsName
  // getter returns `config.provider.split(".")[0]`, which is `"openai"` for
  // every openai model instance (chat AND responses) — read from the installed
  // package (@ai-sdk/openai 4.0.27), not guessed. The accounting options key is
  // the ROW ID, because the OpenAI-compatible adapter is constructed with
  // `name: spec.id` and spreads `providerOptions[name]` into the request body.
  const turnProviderOptions: Record<string, Record<string, JSONValue>> = {};
  if (input.reasoningEffort) {
    turnProviderOptions.openai = { reasoningEffort: input.reasoningEffort };
  }
  const accountingOptions = getAiProvider(input.provider)?.usageAccountingOptions;
  if (accountingOptions) {
    turnProviderOptions[input.provider] = {
      ...(turnProviderOptions[input.provider] ?? {}),
      // The registry declares these as plain data; they are JSON literals by
      // construction (see `usageAccountingOptions`), and the SDK's option bag
      // is typed as JSON — the assertion states that contract at the one
      // boundary where a catalog value becomes a request body.
      ...(accountingOptions as Record<string, JSONValue>),
    };
  }

  // ── PROMPT CACHING ────────────────────────────────────────────────────────
  // Anthropic caches nothing without a breakpoint on the request, so this is
  // where the platform's cached tokens come from at all on that vendor. The
  // breakpoint rides the SYSTEM message because Anthropic caches everything up
  // to and INCLUDING the marked block, and its request order puts tools before
  // system — so one breakpoint here covers the whole stable region (every tool
  // schema plus the instructions), which is by far the largest repeated span in
  // an agent loop.
  //
  // Sent only when the caller opted in AND the row declares 'explicit'. An
  // 'automatic' provider has no parameter to receive this, and sending one
  // would be inventing an option that vendor does not have.
  const spec = getAiProvider(input.provider);
  const useExplicitCache =
    input.cachePrompt === true && spec?.promptCaching === "explicit";
  const systemMessage: Instructions | undefined = input.system
    ? useExplicitCache
      ? {
          role: "system",
          content: input.system,
          // 5m, not 1h: the default TTL is the one the platform pays for at
          // 1.25x, and the 1h tier costs more to write. An agent loop reuses
          // its prefix within seconds, so the longer window buys nothing here
          // and the pricing scrape reads the 5m column to match (see
          // ai-anthropic-pricing.ts).
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
        }
      : input.system
    : undefined;

  let capturedStreamError: unknown;
  const result = streamText({
    model,
    ...(systemMessage ? { system: systemMessage } : {}),
    messages: input.messages,
    ...(Object.keys(toolSet).length > 0 ? { tools: toolSet } : {}),
    ...(Object.keys(toolSet).length > 0 && input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.maxOutputTokens !== undefined
      ? { maxOutputTokens: input.maxOutputTokens }
      : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    // VERIFIED key: @ai-sdk/openai's providerOptionsName getter returns `config.provider.split(".")[0]`,
    // which is `"openai"` for every openai model instance (chat AND responses) — read from the
    // installed package (@ai-sdk/openai 4.0.27), not guessed.
    // Provider options are assembled ONCE from every row-declared source, not
    // as competing conditional spreads: a second `providerOptions` key in this
    // object literal would silently overwrite the first, which is exactly how
    // a reasoning-effort turn would have dropped the cost-accounting opt-in.
    ...(Object.keys(turnProviderOptions).length > 0
      ? { providerOptions: turnProviderOptions }
      : {}),
    onError: (event) => {
      capturedStreamError = event.error;
    },
  });

  // Consuming textStream is what drives the stream to completion. Even with no
  // onDelta the loop must run, or the promises below never settle.
  let text = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      input.onDelta?.(delta);
    }
  } catch (error) {
    // Same substitution as below — an error can surface here instead of at
    // the Promise.all, depending on exactly when the provider failed.
    throw capturedStreamError ?? error;
  }

  let calls, usage, response, finishReason, providerMetadata, warnings, steps;
  try {
    [calls, usage, response, finishReason, providerMetadata, warnings, steps] =
      await Promise.all([
        result.toolCalls,
        result.totalUsage,
        result.response,
        result.finishReason,
        result.providerMetadata,
        result.warnings,
        result.steps,
      ]);
  } catch (error) {
    // Re-throw the ORIGINAL provider error (with its real statusCode) when
    // one was captured, instead of the generic wrapper the SDK settled the
    // stream into — this is what makes isPermanentAiCallFailure's
    // classification correct for the immediate-failure case above.
    throw capturedStreamError ?? error;
  }

  // TWO ROUTES TO THE VENDOR'S OWN FIGURE, in the order of how directly each
  // is parsed. A first-party package that already decoded cost into provider
  // metadata is the most trustworthy reading; the declared raw-usage path is
  // the general fallback for the ~40 rows served by the compatible adapter,
  // which decodes nothing vendor-specific on its own. Both are EXACT amounts
  // the vendor charged, so either beats the catalog estimate — and when
  // neither resolves this stays undefined and the estimate stands.
  const costMicroUsd =
    extractPerplexityCostMicroUsd(
      input.provider,
      providerMetadata as Record<string, unknown> | undefined,
    ) ??
    extractDeclaredResponseCostMicroUsd(
      input.provider,
      providerMetadata as Record<string, unknown> | undefined,
    ) ??
    extractDeclaredUsageCostMicroUsd(input.provider, steps ?? []);

  return {
    text,
    toolCalls: calls.map((call) => ({
      name: String(call.toolName),
      args:
        call.input && typeof call.input === "object"
          ? (call.input as Record<string, unknown>)
          : {},
    })),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      uncachedInputTokens: usage.inputTokenDetails?.noCacheTokens,
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteInputTokens: usage.inputTokenDetails?.cacheWriteTokens,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    },
    ...(response.headers ? { headers: response.headers } : {}),
    stopReason: finishReason,
    // WHAT ACTUALLY RAN. The SDK already decodes this into `response.modelId` for every provider it
    // dispatches — it was simply never read. Worth the most on a routing gateway, where the served
    // model is chosen per-request and the requested id says nothing about what was billed, but an
    // alias resolving to a dated snapshot makes it useful on ordinary rows too. Empty string is
    // treated as absent: a blank is the SDK having nothing to report, not a model named "".
    ...(response.modelId ? { servedModel: response.modelId } : {}),
    // `response.body` is populated for HTTP-dispatched providers only, so this reads through the
    // SAME normalized extractor as the raw-fetch lane instead of a second, drifting copy. Absent on
    // transports that expose no body — correct, not missing.
    ...((): { serviceTier?: string } => {
      const serviceTier = extractServiceTier(
        getAiProvider(input.provider)?.chatDialect ?? "openai-chat",
        response.body,
      );
      return serviceTier ? { serviceTier } : {};
    })(),
    ...(costMicroUsd !== undefined ? { costMicroUsd } : {}),
    ...(warnings && warnings.length > 0
      ? {
          warnings: warnings.map((w) => ({
            type: w.type,
            ...("feature" in w && typeof w.feature === "string" ? { feature: w.feature } : {}),
            ...("details" in w && typeof w.details === "string" ? { details: w.details } : {}),
          })),
        }
      : {}),
  };
}
