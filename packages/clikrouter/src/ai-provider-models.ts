/**
 * ONE WIRE LAYER FOR EVERY API-KEY PROVIDER — a registry row in, an AI SDK language model out.
 *
 * ClikCode's direct route (an `api-key` account on a provider that is a model API) streams its
 * turns through `streamAiChatTurn` below. The SDK owns every dialect, header and tool-call
 * translation, so a new provider costs a registry row and (at most) one line in the table below.
 *
 * API-KEY CREDENTIALS ONLY. A subscription is spent through the vendor's own CLI harness, never
 * here: those tokens are not valid on the metered endpoints.
 *
 * ── WHY A TABLE AND NOT A SWITCH ───────────────────────────────────────────────────────────────
 * A provider's factory is an IMPORT, and imports cannot be expressed as catalog data. So the table
 * is the one unavoidable code-side fact: one line per provider, no conditionals, no behaviour. Every
 * other decision — base URL, default model, dialect — stays in the registry row. A provider ABSENT
 * from the table is not an error: it falls through to the OpenAI-compatible adapter using its own
 * `chatBaseUrl`, which is how most of the registry's rows work.
 */

import type { LanguageModel } from "ai";
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
import { getAiProvider, type AiProviderSpec } from "./ai-provider-registry-public";

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
  //     body) · {host}/v1/chat/completions 405-on-GET.
  //
  //   google  @ai-sdk/google builds {base}/models/{id}:streamGenerateContent,
  //     the NATIVE Gemini dialect, against the row's OpenAI-compat shim base.
  //     .../v1beta/openai/models/gemini-2.5-flash:streamGenerateContent 404 ·
  //     .../v1beta/openai/chat/completions 400 "model is not specified".
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

/**
 * The base URL for a row: an explicit env override (`baseUrlEnvKey`) wins over the row's own
 * default — a self-hosted or proxied endpoint is a deployment fact, not a catalog fact.
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
  const base = fromEnv || spec.chatBaseUrl || undefined;
  const segment = spec.urlParamEnvKey ? String(env[spec.urlParamEnvKey] || "").trim() : "";
  return base && segment ? base.replace("{urlParam}", segment) : base;
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
 * most natural-looking call would have silently sent every turn through a third party we do not
 * own. Taking the two fields
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

// ── One streamed, tool-calling chat turn ────────────────────────────────────

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
   *  ResolveModelInput.baseUrl. */
  baseUrl?: string;
  system?: string;
  /**
   * Ask the provider to CACHE this prompt's stable prefix. Only meaningful on a
   * provider whose row declares `promptCaching: 'explicit'` (Anthropic caches
   * nothing without a breakpoint). OPT-IN: an explicit cache write costs about
   * 1.25x the input rate, so it pays only when the prefix is reused.
   */
  cachePrompt?: boolean;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: AiChatTool[];
  /** Forces a call to one of `tools` rather than a prose answer. Only
   *  meaningful alongside `tools`. */
  toolChoice?: "required";
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Called with each text delta as it arrives. Absent = buffer, no streaming. */
  onDelta?: (text: string) => void;
  /**
   * The session's reasoning effort, in ClikCode's words (`low`, `high`, `max`…).
   * Absent = the provider's own default: nothing is sent. See `reasoningFor`.
   */
  reasoningEffort?: string;
}

export interface AiChatTurnWarning {
  type: string;
  feature?: string;
  details?: string;
}

export interface AiChatTurnResult {
  /** The model's prose for this turn (may be empty on a pure tool-calling turn). */
  text: string;
  /** The AI SDK's own structured warnings for this call — some dispatch paths
   *  silently DROP an unsupported parameter (tools, reasoning) and warn rather
   *  than throw. */
  warnings?: AiChatTurnWarning[];
  /** Native tool calls the model made, `args` already decoded. */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * Observed token usage. `inputTokens` is the TOTAL, normalized by the SDK
   * across vendors whose wire formats disagree, and
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
    /** Cache-READ input tokens. */
    cachedInputTokens?: number;
    /** Cache-WRITE input tokens. */
    cacheWriteInputTokens?: number;
    /** Reasoning tokens, already INCLUDED in `outputTokens`. */
    reasoningTokens?: number;
  };
  /** Provider response headers, when the transport exposes them (rate limits). */
  headers?: Record<string, string>;
  /** Unified finish reason for the turn (e.g. 'stop', 'length', 'tool-calls'). */
  stopReason?: string;
  /** The model the vendor says served this turn, verbatim; undefined when it named none. */
  servedModel?: string;
  /** Vendor-reported EXACT micro-USD cost for this call, when the provider reports one. */
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

// ── Reasoning effort ────────────────────────────────────────────────────────

/** The AI SDK's standard `reasoning` levels. */
type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
const REASONING_LEVELS: ReadonlySet<string> = new Set<ReasoningLevel>(["none", "minimal", "low", "medium", "high", "xhigh"]);

/** Provider/model pairs that refused a reasoning level in this process. */
const refusesReasoning = new Set<string>();
const modelKey = (provider: string, model: string): string => `${provider}\u0000${model}`;

