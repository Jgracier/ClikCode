// ============================================
// AI PROVIDER REGISTRY — the row shape
// ============================================
//
// Only what ClikCode reads: whether an id is a model API it can address
// directly (lazy-bridge's isDirectModelProvider), and what the API-key turn
// (streamAiChatTurn) needs to reach it. ClikDeploy keeps its own, wider copy of
// this registry (@clikdeploy/clikrouter) with probes, pricing and OAuth
// surfaces; none of that is reachable from here.

export interface AiProviderSpec {
  /** Canonical provider id. */
  id: string;
  /** Human-readable display label. */
  label: string;
  /** Env var conventionally holding the API key. */
  envKey?: string;
  /** Chat API base URL (no trailing slash). The OpenAI-compatible adapter
   *  appends /chat/completions; a first-party package builds its own route. */
  chatBaseUrl?: string;
  /** Env var holding the one segment some providers bake into the base URL
   *  (Bedrock's region, Cloudflare's account id): `chatBaseUrl` carries the
   *  literal placeholder '{urlParam}' where it goes (see resolveBaseUrl). */
  urlParamEnvKey?: string;
  /** For a configurable OpenAI-compatible endpoint, read the entire API base
   *  URL from this env var instead (see resolveBaseUrl). */
  baseUrlEnvKey?: string;
  /**
   *   openai-chat        — chat completions (the default)
   *   anthropic-messages — Anthropic's Messages API
   *   openai-responses   — the Responses API for EVERY call: providers that
   *                        serve nothing else, so there is no
   *                        /chat/completions to fall back to.
   */
  chatDialect?: "openai-chat" | "anthropic-messages" | "openai-responses";
  /** Model used when the caller names none. */
  defaultModel?: string;
  /**
   * How this provider's PROMPT CACHING is activated.
   *
   *   'explicit'  — the caller must mark a cache breakpoint on the request, and
   *                 the vendor caches NOTHING otherwise (Anthropic).
   *   'automatic' — the vendor caches on its own, with no request parameter.
   *   undefined   — no prompt caching, or none reachable.
   */
  promptCaching?: "explicit" | "automatic";
  /** Provider metadata key containing an SDK-reported total request cost. */
  sdkCostMetadataKey?: string;
  /** Path into the provider's raw usage object at which a total USD cost for
   *  the call sits (read through the OpenAI-compatible adapter's `raw`). */
  usageCostUsdPath?: readonly string[];
  /** Path into the provider's complete response or stream chunk at which it
   *  reports the settled USD cost of the request. */
  responseCostUsdPath?: readonly string[];
  /** Request-body fields that ASK this vendor to report its cost (OpenRouter
   *  returns `usage.cost` only when asked), merged in as provider options. */
  usageAccountingOptions?: Readonly<Record<string, unknown>>;
}
