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
 * stays where it belongs, in the registry row. A provider ABSENT from this table is not an error: it
 * falls through to the OpenAI-compatible adapter using its own `chatBaseUrl`, which is how ~15 of the
 * rows already work (only 4 of 30 ever declared a dialect, and 3 of those restated the default).
 */

import type {
  EmbeddingModel,
  ImageModel,
  LanguageModel,
  SpeechModel,
  TranscriptionModel,
} from "ai";
import { APICallError, jsonSchema, streamText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createXai } from "@ai-sdk/xai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createFireworks } from "@ai-sdk/fireworks";
import { createCerebras } from "@ai-sdk/cerebras";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createBaseten } from "@ai-sdk/baseten";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// Audio, visual and embedding packages. Same rule as above: an import cannot be catalog data, so the
// tables further down are the one code-side fact and everything else stays in the registry row.
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
  providerModalities,
  subscriptionDispatchesDirect,
  type AiModality,
  type AiProviderSpec,
} from "./ai-provider-registry";
import {
  buildAiChatRequest,
  readAiChatResponseBody,
  extractChatText,
  extractToolCalls,
  extractStopReason,
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
  google: (o) => createGoogleGenerativeAI(o),
  "google-vertex": (o) => createVertex(o),
  "microsoft-foundry": (o) => createAzure(o),
  "aws-bedrock": (o) => createAmazonBedrock({ ...o, apiKey: o.apiKey ?? "" }),
  xai: (o) => createXai(o),
  mistral: (o) => createMistral(o),
  groq: (o) => createGroq(o),
  cohere: (o) => createCohere(o),
  deepseek: (o) => createDeepSeek(o),
  deepinfra: (o) => createDeepInfra(o),
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
): string | undefined {
  const fromEnv = spec.baseUrlEnvKey
    ? String(env[spec.baseUrlEnvKey] || "").trim()
    : "";
  return fromEnv || spec.chatBaseUrl || undefined;
}

export interface ResolveModelInput {
  provider: string;
  model: string;
  apiKey?: string;
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
  const baseURL = resolveBaseUrl(spec, env);
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
  return createOpenAICompatible({
    name: spec.id,
    apiKey: input.apiKey,
    baseURL,
  })(modelId);
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
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: AiChatTool[];
  /**
   * Forces the model to actually invoke one of `tools` rather than legally
   * answering in prose instead — the AI SDK translates this uniformly across
   * every AI-SDK-dispatched provider (OpenAI, Anthropic, Google, xAI,
   * Mistral, Groq, and the generic OpenAI-compatible adapter used for
   * DeepInfra/Novita/HuggingFace/OpenRouter). A model that genuinely cannot
   * comply throws a classifiable APICallError instead of silently declining
   * — see model-call.ts and ai-model-health-probe.ts for why this replaces
   * regex-detecting a refusal after the fact. Only meaningful alongside
   * `tools`; ignored when `tools` is absent.
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
  /** Observed token usage. `inputTokens` is what a context budget calibrates on. */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  /** Provider response headers, when the transport exposes them (rate limits). */
  headers?: Record<string, string>;
  /** Unified finish reason for the turn (e.g. 'stop', 'length', 'tool-calls'), when the SDK resolves one. */
  stopReason?: string;
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
 * Whether a failed `streamAiChatTurn` call is a PERMANENT configuration
 * problem (a deprecated/renamed model id, an invalid credential, an
 * unauthorized scope — 401/403/404, or the SDK's own `isRetryable: false`
 * verdict) versus a TRANSIENT one (rate-limited, momentarily unavailable,
 * a plain network hiccup). Callers use this to decide how long a routing
 * cooldown should last: retrying a 404 five minutes later is pure waste —
 * nothing about elapsed time makes a renamed model id valid again — while a
 * 429 or 503 genuinely can clear up on its own shortly. An AbortError (our
 * own ROUTED_MODEL_TIMEOUT_MS firing) is neither — a slow response under
 * load is not evidence the model itself is broken, so callers should
 * exclude aborts from calling this at all.
 */
export function isPermanentAiCallFailure(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (
    error.statusCode === 401 ||
    error.statusCode === 403 ||
    error.statusCode === 404
  )
    return true;
  return error.isRetryable === false;
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
export function isAccountScopedAiCallFailure(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  return (
    error.statusCode === 401 || error.statusCode === 402 || error.statusCode === 403
  );
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
    message: `${status} response from subscription surface`,
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
    // No verified usage field for either dialect's response shape yet (see
    // this module's own "never guess" convention) — absent, not invented.
    usage: {},
    headers,
    stopReason: extractStopReason(built.dialect, data),
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
  if (input.credentialSource === "oauth" && subscriptionDispatchesDirect(getAiProvider(input.provider))) {
    return dispatchOauthSurfaceChatTurn(input);
  }

  const model = resolveLanguageModel({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
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
  let capturedStreamError: unknown;
  const result = streamText({
    model,
    ...(input.system ? { system: input.system } : {}),
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
    ...(input.reasoningEffort
      ? {
          providerOptions: {
            openai: { reasoningEffort: input.reasoningEffort },
          },
        }
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

  let calls, usage, response, finishReason, providerMetadata, warnings;
  try {
    [calls, usage, response, finishReason, providerMetadata, warnings] =
      await Promise.all([
        result.toolCalls,
        result.totalUsage,
        result.response,
        result.finishReason,
        result.providerMetadata,
        result.warnings,
      ]);
  } catch (error) {
    // Re-throw the ORIGINAL provider error (with its real statusCode) when
    // one was captured, instead of the generic wrapper the SDK settled the
    // stream into — this is what makes isPermanentAiCallFailure's
    // classification correct for the immediate-failure case above.
    throw capturedStreamError ?? error;
  }

  const costMicroUsd = extractPerplexityCostMicroUsd(
    input.provider,
    providerMetadata as Record<string, unknown> | undefined,
  );

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
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    },
    ...(response.headers ? { headers: response.headers } : {}),
    stopReason: finishReason,
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
