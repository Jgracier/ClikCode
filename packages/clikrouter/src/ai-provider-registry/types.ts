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
  | "decision" // structured decision service; never ordinary chat routing
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
  | "typesafe-models" // TypeSafe catalog with bearer auth
  | "openai-codex-models" // ChatGPT subscription catalog at /backend-api/codex/models
  | "anthropic-models" // GET url with x-api-key (or Bearer for OAuth) + anthropic-version
  | "google-code-assist" // Google Gemini CLI OAuth account/tier probe
  | "cloudflare-models" // Cloudflare account-scoped Workers AI model search
  | "openrouter-key" // GET /key with Bearer (OpenRouter's /models is unauthenticated)
  // A minimal REAL turn through the vendor's CLI harness (ai-harness-registry) —
  // for a subscription whose only surface IS that CLI (xai). Not an HTTP call
  // at all: the credential-health probe hands it to the harness runner, on the
  // worker, so the probe exercises exactly the transport dispatch uses. Declared
  // per (provider, credentialKind) via `bySource`, never as a base kind.
  | "harness-turn"
  // A minimal REAL turn over the vendor's DIRECT subscription surface (registry
  // `oauthChat`) — for a subscription that dispatches over HTTP (openai → Codex
  // backend, google → Code Assist). MEASURED 2026-09-05 on prod: both rows were
  // probed by a CATALOG call on that host (`/codex/models`, `:loadCodeAssist`)
  // which answered 200 while every real turn on the same token failed (Code
  // Assist `:generateContent` 403 "no valid license"), so the sweep wrote `ok`
  // and the router's probe-error exclusion could never fire. Same rule as
  // `harness-turn`: the probe certifies the surface dispatch uses, or nothing.
  // The cell's `catalog` names the discovery call that runs ONLY after the turn
  // passes — it populates the model picker and never decides the verdict.
  | "subscription-turn"
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
 *
 * ENV-OVERRIDABLE, because the pin is impersonating a vendor CLI the vendor
 * versions on their own schedule: if OpenAI or Google ever starts rejecting an
 * old client string, the fix is an env var and a restart, not a code deploy.
 * Boot-time env is the right tier here — these feed registry rows built at
 * module load, so a console-pasted live value could never reach them anyway.
 */
export const OPENAI_CODEX_CLIENT_VERSION =
  (typeof process !== "undefined" && process.env?.OPENAI_CODEX_CLIENT_VERSION?.trim()) ||
  "0.144.1";