/**
 * What to send for a session's effort: the SDK's standard `reasoning` option,
 * which each provider package maps to its OWN parameter — Anthropic's thinking
 * budget or effort, OpenAI's `reasoning_effort`, xAI's and Groq's — and which
 * the packages that know a model does not reason drop on their own, with a
 * warning. This used to set `providerOptions.openai` whatever the provider, and
 * filled an unset effort with "low" (a ClikDeploy latency choice); an unset
 * effort now sends nothing and the provider's default stands. A level the
 * standard set lacks is not guessed at, except `max`, sent as the highest.
 */
function reasoningFor(provider: string, model: string, effort: string | undefined): ReasoningLevel | undefined {
  if (!effort || refusesReasoning.has(modelKey(provider, model))) return undefined;
  const level = effort.trim().toLowerCase();
  if (level === "max") return "xhigh";
  return REASONING_LEVELS.has(level) ? (level as ReasoningLevel) : undefined;
}

/** A 400 that names the reasoning parameter: this model does not take it (an
 *  OpenAI-compatible endpoint, or a model its package cannot tell apart). */
function reasoningRejected(error: unknown): boolean {
  if (!APICallError.isInstance(error) || error.statusCode !== 400) return false;
  return /reason|think|effort/i.test(`${error.message} ${error.responseBody ?? ""}`);
}

/**
 * Run one chat turn: streams text deltas through `onDelta` and returns the
 * turn's prose, its native tool calls, and the observed usage.
 *
 * Tools are declared WITHOUT an `execute`, deliberately: the caller owns the
 * agent loop (confirmation gating, per-tool auth, result threading), so the SDK
 * must report a tool call and stop rather than run it.
 *
 * A model that rejects the reasoning level before anything streamed is asked
 * again without it, and is not sent one again in this process.
 */
export async function streamAiChatTurn(
  input: AiChatTurnInput,
): Promise<AiChatTurnResult> {
  const reasoning = reasoningFor(input.provider, input.model, input.reasoningEffort);
  const streamed = { any: false };
  try {
    return await runChatTurn(input, reasoning, streamed);
  } catch (error) {
    if (!reasoning || streamed.any || !reasoningRejected(error)) throw error;
    refusesReasoning.add(modelKey(input.provider, input.model));
    return runChatTurn(input, undefined, streamed);
  }
}

async function runChatTurn(
  input: AiChatTurnInput,
  reasoning: ReasoningLevel | undefined,
  streamed: { any: boolean },
): Promise<AiChatTurnResult> {
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

  // The accounting options key is the ROW ID: the OpenAI-compatible adapter is
  // constructed with `name: spec.id` and spreads `providerOptions[name]` into
  // the request body.
  const spec = getAiProvider(input.provider);
  const turnProviderOptions: Record<string, Record<string, JSONValue>> = {};
  if (spec?.usageAccountingOptions) {
    // Declared as plain data, so JSON literals by construction.
    turnProviderOptions[input.provider] = spec.usageAccountingOptions as Record<string, JSONValue>;
  }

  // ── PROMPT CACHING ────────────────────────────────────────────────────────
  // Anthropic caches nothing without a breakpoint on the request. It rides the
  // SYSTEM message because Anthropic caches everything up to and INCLUDING the
  // marked block and puts tools before system, so one breakpoint covers every
  // tool schema plus the instructions. Sent only when the caller opted in AND
  // the row declares 'explicit'.
  const useExplicitCache =
    input.cachePrompt === true && spec?.promptCaching === "explicit";
  const systemMessage: Instructions | undefined = input.system
    ? useExplicitCache
      ? {
          role: "system",
          content: input.system,
          // 5m, not 1h: an agent loop reuses its prefix within seconds, and the
          // 1h tier costs more to write.
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
        }
      : input.system
    : undefined;

  // An error BEFORE any token streams (an immediate 400/401/404) never reaches
  // the caller as itself: streamText settles into a generic
  // NoOutputGeneratedError with no statusCode. The real one is captured here
  // and rethrown, so callers can classify it.
  let capturedStreamError: unknown;
  const result = streamText({
    model,
    ...(systemMessage ? { system: systemMessage } : {}),
    messages: input.messages,
    ...(Object.keys(toolSet).length > 0 ? { tools: toolSet } : {}),
    ...(Object.keys(toolSet).length > 0 && input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(Object.keys(turnProviderOptions).length > 0 ? { providerOptions: turnProviderOptions } : {}),
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
      streamed.any = true;
      input.onDelta?.(delta);
    }
  } catch (error) {
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
    throw capturedStreamError ?? error;
  }

  // The vendor's own figure, most directly parsed first: a first-party package
  // that decoded cost into provider metadata, then the compatible adapter's
  // captured response field, then the declared raw-usage path.
  const costMicroUsd =
    extractPerplexityCostMicroUsd(input.provider, providerMetadata as Record<string, unknown> | undefined) ??
    extractDeclaredResponseCostMicroUsd(input.provider, providerMetadata as Record<string, unknown> | undefined) ??
    extractDeclaredUsageCostMicroUsd(input.provider, steps ?? []);

  return {
    text,
    toolCalls: calls.map((call) => ({
      name: String(call.toolName),
      args: call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {},
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
    ...(response.modelId ? { servedModel: response.modelId } : {}),
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
