// ============================================
// AI PROVIDER REGISTRY — types & constants (pure data — client-safe)
// ============================================

/** How a provider's credential is health-probed (cheapest authenticated
 *  metadata call, no token spend). */
/**
 * What a provider can do. Kept separate from the console's grouping so there is ONE declared fact
 * per provider: `providerCategory` derives the section header from these, rather than a second field
 * that could disagree with the first.
 */
export type AiModality =
  | "text" // chat / completion — the only modality any agent lane routes to
  | "embedding"
  | "image"
  | "video"
  | "speech" // text-to-speech
  | "transcription"; // speech-to-text

/** The console's section headers: Text, Audio, Image & Video. */
export type AiProviderCategory = "text" | "audio" | "visual";

export const AI_PROVIDER_CATEGORY_LABEL: Readonly<
  Record<AiProviderCategory, string>
> = {
  text: "Text",
  audio: "Audio",
  visual: "Image & Video",
};

/** Header order in the console — text first, because that is what routing uses. */
export const AI_PROVIDER_CATEGORY_ORDER: readonly AiProviderCategory[] = [
  "text",
  "audio",
  "visual",
];

export type AiProbeKind =
  | "openai-models" // GET url with `Authorization: Bearer` (OpenAI-style /models)
  | "openai-codex-models" // ChatGPT subscription catalog at /backend-api/codex/models
  | "anthropic-models" // GET url with x-api-key (or Bearer for OAuth) + anthropic-version
  | "google-code-assist" // Google Gemini CLI OAuth account/tier probe
  | "cloudflare-models" // Cloudflare account-scoped Workers AI model search
  | "google-tokeninfo" // OAuth access-token introspection; 400 = dead credential
  | "openrouter-key" // GET /key with Bearer (OpenRouter's /models is unauthenticated)
  | "unsupported"; // no probe adapter

/**
 * Which credential layer won resolution. Declared here (pure data) rather than
 * in the probe module, so the registry can key tables by it.
 */
/**
 * Vendor CLI client versions the probe endpoints pin.
 *
 * Declared ONCE each. These were literal strings repeated three times
 * (`?client_version=0.144.1`, `User-Agent: codex-tui/0.144.1`,
 * `version: 0.144.1`) inside a switch case in the probe module, where bumping
 * the pin meant finding all of them.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.144.1";
export const GEMINI_CLI_CLIENT_VERSION = "0.1";

export type AiCredentialSource = "oauth" | "platform-secret" | "env";

/**
 * The axis a probe actually varies on.
 *
 * `platform-secret` and `env` are the same wire fact — an API key — differing
 * only in where it was stored. Keying probe overrides by the three-valued source
 * would force every override to be written twice and let the two copies
 * disagree.
 */
export type AiCredentialKind = "oauth" | "api-key";

export function aiCredentialKind(source: AiCredentialSource): AiCredentialKind {
  return source === "oauth" ? "oauth" : "api-key";
}

/** One probe endpoint. Every field overrides the provider's default probe. */
export interface AiProbeEndpoint {
  kind?: AiProbeKind;
  url?: string;
  /**
   * STATIC headers only — vendor client identification, pinned versions.
   * Authorization/account headers are built from the live credential by the
   * probe module and are deliberately not expressible here.
   */
  headers?: Readonly<Record<string, string>>;
  /** Static query params appended to `url` (e.g. a pinned `client_version`). */
  query?: Readonly<Record<string, string>>;
  /** Extra HTTP statuses that mean "bad credential" for THIS endpoint. */
  authFailedStatuses?: readonly number[];
}

/**
 * How a provider's credential is health-probed.
 *
 * THE SECOND DIMENSION. A probe is `f(provider, credentialKind)`, but this
 * registry keyed on the provider alone — so the credential axis leaked into
 * `if`s in ai-credential-health.ts: two nested ternaries reassigning `kind`,
 * two `else if` blocks reassigning `url` to hardcoded vendor endpoints, and
 * pinned client-version strings (`codex-tui/0.144.1`, `GeminiCLI/0.1`) written
 * inline in a `switch`. Every one of those was keyed on the provider's NAME
 * (`provider === "openai" && cred.credentialSource === "oauth"`), i.e. exactly
 * the shape this registry exists to remove.
 *
 * `bySource` states it instead: the base fields are the default, and a
 * credential kind that behaves differently declares how.
 */