export const GEMINI_CLI_CLIENT_VERSION =
  (typeof process !== "undefined" && process.env?.GEMINI_CLI_CLIENT_VERSION?.trim()) || "0.1";

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
  /**
   * For `kind: "subscription-turn"` only: the model-catalog call run AFTER the
   * turn has passed. Discovery, never the verdict — see AiProbeKind's own note
   * on why a catalog call cannot certify a subscription.
   */
  catalog?: Omit<AiProbeEndpoint, "catalog">;
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
   *  'unsupported'. `catalogUrl` is an
   *  optional SEPARATE unauthenticated models-list call for providers whose
   *  cheapest authenticated probe (`url`) doesn't itself return a model list
   *  (e.g. Hugging Face's whoami vs OpenRouter's /key) — fetched once after a
   *  successful probe, same pattern for both providers.
   *
   *  `bySource` is the SECOND DIMENSION. See {@link AiProbeSpec}. */
  probe: AiProbeSpec;
  /**
   * Boolean field in each catalog model that authoritatively declares a free
   * model. This lets catalog parsing preserve explicit zero prices without a
   * provider-name branch or treating every ambiguous zero as free.
   */
  catalogFreeModelBooleanField?: string;
  /**
   * Optional provider-specific performance facts carried by the model catalog.
   * The value names the schema, not the provider, so probe execution remains
   * registry-driven as more catalogs expose their own upstream telemetry.
   */
  catalogEndpointPerfShape?: "huggingface-upstreams";
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
  /**
   * How a SUBSCRIPTION (OAuth) credential for this provider is spent. The two
   * credential tiers are independent transports, and this declares the
   * subscription one POSITIVELY:
   *
   *   'direct'  — send the token over HTTP to the surface named in `oauthChat`
   *               (OpenAI → the Codex backend, Google → Code Assist). These are
   *               real vendor endpoints, not a wrapper around a CLI.
   *   'harness' — the vendor's own CLI is the supported way to spend this
   *               subscription, and is therefore the PRIMARY and only path for
   *               it (Anthropic → Claude Code). Not a fallback: no HTTP attempt
   *               is made first, and nothing "falls back" to it. This is a
   *               separate state rather than "direct or nothing" because a
   *               vendor can answer its own OAuth bearer with 403 on the public
   *               API (api.x.ai does) while the subscription is still fully
   *               spendable through the vendor's CLI.
   *   undefined — this provider has no working subscription dispatch at all, so
   *               an OAuth credential for it can be connected but not spent (a
   *               row with an OAuth connection and neither a known subscription
   *               endpoint nor a vendor CLI baked into the worker image). A row
   *               in this state MUST say why in `subscriptionUnsupportedReason`
   *               so the router's exclusion, the HTTP chokepoint's refusal and
   *               the admin console all carry the same fact. No row is in this
   *               state today: xAI was (2026-09-05, between losing its direct
   *               surface and its CLI being baked into the worker image) and
   *               left it as 'harness'; huggingface and microsoft-foundry left
   *               it by dispatching 'direct' onto the same inference host their
   *               API key uses. The datum stays for the next vendor that lands
   *               here.
   *
   * An API KEY is unaffected by this field in every case — it always dispatches
   * over plain HTTP to `chatBaseUrl`.
   *
   * Replaced the older boolean `oauthBareCompletion`, which could only say
   * "direct or not" and so made 'harness' and 'unusable' indistinguishable —
   * the ambiguity that let a harness-tier provider be silently skipped by a lane
   * that meant to skip only the unusable ones.
   */
  subscriptionTransport?: "direct" | "harness";
  /**
   * WHY a subscription (OAuth) credential for this provider cannot be spent —
   * required exactly when `subscriptionTransport` is undefined on a row that
   * still offers `oauth`. This is the one sentence every surface repeats
   * (router exclusion detail, HTTP chokepoint throw, credential-health probe
   * result), so a connected-but-unspendable subscription is never a SILENT
   * skip: the row says what is broken and what would unblock it.
   *
   * Prose, not a code: the reason is vendor-specific evidence (a measured
   * status, a header the vendor now requires) that changes when the vendor
   * does, and the reader is an operator deciding whether to reconnect, buy an
   * API key, or wait.
   */
  subscriptionUnsupportedReason?: string;
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
   * Path into the provider's OWN raw usage object (`LanguageModelUsage.raw`,
   * which the OpenAI-compatible adapter passes through verbatim) at which a
   * total USD cost for the call sits.
   *
   * THE SECOND, WIDER ROUTE TO GROUND TRUTH. `sdkCostMetadataKey` only works
   * for vendors whose first-party AI SDK package parses cost into
   * `providerMetadata` — exactly one row does (Perplexity). Most vendors that
   * report a real cost are served by the generic OpenAI-compatible adapter,
   * which parses no vendor-specific fields at all but does hand the untouched
   * usage object back. Reading a declared path out of it costs nothing and is
   * the difference between billing a catalog ESTIMATE and billing the
   * vendor's own figure.
   *
   * Safe by construction: a path that does not resolve to a finite number
   * yields undefined, and the caller falls back to the estimate exactly as
   * before. So a vendor that stops publishing the field, or an account that
   * never enabled it, degrades to the pre-existing behaviour rather than
   * producing a wrong number.
   */
  usageCostUsdPath?: readonly string[];
  /**
   * Path into the provider's complete response/chunk at which it reports the
   * settled USD cost for that request. Unlike `usageCostUsdPath`, this covers
   * OpenAI-compatible gateways whose billing envelope sits beside `choices`.
   * The compatible adapter captures it before schema normalization discards
   * unknown top-level response fields.
   */
  responseCostUsdPath?: readonly string[];
  /**
   * Request-body fields that ASK this vendor to report its cost, merged into
   * the call as provider options (the OpenAI-compatible adapter spreads
   * `providerOptions[<row id>]` straight into the body).
   *
   * Declared alongside `usageCostUsdPath` because for several vendors the cost
   * is opt-in per request — OpenRouter returns `usage.cost` only when the body
   * carries `usage: { include: true }`. Without this the path above would
   * silently never resolve, which reads as "this vendor doesn't report cost"
   * when in fact nobody asked.
   */
  usageAccountingOptions?: Readonly<Record<string, unknown>>;
  /**
   * How this provider's PROMPT CACHING is activated.
   *
   *   'explicit'  — the caller must mark a cache breakpoint on the request, and
   *                 the vendor caches NOTHING otherwise (Anthropic). Cache
   *                 writes are charged at a premium, so this only pays off when
   *                 the marked prefix is reused inside the TTL.
   *   'automatic' — the vendor caches on its own, with no request parameter to
   *                 set (OpenAI, DeepSeek). The caller cannot switch it on or
   *                 off; what the caller CONTROLS is whether it hits, by keeping
   *                 the prompt's leading bytes stable.
   *   undefined   — no prompt caching, or none this platform can reach.
   *
   * The distinction is load-bearing rather than descriptive: it decides whether
   * there is anything to send, and it decides whether an agent-level toggle
   * means anything. Turning caching "off" for an automatic provider is not a
   * thing that can be done, and a control implying otherwise would be a lie.
   */
  promptCaching?: "explicit" | "automatic";
  /**
   * This provider runs a BATCH API: work is submitted asynchronously against a
   * completion window and charged at a discount, instead of being answered on
   * the request.
   *
   * A genuinely different DISPATCH MODEL, not a cheaper flag on the same call —
   * which is why it is declared here rather than inferred from a price. A
   * caller opts into waiting; nothing can silently route a synchronous request
   * onto it, because a batch submission returns a job id rather than an answer.
   *
   * Every path below was probed live (2026-08-20, no credential — 401 proves
   * the route exists and authenticates). `discount` is what the vendor's own
   * published batch table charges relative to standard; it is documentation for
   * an operator, never the number anything bills on. Real batch rates come from
   * `AiDiscoveredModel.batchInMTok/batchOutMTok`, per model, because a vendor
   * does not offer every model on its batch tier.
   *
   * NOT WIRED TO DISPATCH, and that is a finding rather than an omission. Of
   * the four router-governed tasks, three (ClikAgent chat, ClikNet remediation,
   * ClikEvents research) are multi-turn TOOL LOOPS, where each request depends
   * on the previous tool result — a shape a batch API cannot express at all,
   * since it accepts one request and returns one response with no turn between
   * them. The fourth, the task-triage full-promotion sweep, is single-shot per
   * pattern and so would fit, but it is a progress-tracked job an operator
   * watches and can pause or cancel mid-run; trading a few minutes for a
   * 24-hour opaque window is a bad trade for half the token price.
   *
   * So the endpoints and per-model batch rates are captured HERE, where they
   * cost nothing and are ready the day a latency-tolerant bulk workload exists.
   * What is deliberately absent is an `allowBatch` agent toggle: there is no
   * workload it could route today, and a switch that changes nothing is worse
   * than no switch.
   */
  batch?: {
    /** Submission path, absolute. */
    url: string;
    /** Longest the vendor guarantees for completion, for the operator's sake. */
    completionWindow: string;
    /** Published discount vs the standard tier, e.g. '50%'. Descriptive only. */
    discount: string;
  };
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
   *   openai-responses   — POST {chatBaseUrl}{responsesPath ?? '/responses'} for EVERY call
   *
   * `openai-responses` is for providers that serve the Responses schema and NOTHING else, so
   * there is no `/chat/completions` to fall back to. That is a different claim from
   * `responsesPath`, which keeps `/chat/completions` as the normal path and moves only
   * tool-carrying calls; a row declaring this dialect never builds a chat-completions body.
   * Distinct from `openAiCompatible`, which specifically means the chat-completions dialect —
   * a Responses-only row must NOT set it, or callers would address a route that 404s.
   */
  chatDialect?: "openai-chat" | "anthropic-messages" | "openai-responses";
  /**
   * How this endpoint validates a tool's `parameters` JSON Schema.
   *
   * `"json-schema"` (the default when omitted) sends the tool's raw JSON Schema,
   * as OpenAI and every OpenAI-compatible vendor accept it. `"gemini"` projects
   * it through geminiFunctionDeclaration to Gemini's restricted Schema subset —
   * Google's OpenAI-compatible endpoint (and the Code Assist OAuth surface)
   * REJECT raw JSON Schema on tool calls, 400-ing every tool-carrying turn.
   *
   * A registry field rather than an `id === "google"` branch in the body builder:
   * every agent turn carries tools, so a new Gemini-family or strict-validator
   * row must be able to DECLARE this and get correct behaviour without a code
   * change (and without silently 400-ing on its first tool call).
   */
  toolSchemaDialect?: "json-schema" | "gemini";
  /**
   * Dispatch overrides that apply ONLY when the credential is an OAuth
   * subscription token — the SECOND DIMENSION for chat, exactly as
   * `probe.bySource` is for health.
   *
   * Declared because several vendors route subscription traffic to a COMPLETELY
   * different surface than their public API, and the token is rejected on the
   * public one by design (measured here: OpenAI 401 `Missing scopes:
   * model.request`; Google 403 on generativelanguage; xAI 403 on api.x.ai). The
   * vendor's own CLI is not doing anything privileged — it is calling a
   * different HTTPS endpoint, sometimes with a different body shape. So this is
   * a ROW DATUM (host + dialect + pinned client headers), not a reason to shell
   * out to that CLI: once the endpoint and its headers are known, the harness is
   * pure overhead and its row is deleted (see the openai/google history in
   * ai-harness-registry.ts).
   *
   * THE LIMIT OF THAT RULE, measured 2026-09-05: the surface must be one the
   * vendor serves to a plain HTTP client. xAI's cli-chat-proxy.grok.com was
   * declared here as a `grok-chat` dialect on the strength of its host + two
   * pinned headers, and then answered every real turn with 426 `Your Grok CLI
   * version (none) is outdated` — the proxy gates on the CLI's own
   * `x-grok-client-version` and only admits a current Grok CLI build. Sending
   * that header from a server that is not the CLI would be spoofing a client
   * identity to evade a vendor control, so the dialect was deleted and xAI's
   * subscription is spent through its CLI instead ('harness'). A surface is only
   * `oauthChat` material when a bare HTTP request the vendor's CLI would also
   * send is ACCEPTED — not when it happens to be the CLI's upstream.
   *
   * Dialects:
   *   codex-responses — OpenAI's internal Responses backend (stateless, SSE).
   *   code-assist     — Google's Code Assist `:generateContent`.
   *
   * `path` is appended to `baseUrl` when the dialect needs one (Codex's
   * `/responses`); the Code Assist dialect builds `:generateContent` itself
   * because the method rides in the URL as a `:`-suffix, not a path segment.
   */
  oauthChat?: {
    baseUrl: string;
    dialect: "codex-responses" | "code-assist";
    path?: string;
    /** Pinned client identification the vendor's own CLI sends verbatim. */
    headers?: Readonly<Record<string, string>>;
  };
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
   *  itself rather than an auth header (Cloudflare's account id, AWS Bedrock's
   *  region). When set, chatBaseUrl and probe.url contain the literal
   *  placeholder '{urlParam}', substituted server-side by resolveProviderUrl()
   *  in ai-provider-http.ts — never resolved here (pure data, no env access). */
  urlParamEnvKey?: string;
  /**
   * The admin AI tab COLLECTS urlParamEnvKey itself, with this prompt.
   *
   * Absent means the value is supplied somewhere else — cloudflare's account id
   * arrives with the OAuth connect and is edited under Platform secrets, which
   * is why `urlParamEnvKey` rendered nothing in the AI tab until this existed.
   *
   * Declared as DATA because the alternative for aws-bedrock was the field it
   * replaces: a free-text `baseUrlEnvKey` where the operator typed a whole URL,
   * omitted the `/v1` suffix, and got a bare 404 that never evaluated the key.
   * A row that templates its own base cannot be typed wrong that way.
   */
  urlParamPrompt?: {
    /** Field label, e.g. "AWS region". */
    label: string;
    /** One line under the label — what the value is and where to find it. */
    help: string;
    /** Example value, shown in the free-text fallback. */
    placeholder: string;
    /**
     * SHAPE the value must match (RegExp source), enforced client-side and
     * again at POST /api/admin/integrations.
     *
     * Deliberately a shape and not an allowlist: an enumerated region list
     * goes stale the day the vendor adds a region, and a stale allowlist
     * REJECTS a value that works — the worst direction to be wrong in. The
     * live option list below is what narrows this to what actually answers.
     */
    pattern: string;
    /** Live-derived options for a picker. Absent = free text only. */
    optionsSource?: "aws-bedrock-regions";
  };
  /** For a configurable OpenAI-compatible endpoint, read the entire API base
   *  URL from this PlatformSecret/env key. This is intentionally distinct
   *  from urlParamEnvKey, which substitutes one URL segment. */
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
   * this field replaced.
   *
   * THE RUNTIME LOOKUP THIS COMMENT ONCE CALLED FOR NOW EXISTS. Discovery reads
   * each vendor's own per-model window out of the catalog response
   * (OpenRouter's `context_length` / `top_provider.context_length`, Mistral's
   * `max_context_length` — see probe-adapters.ts's deriveContextWindow) and
   * persists it as AiProviderModel.contextWindowTokens; the catalog feeds
   * (models.dev / LiteLLM) backfill it for models whose own vendor publishes
   * none. platform-domains' resolveModelTokenLimits is the ONE place the two
   * sources are arbitrated — real per-model evidence wins, this floor stands in
   * where none exists — and ai-router-candidates.ts now attaches the merged
   * value to every routable candidate so SELECTION can refuse a model that
   * cannot hold the prompt, not just the prompt shaper afterwards.
   *
   * So the floor below is exactly that now: a floor of last resort, load-bearing
   * only where no vendor and no feed has ever published a window. It is no
   * longer the aggregators' normal answer.
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
  /**
   * Connect credentials this provider SHARES with another domain's connect flow,
   * set inline alongside client id/secret — part of the connect credential set,
   * NOT pricing (contrast `pricingLookupFields`).
   *
   * Microsoft Foundry shares Azure's app registration with the Azure compute
   * connection: id + secret + `AZURE_OAUTH_TENANT_ID`. The tenant is the same
   * value on both surfaces, so it is settable from either. Carried as catalog
   * DATA (not a `provider === 'microsoft-foundry'` branch in the panel) so any
   * future shared-credential provider declares it here. Optional at connect time
   * — a multi-tenant Azure app uses `/common` and needs no tenant; a single-
   * tenant app requires it (see resolveAuthorizationUrl in oauth-helpers.ts).
   */
  oauthSharedFields?: readonly {
    envKey: string;
    label: string;
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