export interface AiProbeSpec extends AiProbeEndpoint {
  kind: AiProbeKind;
  /** Unauthenticated models-list call, when `url` does not itself return one. */
  catalogUrl?: string;
  /** Non-standard top-level array field returned by the models endpoint. */
  modelsArrayField?: "data" | "models" | "result" | "items";
  /** Per-credential-kind overrides, merged over the fields above. */
  bySource?: Partial<Record<AiCredentialKind, AiProbeEndpoint>>;
}

export interface AiProviderSpec {
  /** Canonical provider id (matches PlatformAiConnection.provider et al). */
  id: string;
  /** Human-readable display label. */
  label: string;
  /** Env var (and PlatformSecret key) holding the API key. Absent = no
   *  platform API-key convention (OAuth-only, e.g. google). */
  envKey?: string;
  /** OpenAI-compatible chat-completions base URL (no trailing slash; append
   *  /chat/completions). Absent when the provider is not used for chat here. */
  chatBaseUrl?: string;
  /**
   * Where this provider's OAuth access token carries an ACCOUNT ID that its
   * subscription APIs require alongside the bearer token.
   *
   * Declared because the alternative was `p === "openai" ? { accountId: … } : {}`
   * written at every point a credential is resolved (it was written twice, in
   * two credential-resolution paths that must agree — a third path added later
   * would simply have omitted it, producing an OAuth credential that
   * authenticates and then 4xxs on every subscription call).
   *
   * The token is a JWT; `namespace` is the claim key and `field` the property
   * inside it. Absent = this provider's tokens carry no account id.
   */
  oauthAccountIdClaim?: { namespace: string; field: string };
  /**
   * Access class for a non-subscription (API-key) credential, when it is not
   * simply metered.
   *
   * Declared because routing had `provider === "huggingface"` hardcoded in its
   * candidate scorer: Hugging Face's Inference API has a genuine free tier, so
   * its API-key candidates should not be priced like a metered vendor's. That is
   * a fact about the vendor's pricing model, not about the routing algorithm.
   */
  apiKeyAccessClass?: "free-tier";
  /** Credential health probe. `url` is required for every kind except
   *  'unsupported'. For 'google-tokeninfo' the token is appended as the
   *  `access_token` query param by the probe module. `catalogUrl` is an
   *  optional SEPARATE unauthenticated models-list call for providers whose
   *  cheapest authenticated probe (`url`) doesn't itself return a model list
   *  (e.g. Hugging Face's whoami vs OpenRouter's /key) — fetched once after a
   *  successful probe, same pattern for both providers.
   *
   *  `bySource` is the SECOND DIMENSION. See {@link AiProbeSpec}. */
  probe: AiProbeSpec;
  /** What this provider can actually DO. Omitted means `["text"]`, which is what
   *  every row predating audio/visual support is, so the field stays absent on
   *  the ~30 text rows instead of restating the default 30 times.
   *
   *  ROUTING READS THIS. Remediation and every other agent lane select only
   *  rows carrying "text": a transcription endpoint cannot answer a chat
   *  completion, and offering one in a model picker would produce a selectable
   *  model that fails at request time. The admin console GROUPS by it (see
   *  `providerCategory`), so one declaration serves both. */
  modalities?: readonly AiModality[];
  /** True when the platform supports an OAuth connection for this provider —
   *  a token-backed CONNECTION with refresh/disconnect (PlatformAiConnection). */
  oauth?: boolean;
  /** OAuth tokens can be sent directly to the provider's bare completion API. */
  oauthBareCompletion?: boolean;
  /** Vendor documentation pricing table merged into discovered models. */
  docsPricingCatalog?:
    | "cloudflare"
    | "fireworks"
    | "voyage"
    | "deepseek"
    | "groq"
    | "zai"
    | "anthropic"
    | "openai"
    | "google"
    | "mistral"
    | "alibaba";
  /** Vendor catalog that prices non-token units such as images or seconds. */
  unitPricingCatalog?: "fal";
  /** Cloud catalog lookup used when a model listing carries no price. */
  cloudPricingLookup?: "aws-bedrock" | "azure-foundry";
  /** Provider metadata key containing an SDK-reported total request cost. */
  sdkCostMetadataKey?: string;
  /**
   * A button-driven flow that MINTS this provider's API key.
   *
   * Distinct from `oauth`: the result is a plain key written to `envKey`, with
   * no connection row, no refresh and nothing to disconnect — so a provider can
   * have a real consent flow while `oauth` is correctly false (OpenRouter's
   * PKCE flow mints a key and hands back nothing else).
   *
   * Carried as CATALOG DATA because the alternative was a provider-name branch
   * in the admin UI (`provider === 'openrouter' && <Button>`), which put an
   * app-specific conditional in platform code and left the capability
   * undeclared anywhere a second provider could find it.
   */
  keyMint?: {
    /** Admin-facing button label. */
    label: string;
    /** POST endpoint that starts the flow; responds { authorizationUrl }. */
    startEndpoint: string;
  };
  /**
   * API key is NOT edited on the AI tab (no Set / Replace / Delete / keyMint).
   * Status still goes green when `envKey` is configured elsewhere (e.g.
   * Platform secrets → Connect Cloudflare writes CLOUDFLARE_OAUTH_TOKEN). Models,
   * health, and usage still render on the AI row.
   */
  credentialManagedElsewhere?: {
    /** Short note shown where Set would be, e.g. Integrations ownership. */
    note: string;
  };
  /** True when the provider speaks the OpenAI chat-completions dialect. */
  openAiCompatible?: boolean;
  /**
   * Send the output cap as `max_completion_tokens` rather than `max_tokens`.
   *
   * OpenAI renamed this parameter and its newer models REJECT the old name outright. MEASURED:
   * `gpt-5.6-luna` returned HTTP 400 `"Unsupported parameter: 'max_tokens' is not supported with
   * this model. Use 'max_completion_tokens' instead."`, which failed every remediation call that
   * reached the model. Carried as CATALOG DATA rather than a provider-name branch in the request
   * builder, because the OpenAI-compatible ecosystem is split: proxies and self-hosted servers
   * (OpenRouter, Groq, llama.cpp, …) still expect `max_tokens` and would reject the new name, so
   * this is per-provider truth, not a global migration.
   */
  usesMaxCompletionTokens?: boolean;
  /**
   * Path of the provider's Responses-style surface, relative to `chatBaseUrl`.
   *
   * Used ONLY when the caller supplies tools, because `/chat/completions` cannot combine function
   * tools with reasoning on newer models. MEASURED on `gpt-5.6-luna`: HTTP 400 `"Function tools
   * with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use
   * function tools, use /v1/responses or set reasoning_effort to 'none'."` The alternative the
   * error offers — forcing `reasoning_effort: 'none'` — silently downgrades the model to buy
   * compatibility, so we move to the surface that supports both instead.
   *
   * Non-tool calls deliberately stay on `/chat/completions`: that path is streaming-shaped and
   * exercised by the interactive assistant, and switching it wholesale would change a response
   * format that already works.
   */
  responsesPath?: string;
  /**
   * How the assistant / platform callers should shape chat requests:
   *   openai-chat        — POST {chatBaseUrl}/chat/completions (default when openAiCompatible)
   *   anthropic-messages — POST https://api.anthropic.com/v1/messages (Claude)
   */
  chatDialect?: "openai-chat" | "anthropic-messages";
  /** Override /chat/completions when the compatible provider uses a named route. */
  chatPath?: string;
  /**
   * Auth header strategy for chat + health probes:
   *   bearer     — Authorization: Bearer <token> (default)
   *   x-api-key  — x-api-key: <token> (+ anthropic-version when dialect is anthropic)
   *   auto       — API key → x-api-key for anthropic, Bearer elsewhere; OAuth oat tokens → x-api-key on anthropic
   *   xi-api-key — xi-api-key: <token> (ElevenLabs' vendor-named header; it rejects Bearer)
   */
  authHeader?: "bearer" | "api-key" | "x-api-key" | "xi-api-key" | "auto";
  /** The provider's current flagship/fast model — the model the platform
   *  defaults to when this provider is the first configured one and no admin
   *  override exists (see ai-default-llm.ts). Unset for aggregators
   *  (openrouter/together/fireworks/ollama) where any single choice is
   *  arbitrary; those fall back to the cached discovered model list. */
  defaultModel?: string;
  /** The provider console page where an API key is created — surfaced as an
   *  "open vendor console" link on the admin key row so the paste is two
   *  clicks. Absent when the provider has no key console (OAuth-only). */
  keyUrl?: string;
  /** Env var holding a second identifier some providers bake into the URL
   *  itself rather than an auth header (e.g. Cloudflare's account id). When
   *  set, chatBaseUrl and probe.url contain the literal placeholder
   *  '{accountId}', substituted server-side by resolveProviderUrl() in
   *  ai-provider-http.ts — never resolved here (pure data, no env access). */
  urlParamEnvKey?: string;
  /** For a configurable OpenAI-compatible endpoint, read the entire API base
   *  URL from this PlatformSecret/env key. This is intentionally distinct
   *  from urlParamEnvKey, which substitutes one account identifier. */
  baseUrlEnvKey?: string;
  /** Local/private OpenAI-compatible endpoints may not require a bearer key. */
  credentialOptional?: boolean;
  /** Official fixed model set when this API surface has no model-list route. */
  staticModels?: readonly string[];
  /**
   * The provider's usual TOTAL token window (prompt + completion), and the most
   * output tokens one request may ask for.
   *
   * CARRIED AS DATA because the alternative is what the platform used to do:
   * one CHARACTER cap, identical for an 8k model and a 1M model, and the only
   * way to discover it was wrong was a provider 400 whose BODY had to be
   * regex-matched for the words "context"/"too long" to tell our own oversized
   * prompt apart from a provider outage. A number known before the request is
   * strictly better than a string parsed after the failure.
   *
   * This is the FLOOR. `modelWindows` carries per-model truth wherever the
   * vendor publishes it and the difference matters; a provider with neither
   * falls back to DEFAULT_CONTEXT_WINDOW. Under-estimating costs prompt room,
   * over-estimating costs a failed request, so the floor leans small — but a
   * floor is only honest as a floor. Where the real number is known it belongs
   * in `modelWindows`, because the cost of a stale floor is invisible: nothing
   * reports "your prompt was 800K tokens smaller than this model allowed".
   *
   * WHY MOST ROWS STILL CARRY ONLY A FLOOR — this is a limit, not an oversight.
   * `modelWindows` is a static prefix table, so it can only state truth for a
   * provider that publishes a FIXED model set. That is true of the first-party
   * vendors (anthropic, openai, xai, google) and those are populated. It is
   * NOT true of the aggregators and inference marketplaces — openrouter,
   * huggingface, together, fireworks, deepinfra, baseten, nebius, hyperbolic,
   * novita, sambanova — whose offered set is thousands of third-party models
   * that change without notice. Writing prefixes for those would be inventing
   * per-model facts about models we do not control, i.e. exactly the guessing
   * this field replaced. Their real per-model window is already in the catalog
   * response each one serves (OpenRouter's `context_length`, HF's
   * `max_position_embeddings`), which is where a correct fix reads it from —
   * a runtime lookup, not more rows here. Until that exists they keep the
   * floor, deliberately.
   */
  contextWindow?: number;
  /** Cap on a single request's output tokens. Absent = the caller's own ceiling. */
  maxOutput?: number;
  /**
   * Per-model overrides, matched by longest PREFIX of the model id — model
   * families share a window and vendors append dates/sizes to the id.
   *
   * `reasoningEffort` is the DEFAULT sent to a reasoning-capable model when nothing more specific
   * overrides it (see `modelReasoningEffort`). Presence of this field is also the signal that a
   * model IS reasoning-capable — absence means the platform never sends the parameter at all, which
   * matters because sending it to a model that doesn't support it is a hard 400 on some vendors.
   * MEASURED (routing-decision log, 2026-07-27 through 2026-08-03): `gpt-5.6-luna` calls with tools
   * attached — every ClikAgent turn has tools — go through OpenAI's `/v1/responses` surface (see
   * `responsesPath`) with NO `reasoning_effort` set, and the model spent its entire output budget on
   * hidden reasoning tokens and returned literally nothing: the AI SDK's own `AI_NoOutputGeneratedError`
   * ("No output generated. Check the stream for errors."), on EVERY attempt, no exceptions. `'low'`
   * is the floor default here — enough for tool-call reasoning without regularly starving the visible
   * answer of budget.
   */
  modelWindows?: Readonly<
    Record<
      string,
      {
        contextWindow: number;
        maxOutput?: number;
        reasoningEffort?: AiReasoningEffort;
      }
    >
  >;
  /**
   * This endpoint cannot be relied on for NATIVE tool calling (`tools` in the
   * request, structured tool calls in the response), so a caller that needs
   * tool use falls back to asking for a JSON envelope in prose.
   *
   * A CAPABILITY FLAG, never a name check. The set is small and specific: rows
   * whose endpoint is not a fixed vendor API but whatever the operator pointed
   * it at (`custom-openai`, `ollama`, self-hosted `huggingface` inference), plus
   * Cloudflare Workers AI, where function calling covers only part of the
   * catalog. Every first-party vendor API and every hosted OpenAI-compatible
   * aggregator supports tools, so the field stays absent on the other ~27 rows
   * rather than restating the default.
   */
  noNativeTools?: boolean;
  /**
   * Extra PlatformSecret fields a provider's Connect flow needs beyond the
   * standard key/oauth pair, purely to look up GENUINE vendor pricing —
   * never to authenticate chat traffic (that stays on envKey/oauth exactly
   * as before).
   *
   * Declared because Microsoft Foundry's pricing lookup needs Azure's
   * management-plane (ARM) API to resolve a customer-chosen DEPLOYMENT name
   * to the underlying vendor model id (see ai-azure-arm.ts), and ARM needs
   * two more identifiers than the existing Azure OAuth app + subscription ID
   * already collected under `auth-azure`/`compute-cpu`: which resource group
   * and which Cognitive Services account to address. Carried as catalog DATA
   * (rather than a `provider === 'microsoft-foundry'` branch in the admin
   * panel) so a second provider needing the same shape has somewhere to
   * declare it instead of a second hardcoded branch.
   */
  pricingLookupFields?: readonly {
    envKey: string;
    /** Short label, e.g. "Resource group" → "Set Resource group". */
    label: string;
    /** Shown under the field so an unfamiliar Azure-specific concept is explained. */
    helpText?: string;
  }[];
}

/**
 * Window assumed for a provider that declares none. Small on purpose: every
 * mainstream chat model since 2023 has at least this, so it can only cause the
 * assistant to be slightly more frugal than necessary, never to build a prompt
 * the model rejects.
 */
export const DEFAULT_CONTEXT_WINDOW = 16_000;

/** Matches `@ai-sdk/openai`'s `reasoningEffort` provider option (the only vendor with registry
 *  data for this today — see `modelWindows`'s doc comment). */
export type AiReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AiModelTokenLimits {
  /** Total prompt + completion window. */
  contextWindow: number;
  /** Max output tokens for one request, when the provider states one. */
  maxOutput?: number;
}
