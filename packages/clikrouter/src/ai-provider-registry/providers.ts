// ============================================
// AI PROVIDER REGISTRY — provider table (canonical order)
// ============================================

import type { AiProviderSpec } from "./types";
import {
  OPENAI_CODEX_CLIENT_VERSION,
  GEMINI_CLI_CLIENT_VERSION,
} from "./types";

/** All known AI providers, in canonical display order. */
export const AI_PROVIDERS = [
  {
    id: "xai",
    // Automatic on every grok model per xAI's docs — no request parameter,
    // so again only prefix stability is ours to control.
    // (docs.x.ai/developers/advanced-api-usage/prompt-caching)
    //
    // NOTE, same shape as Fireworks below: xAI documents `x-grok-conv-id` as
    // the header that maximises hit rate by keeping one conversation on one
    // cache. Not sent today.
    promptCaching: "automatic",
    contextWindow: 256_000,
    maxOutput: 32_000,
    // Context windows from xAI's published model table. xAI states a context
    // window per model but NO output cap, so these entries carry only the
    // window and inherit the row's 32K maxOutput — inventing an output cap to
    // fill the field would be the guess this table exists to avoid.
    modelWindows: {
      "grok-4.5": { contextWindow: 500_000 },
      "grok-4.3": { contextWindow: 1_000_000 },
      "grok-4.20": { contextWindow: 1_000_000 },
      // grok-build-0.1 is 256K — exactly the row floor, so no entry needed.
    },
    keyUrl: "https://console.x.ai",
    defaultModel: "grok-4-1-fast",
    label: "Grok (xAI)",
    envKey: "GROK_API_KEY",
    chatBaseUrl: "https://api.x.ai/v1",
    chatDialect: "openai-chat",
    authHeader: "bearer",
    probe: { kind: "openai-models", url: "https://api.x.ai/v1/models" },
    openAiCompatible: true,
    oauth: true,
    // xAI publishes its own non-interactive CLI (`@xai-official/grok`, maintainer
    // xai-security <security@x.ai>), and that CLI is the ONLY working way to spend
    // a Grok subscription. Deliberately NOT 'direct': the measured fact that put
    // this row at "unspendable" for so long has not changed — api.x.ai still
    // answers an xAI OAuth bearer with 403, and there is no `oauthChat` surface
    // here because no such surface is known to exist. What changed is that a
    // harness transport now does. See the xai row in ai-harness-registry.ts for
    // the adapter and exactly what was and was not observed.
    subscriptionTransport: "harness",
  },
  {
    id: "anthropic",
    // Caches NOTHING unless the request carries a cache_control breakpoint, and
    // charges 1.25x to write one — so it pays off only when the marked prefix is
    // reused inside the TTL, which is why this is agent-gated rather than always on.
    promptCaching: "explicit",
    // Batch API — probed live 2026-08-20 (401, so the route exists and
    // authenticates). Async submission at 50% of the standard rate.
    batch: {
      url: "https://api.anthropic.com/v1/messages/batches",
      completionWindow: "24h",
      discount: "50%",
    },
    contextWindow: 200_000,
    maxOutput: 32_000,
    // Per-model, from Anthropic's published model table. Every current
    // Fable/Opus/Sonnet model carries 1M context and a 128K output cap AS THE
    // DEFAULT — the window is no longer a beta advertised in the model id, so
    // the old `claude-opus-5[1m]` entry is gone: plain `claude-opus-5` is 1M,
    // and it was also understating that model's output cap by half (64K).
    // Leaving these to the 200K/32K provider floor cost ~800K tokens of prompt
    // room on the default model alone.
    modelWindows: {
      "claude-fable-5": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-mythos-5": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-opus-5": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-opus-4-8": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-opus-4-7": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-opus-4-6": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-sonnet-5": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutput: 128_000 },
      "claude-haiku-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
      // Sonnet 4.5 predates the 1M default (1M was beta-gated there), so 200K
      // is its honest floor rather than an under-estimate.
      "claude-sonnet-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
      // NOT LISTED, deliberately: claude-opus-4-5, claude-opus-4-1,
      // claude-opus-4-0, claude-sonnet-4-0. Anthropic's current model table
      // does not publish windows for the legacy/deprecated rows, so they keep
      // the conservative 200K/32K provider floor until a value is established.
    },
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    // Native Messages API — not OpenAI-compatible. chatBaseUrl is the API origin
    // used by the anthropic-messages dialect (assistant + enrichment + triage).
    chatBaseUrl: "https://api.anthropic.com",
    chatDialect: "anthropic-messages",
    authHeader: "auto",
    probe: {
      kind: "anthropic-models",
      url: "https://api.anthropic.com/v1/models",
    },
    oauth: true,
    // The two tiers are cleanly separated here, and this is the one row where
    // that separation is a POLICY choice rather than a technical limit:
    //
    //   API key      → plain HTTP to chatBaseUrl (x-api-key), unchanged.
    //   subscription → Claude Code, always. Not attempted over HTTP first and
    //                  not rescued by the harness afterwards — the CLI IS the
    //                  transport for a Claude subscription.
    //
    // A Claude subscription token does technically work against
    // api.anthropic.com/v1/messages (Bearer + anthropic-version +
    // `anthropic-beta: oauth-2025-04-20`, which ai-provider-http.ts can still
    // build), so this row COULD say 'direct' the way openai and google now do.
    // It says 'harness' because Claude Code is the vendor's own supported
    // surface for a subscription, and because the raw-HTTP route additionally
    // requires spoofing `x-app: cli` and `user-agent: claude-cli/<version>` to
    // stay out of an aggressively rate-limited bucket — imitating the client
    // rather than being it.
    subscriptionTransport: "harness",
    docsPricingCatalog: "anthropic",
  },
  {
    id: "openai",
    // Caches on its own for prompts over ~1024 tokens, matching the longest stable
    // PREFIX. No parameter exists to enable or disable it; the only lever is
    // prompt ordering, which is why no agent toggle is offered for it.
    promptCaching: "automatic",
    // Batch API — probed live 2026-08-20 (401, so the route exists and
    // authenticates). Async submission at 50% of the standard rate.
    batch: {
      url: "https://api.openai.com/v1/batches",
      completionWindow: "24h",
      discount: "50%",
    },
    docsPricingCatalog: "openai",
    contextWindow: 128_000,
    maxOutput: 16_000,
    modelWindows: {
      // gpt-5.6-{sol,terra,luna} are 1.05M/128K per OpenAI's model reference.
      // Longest-prefix wins, so this must stay ahead of the generic `gpt-5`
      // entry below — without it the 5.6 line inherited gpt-5's 400K and lost
      // ~650K tokens of prompt room.
      "gpt-5.6": {
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        reasoningEffort: "low",
      },
      "gpt-5": {
        contextWindow: 400_000,
        maxOutput: 128_000,
        reasoningEffort: "low",
      },
      "gpt-4.1": { contextWindow: 1_000_000, maxOutput: 32_000 },
      o3: {
        contextWindow: 200_000,
        maxOutput: 100_000,
        reasoningEffort: "low",
      },
      o4: {
        contextWindow: 200_000,
        maxOutput: 100_000,
        reasoningEffort: "low",
      },
    },
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.1",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    chatBaseUrl: "https://api.openai.com/v1",
    chatDialect: "openai-chat",
    authHeader: "bearer",
    // ChatGPT subscription APIs need the account id alongside the bearer token;
    // it rides in the OAuth token's own claims.
    oauthAccountIdClaim: {
      namespace: "https://api.openai.com/auth",
      field: "chatgpt_account_id",
    },
    probe: {
      kind: "openai-models",
      url: "https://api.openai.com/v1/models",
      // An OpenAI OAuth credential is a ChatGPT SUBSCRIPTION token, not a
      // platform API key: it cannot call api.openai.com/v1/models at all. The
      // subscription catalog lives behind the Codex CLI's own surface, which
      // identifies its client by a PINNED version in three places (query param,
      // User-Agent, `version` header) — so the pin is ONE declared string here
      // rather than three copies inside a switch case in the probe module.
      bySource: {
        oauth: {
          kind: "openai-codex-models",
          url: "https://chatgpt.com/backend-api/codex/models",
          query: { client_version: OPENAI_CODEX_CLIENT_VERSION },
          headers: {
            "User-Agent": `codex-tui/${OPENAI_CODEX_CLIENT_VERSION}`,
            originator: "codex_cli_rs",
            version: OPENAI_CODEX_CLIENT_VERSION,
          },
        },
      },
    },
    oauth: true,
    openAiCompatible: true,
    usesMaxCompletionTokens: true,
    responsesPath: "/responses",
    // A ChatGPT subscription token cannot call api.openai.com at all (measured
    // here: 401 `Missing scopes: model.request`, and ADDING that scope to the
    // OAuth request breaks the login outright). It CAN call the Codex backend
    // directly over plain HTTPS — that is the same surface `probe.bySource`
    // above already reaches for the model catalog, so this is the catalog
    // fact's dispatch twin rather than a new trust surface.
    //
    // VERIFIED against the Codex CLI's own wire format as reimplemented by
    // opencode-openai-codex-auth (lib/constants.ts + lib/request/*): base
    // https://chatgpt.com/backend-api, path /codex/responses, and the four
    // headers below. `OpenAI-Beta: responses=experimental` and
    // `originator: codex_cli_rs` are both required; the account id rides in
    // `chatgpt-account-id` and comes from THIS ROW's own `oauthAccountIdClaim`
    // (that plugin reads the identical claim path, which is the independent
    // confirmation the claim declared above is the right one).
    //
    // `version`/`User-Agent` reuse OPENAI_CODEX_CLIENT_VERSION, the same pin
    // the probe uses — one declared string for both surfaces.
    oauthChat: {
      baseUrl: "https://chatgpt.com/backend-api",
      path: "/codex/responses",
      dialect: "codex-responses",
      headers: {
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        version: OPENAI_CODEX_CLIENT_VERSION,
        "User-Agent": `codex-tui/${OPENAI_CODEX_CLIENT_VERSION}`,
      },
    },
    // 'direct' because `oauthChat` above gives this token a real HTTP surface.
    // NOT a claim that api.openai.com accepts it — that will never be true —
    // but that the subscription is spendable without running a CLI subprocess.
    subscriptionTransport: "direct",
  },
  {
    id: "google",
    docsPricingCatalog: "google",
    // Real, hard-gated free tier: every new project/API key starts on the
    // Gemini API Free Tier with no billing account attached — rate-limited
    // per model (RPM/TPM/RPD), 429s past the limit, and there is NO silent
    // escalation to billing: moving to a Paid Tier requires the developer to
    // explicitly link a billing account and prepay a minimum $10
    // (ai.google.dev/gemini-api/docs/billing, ai.google.dev/gemini-api/docs/
    // rate-limits, verified 2026-08-08). This is the same API-key surface
    // this row already dispatches chat through (the OpenAI-compatible
    // endpoint), not just the OAuth/Code Assist arm.
    apiKeyAccessClass: "free-tier",
    // No modelWindows: 1M/64K is not a conservative floor here, it is the
    // published figure for the current flagship (Gemini 3.6 Flash, the
    // defaultModel's successor line). Adding per-model rows that restate the
    // row value would be drift waiting to happen.
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-flash",
    label: "Google",
    // Gemini OpenAI-compatible surface so the assistant chat path works with
    // OAuth access tokens (Bearer) without a separate Messages adapter.
    // https://ai.google.dev/gemini-api/docs/openai
    envKey: "GOOGLE_API_KEY",
    chatBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatDialect: "openai-chat",
    authHeader: "bearer",
    openAiCompatible: true,
    // OAuth uses Code Assist; API keys use the public OpenAI-compatible endpoint.
    // Both arms are DECLARED here. They used to be a nested ternary reassigning
    // `kind` plus an `else if` reassigning `url` in the probe module, keyed on
    // `provider === "google"`, with the Gemini CLI's pinned client version
    // written inline in a switch case.
    probe: {
      kind: "google-code-assist",
      url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      headers: {
        "X-Goog-Api-Client": `google-cloud-sdk gemini-cli/${GEMINI_CLI_CLIENT_VERSION}`,
        "User-Agent": `GeminiCLI/${GEMINI_CLI_CLIENT_VERSION}`,
      },
      bySource: {
        // An API key cannot call Code Assist (that surface is OAuth-only), so
        // it probes the public OpenAI-compatible models list instead.
        "api-key": {
          kind: "openai-models",
          url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
          headers: {},
        },
      },
    },
    oauth: true,
    // The Code Assist arm is not just a health probe — it SERVES CONTENT. An
    // OAuth token 403s on generativelanguage (that host wants an API key), but
    // cloudcode-pa answers :generateContent for the same token, which is
    // exactly what the Gemini CLI does internally. Since the CLI adds nothing
    // but this HTTP call, dispatching it here removes the harness from the
    // path entirely — and sidesteps the reason the gemini harness has no
    // adapter at all (untrusted-folder MCP suppression, see
    // ai-harness-registry.ts's google row), which never applies to plain HTTP.
    //
    // Body shape VERIFIED by reading the shipped
    // @google/gemini-cli-core@0.54.4 `dist/src/code_assist/converter.js`:
    // toGenerateContentRequest() wraps as
    //   { model, project, user_prompt_id, request: {...}, enabled_credit_types }
    // and the inner request carries contents/systemInstruction/tools/
    // generationConfig/session_id. `project` is NOT optional — omitting it
    // 500s every call — and comes from :loadCodeAssist's
    // `cloudaicompanionProject`, which ai-adapters/google.ts already reads.
    //
    // The two headers are the same pinned client id the probe above sends.
    oauthChat: {
      baseUrl: "https://cloudcode-pa.googleapis.com/v1internal",
      dialect: "code-assist",
      headers: {
        "X-Goog-Api-Client": `google-cloud-sdk gemini-cli/${GEMINI_CLI_CLIENT_VERSION}`,
        "User-Agent": `GeminiCLI/${GEMINI_CLI_CLIENT_VERSION}`,
      },
    },
    subscriptionTransport: "direct",
  },
  {
    id: "nvidia",
    contextWindow: 128_000,
    keyUrl: "https://ngc.nvidia.com/setup/api-key",
    // No `defaultModel`: the previous pin (nvidia/llama-3.1-nemotron-70b-instruct)
    // 404'd on every routed attempt observed live 2026-08-09 (see
    // ai-provider-models.ts's capturedStreamError comment) — NVIDIA deprecated
    // it. The field is optional, so rather than inventing a replacement id
    // without vendor evidence (the same guess that broke this one), we omit it
    // and let the live catalogUrl feed decide: the candidate builder routes
    // across every discovered model, a default only pins ordering.
    label: "NVIDIA",
    envKey: "NVIDIA_API_KEY",
    chatBaseUrl: "https://integrate.api.nvidia.com/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token, ~120
    // models in valid {data:[...]} shape) — cannot serve as a credential
    // probe; it was previously wired to 'openai-models' and would have
    // reported a dead/absent key as healthy. The public catalog is still
    // fetched separately when a credential is present.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://integrate.api.nvidia.com/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "groq",
    // Automatic, and not switchable: Groq's own docs state caching "works
    // automatically on all your API requests to supported models with no code
    // changes required and no additional fees", cannot be manually disabled,
    // and discounts cached input 50%. So there is nothing for this platform to
    // send and nothing for an operator to turn off — only prefix stability
    // decides whether it hits. (console.groq.com/docs/prompt-caching)
    promptCaching: "automatic",
    // Batch API — probed live 2026-08-20 (401, so the route exists and
    // authenticates). Async submission at 50% of the standard rate.
    batch: {
      url: "https://api.groq.com/openai/v1/batches",
      completionWindow: "24h",
      discount: "50%",
    },
    docsPricingCatalog: "groq",
    // Real, hard-gated free tier — EVERY model, no credits system at all:
    // 30 RPM / 6K TPM / 14,400 requests/day (console.groq.com/docs/rate-limits,
    // verified 2026-08-08). Past the limit the request 429s; there is no paid
    // plan it silently escalates to without adding a card, so this is safe to
    // declare unconditionally free for API-key routing.
    apiKeyAccessClass: "free-tier",
    contextWindow: 128_000,
    maxOutput: 32_000,
    keyUrl: "https://console.groq.com/keys",
    defaultModel: "llama-3.3-70b-versatile",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    chatBaseUrl: "https://api.groq.com/openai/v1",
    probe: {
      kind: "openai-models",
      url: "https://api.groq.com/openai/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "mistral",
    // Caches automatically. Evidence is our OWN production traffic rather than
    // a docs page: 3,658 invocations across ministral-3b/8b, codestral and
    // mistral-medium reported 22.2M cache-read input tokens against 41.3M
    // eligible — a 53.8% hit rate, with per-model rates of 70-90% — while
    // reporting exactly ZERO cache-write tokens. Reads with no writes is the
    // signature of vendor-side automatic caching: nothing here ever asked for
    // a breakpoint, and no write was ever billed.
    //
    // This entry previously carried no mechanism at all, which read as "no
    // caching we can reach" and was simply wrong about the provider serving
    // the majority of this platform's traffic.
    promptCaching: "automatic",
    // Batch API — probed live 2026-08-20 (401, so the route exists and
    // authenticates). Async submission at 50% of the standard rate.
    batch: {
      url: "https://api.mistral.ai/v1/batch/jobs",
      completionWindow: "24h",
      discount: "50%",
    },
    docsPricingCatalog: "mistral",
    // La Plateforme's free "Experiment" workspace tier: rate-limited access
    // to every model (including Mistral Large), ~1B tokens/month, $0
    // (docs.mistral.ai/admin/user-management-finops/tier, verified
    // 2026-08-08). A workspace is assigned Experiment OR a paid tier, never
    // both, so this never silently escalates to billing.
    apiKeyAccessClass: "free-tier",
    contextWindow: 128_000,
    // Voxtral Small is NOT a 128K model despite inheriting the row default —
    // live-verified 2026-08-10 from a real dispatch failure: "Prompt 79419 >
    // 32768 maximum context length" against voxtral-small-latest. This is the
    // exact gap that let a large ClikAgent prompt route to it and exhaust a
    // fallback attempt on a guaranteed-oversized request. Not extended to
    // other Mistral models without the same live confirmation — see
    // ai-credential-health/probe-adapters.ts's deriveContextWindow for the
    // per-model catalog signal (`max_context_length`) that now supersedes
    // this static floor going forward wherever it's populated.
    modelWindows: {
      "voxtral-small": { contextWindow: 32_768 },
    },
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "mistral-large-latest",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    chatBaseUrl: "https://api.mistral.ai/v1",
    probe: { kind: "openai-models", url: "https://api.mistral.ai/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "deepseek",
    // Context caching on disk, activated by the vendor with no request parameter —
    // its published cache-HIT price is the corroboration that it caches at all.
    promptCaching: "automatic",
    docsPricingCatalog: "deepseek",
    contextWindow: 128_000,
    maxOutput: 8_000,
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    chatBaseUrl: "https://api.deepseek.com",
    probe: { kind: "openai-models", url: "https://api.deepseek.com/models" },
    openAiCompatible: true,
  },
  {
    id: "together",
    contextWindow: 128_000,
    keyUrl: "https://api.together.ai/settings/api-keys",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    chatBaseUrl: "https://api.together.xyz/v1",
    probe: { kind: "openai-models", url: "https://api.together.xyz/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "fireworks",
    // Automatic: "enabled by default for all Fireworks models and
    // deployments", matching the longest cached prefix of the request and
    // processing only the remainder. Retention is stated as at least several
    // minutes and up to several hours depending on model and load.
    // (docs.fireworks.ai/guides/prompt-caching)
    //
    // NOTE for a future dispatch change: Fireworks routes across replicas, so
    // hit rate depends on landing on the replica holding the prefix — the
    // `x-session-affinity` header is what pins that. Not sent today, which is
    // a known and measurable cause of misses rather than a mystery.
    promptCaching: "automatic",
    docsPricingCatalog: "fireworks",
    contextWindow: 128_000,
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    label: "Fireworks AI",
    envKey: "FIREWORKS_API_KEY",
    chatBaseUrl: "https://api.fireworks.ai/inference/v1",
    probe: {
      kind: "openai-models",
      url: "https://api.fireworks.ai/inference/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "deepinfra",
    contextWindow: 128_000,
    keyUrl: "https://deepinfra.com/dash/api_keys",
    label: "Deep Infra",
    envKey: "DEEPINFRA_API_KEY",
    chatBaseUrl: "https://api.deepinfra.com/v1/openai",
    probe: {
      kind: "openai-models",
      url: "https://api.deepinfra.com/v1/openai/models",
    },
    openAiCompatible: true,
  },
  {
    id: "baseten",
    contextWindow: 128_000,
    keyUrl: "https://app.baseten.co/settings/api_keys",
    label: "Baseten",
    envKey: "BASETEN_API_KEY",
    // Chat completions still go through the inference host — unaffected by
    // the probe change below.
    chatBaseUrl: "https://inference.baseten.co/v1",
    // Live-verified against docs.baseten.co/reference/management-api-spec.json
    // (833KB, unauthenticated, fetched 2026-08-03): the real pricing-bearing
    // catalog is the management API's GET /v1/model_apis on api.baseten.co
    // (ModelAPIsResponseV1 → { items: ModelAPIV1[], pagination }), NOT
    // inference.baseten.co/v1/models (that host's OpenAI-style /models lists
    // the workspace's own deployed models and carries no pricing at all).
    // Each ModelAPIV1 item has `name` (stable slug id, e.g.
    // "llama-3-3-70b-instruct" — used as-is by inference.baseten.co's
    // chat/completions `model` field) plus `cost_per_million_input_tokens` /
    // `cost_per_million_output_tokens` (number-or-numeric-string, already USD
    // per MILLION tokens — see PROVIDER_PRICING_EXTRACTORS.baseten in
    // ai-credential-health.ts). Same Bearer-token auth as every other
    // openai-models probe; 401s without a real key (live-verified: bare curl
    // returns 401), so this only populates once a real Baseten key is
    // connected — same situation as Cerebras's format=openrouter probe.
    probe: {
      kind: "openai-models",
      url: "https://api.baseten.co/v1/model_apis",
      modelsArrayField: "items",
    },
    openAiCompatible: true,
  },
  {
    id: "cerebras",
    // apiKeyAccessClass DELIBERATELY NOT DECLARED — this row said 'free-tier'
    // and the claim has EXPIRED (corrected 2026-08-13).
    //
    // What was true on 2026-08-08 and is no longer: "1,000,000 tokens/day,
    // resets daily, no credit card". Cerebras has since eliminated that tier.
    // What replaces it is a $5 credit grant that requires a VERIFIED PAYMENT
    // METHOD and expires 30 days after issue, and Cerebras's own docs now state
    // there is no permanent no-cost tier available.
    //
    // That is a credit grant, not a free tier, and the difference is exactly
    // what apiKeyAccessClass encodes: a rate-limited tier 429s and costs nothing
    // ever; a credit grant runs out and then BILLS THE CARD ON FILE, silently,
    // on a provider the router was ranking as free. Leaving the old value would
    // have kept Cerebras out-ranking metered providers on the strength of a tier
    // that no longer exists. Undeclared falls through to "unknown", which fails
    // closed (excluded whenever allowMetered is off) — the same conservative
    // landing spot the cloudflare row uses, and the honest one here.
    contextWindow: 64_000,
    keyUrl: "https://cloud.cerebras.ai/platform",
    defaultModel: "llama-3.3-70b",
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    chatBaseUrl: "https://api.cerebras.ai/v1",
    // Bare /v1/models has no pricing. ?format=openrouter reshapes the
    // response into OpenRouter's own model schema (confirmed via
    // cerebras-cloud-sdk-python's OpenRouterModelPricing type: prompt/
    // completion cost-PER-TOKEN, same USD-per-single-token convention as
    // OpenRouter itself) — so the generic pricing.prompt/completion path in
    // parseModelsListBody picks it up with no extractor. Unauthenticated
    // calls 403 ("Not authenticated"), so this only populates pricing once a
    // real API key is connected and the health probe succeeds.
    probe: {
      kind: "openai-models",
      url: "https://api.cerebras.ai/v1/models?format=openrouter",
    },
    openAiCompatible: true,
  },
  {
    id: "openrouter",
    contextWindow: 128_000,
    keyUrl: "https://openrouter.ai/settings/keys",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    chatBaseUrl: "https://openrouter.ai/api/v1",
    // /api/v1/models is UNAUTHENTICATED on OpenRouter and would report a dead
    // key as healthy; /api/v1/key is the cheapest authenticated call. The
    // model catalog itself is fetched separately from the public endpoint
    // (see catalogUrl — same pattern as Hugging Face below).
    probe: {
      kind: "openrouter-key",
      url: "https://openrouter.ai/api/v1/key",
      catalogUrl: "https://openrouter.ai/api/v1/models",
    },
    // PKCE flow that mints an API key outright — no client registration and no
    // connection row, which is why `oauth` stays false here. AI tab still uses
    // the same Connect + Set shape as account OAuth providers.
    keyMint: {
      label: "Connect",
      startEndpoint: "/api/admin/platform-connect/openrouter/start",
    },
    // EXACT COST, not an estimate. OpenRouter bills a per-request amount that
    // depends on which upstream provider it actually routed to, so a catalog
    // rate for the model id is a genuinely poor proxy for what was charged —
    // the same model can settle at different prices on consecutive calls. It
    // reports the real figure as `usage.cost` (USD), but ONLY when the request
    // opts in via `usage: { include: true }`, which is what the accounting
    // options below add to the body. The OpenAI-compatible adapter spreads
    // providerOptions.openrouter into the request and hands the untouched
    // usage object back as `usage.raw`, so both halves work without a
    // provider-specific branch anywhere in the dispatch path.
    usageAccountingOptions: { usage: { include: true } },
    usageCostUsdPath: ["cost"],
    openAiCompatible: true,
  },
  {
    id: "nous",
    contextWindow: 131_072,
    keyUrl: "https://portal.nousresearch.com",
    label: "Nous Research",
    envKey: "NOUS_API_KEY",
    // API-key-only (no `oauth` field, defaults to key-only in the AI tab) —
    // Nous has no public third-party OAuth client registration, the same
    // situation the now-retired GitHub Models AI connection was in.
    chatBaseUrl: "https://inference-api.nousresearch.com/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no key AND 200
    // with a garbage Bearer key) and there is no cheap authenticated GET
    // (/v1/key, /v1/me, /v1/account, /v1/credits, /v1/usage all 404) — only
    // POST /v1/chat/completions itself validates the key (401 on a bad one).
    // With no authenticated probe available, kind stays 'unsupported' (same
    // as Ollama below) and the model list comes from catalogUrl only.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://inference-api.nousresearch.com/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "cohere",
    // apiKeyAccessClass DELIBERATELY NOT declared — CONFIRMED STILL CORRECT
    // 2026-08-13, and there are now TWO independent reasons, either of which
    // alone is sufficient. Re-checked because the value is absent, and an absent
    // field looks like an oversight to anyone tidying this table.
    //
    // REASON 1 (contractual, and the more permanent of the two). Cohere's free
    // Trial keys are barred from production and commercial use by the terms they
    // are issued under — they exist to evaluate the API, not to serve traffic.
    // Every credential this platform routes to IS production traffic: the
    // remediation lane, the assistant and the triage lane all serve real users
    // on real deployments. So declaring Cohere free-tier would not merely
    // mis-rank it, it would preferentially route production work onto a
    // credential that is not licensed to carry it. A vendor's free tier is only
    // usable here if it is free AND permitted for the use we put it to; Cohere
    // is the row that separates those two questions.
    //
    // REASON 2 (operational, and possibly temporary) — see below.
    //
    // Cohere DOES issue a real, hard-gated free Trial key tier (free, no
    // card, rate-limited, explicitly barred from production/billed use —
    // docs.cohere.com/docs/rate-limits, docs.cohere.com/docs/cohere-faqs,
    // verified 2026-08-08) and that research stands. But declaring it
    // free-tier made Cohere newly ELIGIBLE for AI_ASSISTANT_CHAT (previously
    // excluded as `metered` with allowMetered=false) and broke real ClikAgent
    // chat traffic live in production 2026-08-09: a bare completion works
    // fine, but every attempt WITH tools attached (the real agent path — 48
    // tools) failed with a bare "Not Found" across multiple Cohere models
    // (command-a-03-2025, command-r7b-12-2024) — root cause not yet
    // confirmed (unsupported parameter shape on that specific endpoint is
    // the leading hypothesis). Until that is fixed and live-verified,
    // `noNativeTools: true` below (added 2026-08-13) is a TEMPORARY veto on
    // sending native tools to Cohere at all: dispatch stops attaching the
    // OpenAI-style `tools`/`tool_choice` payload and uses the JSON-envelope
    // protocol instead (the bare completions that DO work), the same
    // mechanism huggingface/ollama rows already use for endpoints that
    // cannot take tools natively. Chosen over inventing a new provider-level
    // "tools currently broken" field because the candidate builder's
    // tool-calling filter is per-MODEL learned evidence
    // (ai-model-capability.ts), not registry data — this flag is the one
    // existing registry-level switch that keeps tool traffic off the broken
    // endpoint without a second arbitration mechanism. Remove the flag once
    // /compatibility/v1 tools dispatch is verified working.
    noNativeTools: true,
    contextWindow: 128_000,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    defaultModel: "command-a-03-2025",
    label: "Cohere",
    envKey: "COHERE_API_KEY",
    // Cohere's documented OpenAI-compatibility host is api.cohere.ai (not
    // .com); live-verified /models 401s without a key (endpoint exists,
    // requires auth) — free trial keys work here too.
    chatBaseUrl: "https://api.cohere.ai/compatibility/v1",
    probe: {
      kind: "openai-models",
      url: "https://api.cohere.ai/compatibility/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "huggingface",
    // The Inference API has a real free tier, so an API-key credential here is
    // not metered the way every other vendor's is.
    apiKeyAccessClass: "free-tier",
    noNativeTools: true,
    contextWindow: 32_000,
    oauth: true,
    keyUrl: "https://huggingface.co/settings/tokens",
    label: "Hugging Face",
    envKey: "HUGGINGFACE_API_KEY",
    // Unified Inference Providers router — free serverless tier per model.
    chatBaseUrl: "https://router.huggingface.co/v1",
    // router.huggingface.co/v1/models is live-verified UNAUTHENTICATED (200
    // with no token) — cannot serve as a credential probe. whoami-v2 is the
    // cheapest authenticated call (live-verified 401 with no token); the
    // model catalog is fetched separately via catalogUrl, same pattern as
    // OpenRouter above.
    probe: {
      kind: "openai-models",
      url: "https://huggingface.co/api/whoami-v2",
      catalogUrl: "https://router.huggingface.co/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "sambanova",
    // Also automatic, on the same evidence standard as mistral above, and
    // recorded with its weaker number rather than rounded up to match: 698
    // reporting invocations, 491K cache-read tokens against 9.7M eligible — a
    // 5.0% hit rate, and again zero writes. Low, but consistently non-zero
    // across hundreds of calls, which is a mechanism operating rather than
    // noise. A low hit rate is a prompt-stability problem on our side, not
    // evidence that the vendor does not cache.
    promptCaching: "automatic",
    // Permanent $0/mo developer tier, 600 RPM, no credit card
    // (sambanova.ai/blog/sambanova-cloud-developer-tier-is-live, verified
    // 2026-08-08) — rate-limit-gated, not credit-gated, so there is no paid
    // plan it silently escalates to. (Separately: a one-time $5/3-month
    // credit also exists on top of this, unrelated to the free tier itself.)
    //
    // THE SIZE OF THE TIER, recorded 2026-08-13 because ranking cannot see it:
    // the free developer tier is 20 REQUESTS PER DAY. The 600 RPM figure above
    // is the burst rate, not the daily allowance, and the two read very
    // differently at a routing decision. `apiKeyAccessClass` has exactly two
    // states — 'free-tier' or metered — with no way to say "free but
    // negligible", so this stays free-tier: it IS free and it IS hard-gated
    // (429, no card, no silent escalation), which is what the flag asserts.
    // What it cannot say is that the twenty-first request of the day fails, so
    // treating SambaNova as a dependable free lane will disappoint. Expressing
    // that honestly needs a quota dimension on the class, not a lie in this
    // field — and the failure mode of leaving it as-is is a 429 (recoverable,
    // and already handled by the cooldown path), whereas demoting it to metered
    // would wrongly bill-gate a genuinely free provider.
    apiKeyAccessClass: "free-tier",
    contextWindow: 64_000,
    keyUrl: "https://cloud.sambanova.ai/apis",
    label: "SambaNova",
    envKey: "SAMBANOVA_API_KEY",
    chatBaseUrl: "https://api.sambanova.ai/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token, though
    // usefully already in {data:[{id,pricing}]} shape) — cannot serve as a
    // credential probe, but is fetched separately for model discovery.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.sambanova.ai/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "moonshot",
    contextWindow: 128_000,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    label: "Moonshot AI (Kimi)",
    envKey: "MOONSHOT_API_KEY",
    chatBaseUrl: "https://api.moonshot.ai/v1",
    probe: { kind: "openai-models", url: "https://api.moonshot.ai/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "nebius",
    contextWindow: 128_000,
    keyUrl: "https://studio.nebius.ai/",
    label: "Nebius AI Studio",
    envKey: "NEBIUS_API_KEY",
    chatBaseUrl: "https://api.studio.nebius.ai/v1",
    // `verbose=true` is required to get RichModel.pricing (prompt/completion,
    // same USD-per-token shape as OpenRouter — see docs.tokenfactory.nebius.com
    // /api-reference/models/list-models) instead of the bare id-only response.
    probe: {
      kind: "openai-models",
      url: "https://api.studio.nebius.ai/v1/models?verbose=true",
    },
    openAiCompatible: true,
  },
  {
    id: "hyperbolic",
    contextWindow: 128_000,
    keyUrl: "https://app.hyperbolic.xyz/settings",
    label: "Hyperbolic",
    envKey: "HYPERBOLIC_API_KEY",
    chatBaseUrl: "https://api.hyperbolic.xyz/v1",
    probe: {
      kind: "openai-models",
      url: "https://api.hyperbolic.xyz/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "novita",
    contextWindow: 64_000,
    keyUrl: "https://novita.ai/settings/key-management",
    label: "Novita AI",
    envKey: "NOVITA_API_KEY",
    chatBaseUrl: "https://api.novita.ai/v3/openai",
    // The catalog is public, so keep credential health explicitly unsupported
    // and discover models through the separate catalog URL.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.novita.ai/v3/openai/models",
    },
    openAiCompatible: true,
  },
  {
    id: "alibaba",
    docsPricingCatalog: "alibaba",
    contextWindow: 128_000,
    keyUrl: "https://bailian.console.alibabacloud.com/",
    label: "Alibaba Cloud Model Studio",
    envKey: "DASHSCOPE_API_KEY",
    chatBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    probe: {
      kind: "openai-models",
      url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "zai",
    docsPricingCatalog: "zai",
    contextWindow: 128_000,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    label: "Z.AI (GLM)",
    envKey: "ZAI_API_KEY",
    chatBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    probe: {
      kind: "openai-models",
      url: "https://open.bigmodel.cn/api/paas/v4/models",
    },
    openAiCompatible: true,
  },
  {
    id: "minimax",
    contextWindow: 128_000,
    keyUrl:
      "https://platform.minimax.io/user-center/basic-information/interface-key",
    label: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    chatBaseUrl: "https://api.minimax.io/v1",
    probe: { kind: "openai-models", url: "https://api.minimax.io/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "ai21",
    contextWindow: 256_000,
    keyUrl: "https://studio.ai21.com/account/api-key",
    defaultModel: "jamba-mini",
    label: "AI21 Labs",
    envKey: "AI21_API_KEY",
    chatBaseUrl: "https://api.ai21.com/studio/v1",
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.ai21.com/studio/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "perplexity",
    contextWindow: 128_000,
    keyUrl: "https://www.perplexity.ai/settings/api",
    defaultModel: "sonar",
    label: "Perplexity Sonar",
    envKey: "PERPLEXITY_API_KEY",
    chatBaseUrl: "https://api.perplexity.ai",
    chatPath: "/v1/sonar",
    // A REAL credential probe, despite Perplexity's own OpenAPI declaring an
    // empty `security` block for this route. MEASURED, which is what decided
    // it: GET /v1/models with no header → 401 invalid_api_key, and with a
    // bogus bearer → 401 invalid_api_key. It authenticates, so it can prove
    // the key is alive — the opposite of the nvidia/sambanova/novita/ai21/
    // ollama catalogs, which answer 200 to a bogus token and are therefore
    // catalogUrl-only.
    //
    // Note the surface split: chat goes to chatPath /v1/sonar, but the model
    // list is at /v1/models off chatBaseUrl. Unrelated routes, both correct.
    //
    // staticModels DELETED with this change. The hardcoded four had already
    // gone stale (no `sonar-reasoning`), which is the standing argument
    // against a hand-maintained list whenever the vendor publishes one: the
    // list cannot drift if we stop copying it.
    probe: {
      kind: "openai-models",
      url: "https://api.perplexity.ai/v1/models",
    },
    sdkCostMetadataKey: "perplexity",
    openAiCompatible: true,
  },
  {
    // OpenAI-COMPATIBLE, end to end. AWS's Bedrock API-key endpoint speaks the
    // OpenAI dialect and lives under /v1 — MEASURED against a live tenant
    // endpoint (2026-08-13):
    //   GET  {host}/models            -> 404, empty body
    //   GET  {host}/v1/models         -> 401 {"error":{"code":"invalid_api_key",
    //                                    "message":"Missing 'authorization' or
    //                                    'x-api-key' header",...}}  ← OpenAI-shaped
    //   POST {host}/v1/chat/completions -> 405 on GET (the route exists)
    //   GET  {host}/chat/completions  -> 404
    //
    // ONLY THE REGION VARIES, so only the region is asked for. This row used to
    // carry `baseUrlEnvKey: AWS_BEDROCK_BASE_URL` and a free-text URL field in
    // the AI tab, and the very first operator to use it typed the host WITHOUT
    // the /v1 suffix: bare 404, key never evaluated. A field that can be typed
    // wrong in exactly one way, where the platform already knows the right
    // answer, is a field that should not exist — so the row templates the whole
    // base including /v1 and `urlParamEnvKey` supplies the one segment that is
    // genuinely the operator's to choose.
    //
    // THE HOSTNAME PATTERN IS MEASURED, NOT ASSUMED (2026-08-13, from the
    // control plane, unauthenticated GET /v1/models): 18 of the 35 regions AWS
    // lists for Bedrock answer 401 with an OpenAI-shaped body — ap-northeast-1,
    // ap-south-1, ap-southeast-1/2/3/4, eu-central-1/2, eu-north-1, eu-south-1,
    // eu-west-1/2, sa-east-1, us-east-1/2, us-gov-east-1, us-gov-west-1,
    // us-west-2. The other 17 (af-south-1, ca-central-1, us-west-1, …) are
    // NXDOMAIN: the mantle endpoint does not exist there, even though Bedrock
    // foundation models are priced there. That gap is why the picker's options
    // are filtered by probing this template and not taken from AWS's pricing
    // region index alone (see getAwsBedrockRegions in
    // ai-cloud-pricing-catalogs.ts) — "Bedrock is offered here" and "the
    // OpenAI-compatible endpoint answers here" are different claims, and only
    // the second one predicts a working chat call.
    //
    // This row deliberately has NO first-party factory. It used to map to
    // createAmazonBedrock, which builds Bedrock-NATIVE paths off the same base
    // ({base}/model/{id}/converse, /invoke), so the probe below and every chat
    // call wanted DIFFERENT base URLs and no single stored value could satisfy
    // both: the connection test went green while chat 404'd on every request.
    // Dropping the factory also drops SigV4 — this row is API-key only now.
    // Nothing routed Bedrock through AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
    // deliberately (those are the Fargate/Lambda/backup credentials); the old
    // factory could only reach SigV4 by ACCIDENT, when no Bedrock API key was
    // set, by silently signing with those unrelated compute credentials.
    id: "aws-bedrock",
    cloudPricingLookup: "aws-bedrock",
    contextWindow: 200_000,
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    label: "Amazon Bedrock",
    envKey: "AWS_BEDROCK_API_KEY",
    urlParamEnvKey: "AWS_BEDROCK_REGION",
    // A DEDICATED key, deliberately not the existing AWS_REGION PlatformSecret.
    // AWS_REGION is where this platform's own Fargate/Lambda/S3 workloads run —
    // chosen for compute latency and cost, and rewritten whenever an operator
    // moves that compute. Bedrock's region decides which MODELS exist and what
    // tokens cost, and the mantle endpoint answers in only 18 regions (above)
    // while Lambda runs in all of them. Sharing one value would mean moving the
    // compute region silently repointed every LLM call, or worse, pointed it at
    // a region with no endpoint at all.
    chatBaseUrl: "https://bedrock-mantle.{urlParam}.api.aws/v1",
    probe: {
      kind: "openai-models",
      url: "https://bedrock-mantle.{urlParam}.api.aws/v1/models",
    },
    urlParamPrompt: {
      label: "AWS region",
      help: "Where your Bedrock API key was issued. The endpoint is built for you — there is no URL to type.",
      placeholder: "us-east-1",
      // Region-id GRAMMAR, not a region list: geo, one or more words, digit
      // (us-east-1, ap-southeast-4, us-gov-west-1). An enumerated list would
      // reject a region AWS added yesterday; the live options below are what
      // narrow this to the ones whose endpoint actually answers.
      pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$",
      optionsSource: "aws-bedrock-regions",
    },
    openAiCompatible: true,
  },
  {
    id: "microsoft-foundry",
    cloudPricingLookup: "azure-foundry",
    contextWindow: 128_000,
    oauth: true,
    keyUrl: "https://ai.azure.com/",
    label: "Microsoft Foundry",
    envKey: "AZURE_AI_API_KEY",
    baseUrlEnvKey: "AZURE_AI_BASE_URL",
    chatBaseUrl: "{baseUrl}",
    authHeader: "api-key",
    probe: { kind: "openai-models", url: "{baseUrl}/models" },
    openAiCompatible: true,
    // ARM identifiers for genuine vendor pricing (ai-azure-arm.ts). The
    // credential doing the ARM auth is the SAME Azure OAuth app already
    // collected for cloud-provider connect (AZURE_OAUTH_CLIENT_ID/SECRET/
    // TENANT_ID, see azure-container-apps-provider.ts) plus the SAME
    // AZURE_SUBSCRIPTION_ID already collected for Container Apps Jobs —
    // reused here a third time rather than asking for a second Azure secret.
    // Only the resource group + account name are new: the two ARM path
    // segments needed to address one specific Foundry/Cognitive Services
    // account within that subscription.
    pricingLookupFields: [
      {
        envKey: "AZURE_FOUNDRY_RESOURCE_GROUP",
        label: "Resource group",
        helpText:
          "Azure resource group containing the Foundry/Cognitive Services account (for ARM pricing lookup only — pairs with the Azure OAuth app + subscription ID already set under Platform secrets).",
      },
      {
        envKey: "AZURE_FOUNDRY_ACCOUNT_NAME",
        label: "Account name",
        helpText:
          "The Cognitive Services/Foundry account name (Azure Portal → your Foundry resource → Overview → Name), used to resolve a deployment to its real model for pricing.",
      },
    ],
  },
  {
    id: "cloudflare",
    docsPricingCatalog: "cloudflare",
    // 10,000 free Neurons/day, resets daily
    // (developers.cloudflare.com/workers-ai/platform/pricing, verified
    // 2026-08-08) — UNLIKE Groq/Cerebras/SambaNova/Mistral above, this is a
    // *Workers plan* allowance, not a credential-tier one: on the free
    // Workers plan, going over simply errors; on a PAID Workers plan, it
    // silently bills at $0.011/1,000 Neurons instead of failing.
    //
    // Deliberately left undeclared (falls through to "unknown", which fails
    // closed — excluded whenever allowMetered is off) rather than asserted
    // free-tier. GET /accounts/{id}/subscriptions DOES expose the Workers
    // plan tier live (verified 2026-08-09 against Cloudflare's own API docs
    // + a corroborating community report), but the exact literal
    // rate_plan.id/public_name Cloudflare uses for "Workers Paid" is not
    // published as a closed enum anywhere — matching against a GUESSED
    // string would be exactly the kind of unverified heuristic this
    // platform's classification is supposed to avoid. Also currently
    // `auth_failed`, so nothing is lost by waiting: once that credential is
    // fixed AND a human confirms the real plan tier (or the subscriptions
    // endpoint is wired up and its response shape confirmed against a known
    // account), this can be set to "free-tier" or a genuine live check.
    // apiKeyAccessClass: intentionally omitted, see above.
    noNativeTools: true,
    contextWindow: 32_000,
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    label: "Cloudflare Workers AI",
    // ITS OWN CREDENTIAL, filled by the Cloudflare connect.
    //
    // This read CLOUDFLARE_OAUTH_TOKEN directly, which made the AI tab's row a
    // pointer at another tab ("managed in Compute") and coupled Workers AI to
    // the token that also runs DNS. The connect writes both pairs, so the
    // normal path is unchanged; what this buys is the ability to scope or
    // repoint AI without touching the compute token.
    //
    // A one-shot boot migration seeds these from the compute pair for installs
    // that connected before this split — see loadPlatformSecrets.
    envKey: "CLOUDFLARE_AI_TOKEN",
    // Account id is baked into the path, not sent as a header — resolved at
    // request time via urlParamEnvKey (see resolveProviderUrl in
    // ai-provider-http.ts).
    urlParamEnvKey: "CLOUDFLARE_AI_ACCOUNT_ID",
    chatBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/{urlParam}/ai/v1",
    // Account-scoped model search is authenticated and returns the models
    // available to this Workers AI account. It carries no pricing — vendor
    // pricing is merged in separately from an UNOFFICIAL docs-site feed (see
    // fetchCloudflarePricingFeed in ai-credential-health.ts).
    probe: {
      kind: "cloudflare-models",
      url: "https://api.cloudflare.com/client/v4/accounts/{urlParam}/ai/models/search",
    },
    // Same CLOUDFLARE_OAUTH_TOKEN as Platform secrets (DNS + Workers AI). Connect
    // lives ONLY on Platform secrets → Cloudflare so one consent cannot be
    // forked or overwritten from the AI tab. This row still shows green /
    // models / usage when that token is present.
    credentialManagedElsewhere: {
      note: "Controlled in Platform secrets → Cloudflare",
    },
    openAiCompatible: true,
  },
  {
    id: "ollama",
    noNativeTools: true,
    contextWindow: 32_000,
    keyUrl: "https://ollama.com/settings/keys",
    label: "Ollama",
    envKey: "OLLAMA_API_KEY",
    // Cloud accounts use the same Ollama API on ollama.com. Local Ollama
    // remains separately host-configured and is not probed by the platform.
    chatBaseUrl: "https://ollama.com/v1",
    // /api/tags is public, so it is a catalog-only source and must not be
    // treated as proof that an Ollama API key is valid.
    probe: { kind: "unsupported", catalogUrl: "https://ollama.com/api/tags" },
    openAiCompatible: true,
  },

  // ── OPENAI-COMPATIBLE ENDPOINTS ADDED 2026-08-13 ───────────────────────────────────────────────
  // EVERY ROW BELOW WAS LIVE-PROBED BEFORE IT WAS WRITTEN, and each row records
  // what was measured rather than what the vendor's marketing page claims. The
  // two facts that decide the shape of a row are both measurable without an
  // account, and both were measured for every entry:
  //
  //   1. Does `<base>/models` answer at all, and what does it return?
  //   2. Does it answer 401/403 to a BOGUS bearer token?
  //
  // Only (2) makes an endpoint usable as a credential probe. A models route that
  // answers 200 to a bogus (or absent) token proves the HOST is alive and proves
  // NOTHING about the key, so wiring it to `openai-models` would report a dead or
  // never-set credential as healthy — the exact defect already documented on the
  // nvidia/nous/sambanova/novita rows above. Those endpoints are wired as
  // `catalogUrl` under `kind: "unsupported"` instead, which is honest: model
  // discovery works, credential health is unknown.
  //
  // `contextWindow` is a CONSERVATIVE FLOOR on every row here, deliberately not a
  // vendor-published figure. These are marketplaces whose offered set changes
  // without notice, so the per-model truth is the catalog's own `context_length`
  // (which deriveContextWindow in probe-adapters.ts already reads at discovery
  // time) — see the `contextWindow` doc comment's "WHY MOST ROWS STILL CARRY ONLY
  // A FLOOR" note. Where the live catalog was read, the observed range is
  // recorded in the row's comment so the floor can be checked against it.
  //
  // NOT ADDED, and why — recorded here so the next person does not re-research it:
  //   * writer (api.writer.com) — SKIPPED. The vendor documents `/v1/chat`, not
  //     `/v1/chat/completions`, and the live probe cannot tell which route really
  //     exists: with a bogus bearer, `/v1/models`, `/v1/chat`,
  //     `/v1/chat/completions`, `/v1/chat/completions/bogus` and `/v1/completions`
  //     ALL answer an identical 401 `fail.auth` envelope, while
  //     `/v1/definitely-not-a-real-path` answers 404. So the gateway 404s unknown
  //     PREFIXES but 401s anything under a known one — which means the 401 on
  //     `/v1/chat/completions` is not evidence that the OpenAI-dialect route is
  //     served. Wiring either path would be a guess about the dialect. Revisit
  //     with a real Writer key, which resolves it in one call.
  //   * zai-anthropic (api.z.ai/api/anthropic) — SKIPPED, for two independent
  //     reasons. (a) It would have to share ZAI_API_KEY with the `zai` row, and
  //     the registry does not allow that: ai-provider-registry.vitest.test.ts
  //     asserts envKey uniqueness, and getAiProviderByEnvKey() is a `find` that
  //     would resolve the shared name to whichever row came first. (b) There is
  //     no honest probe for it anyway — `/api/anthropic/v1/models` answers
  //     HTTP 200 with an auth-error BODY (`{"code":401,"msg":"token expired or
  //     incorrect"}`) for a bogus key under both `x-api-key` and `Bearer`, so no
  //     status-code-based probe can tell a live key from a dead one.
  {
    id: "byteplus",
    contextWindow: 32_000,
    keyUrl: "https://console.byteplus.com/ark",
    label: "BytePlus ModelArk",
    envKey: "BYTEPLUS_API_KEY",
    chatBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    // REAL credential probe — MEASURED: bogus bearer → 401
    // `{"error":{"code":"AuthenticationError",…,"type":"Unauthorized"}}`.
    probe: {
      kind: "openai-models",
      url: "https://ark.ap-southeast.bytepluses.com/api/v3/models",
    },
    openAiCompatible: true,
    // apiKeyAccessClass DELIBERATELY NOT free-tier. BytePlus grants 500K free
    // tokens PER MODEL, non-expiring — that is a CREDIT GRANT, not a
    // rate-limited tier: once it is spent the same key keeps working and bills.
    // Declaring it free-tier would make it out-rank metered providers forever on
    // the strength of a one-time balance nobody here can observe. This is the
    // same distinction the cerebras row below now records the hard way.
  },
  {
    id: "scaleway",
    contextWindow: 32_000,
    keyUrl: "https://console.scaleway.com/iam/api-keys",
    label: "Scaleway Generative APIs",
    envKey: "SCALEWAY_API_KEY",
    // EU (Paris) inference. Keys are Scaleway IAM API keys, hence the IAM console.
    chatBaseUrl: "https://api.scaleway.ai/v1",
    // MEASURED: no token → 401; bogus bearer → 403 `{"status":403,
    // "error":"FORBIDDEN","message":"insufficient permissions to access the
    // resource"}`. Both are auth failures to executeProbe (401 and 403 are both
    // default auth-failed statuses), with ONE caveat worth writing down: that
    // 403 body contains the words "insufficient permissions", which trips
    // executeProbe's `entitlementFailure` guard, so a bad Scaleway key reports as
    // provider trouble rather than `auth_failed`. It never reports HEALTHY, which
    // is the property that matters — noted so the next reader does not mistake it
    // for a broken probe.
    probe: { kind: "openai-models", url: "https://api.scaleway.ai/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "hetzner",
    // Hetzner Inference (experiments.hetzner.com) — OpenAI-compatible, served
    // from Hetzner's own DE/FI datacenters. Launched July 2026 as a free,
    // no-SLA "Experiments" product; the only model at time of writing is
    // Qwen/Qwen3.6-35B-A3B-FP8 (MoE, 35B/3B active, 262,144-token context,
    // text + image). Per-key limits: 3M in / 60k out tokens per 60s and
    // 500M in / 5M out per 24h, answered with 429 when exceeded.
    contextWindow: 262_144,
    // NOT the Hetzner Cloud API token (HETZNER_API_KEY, the compute-tab
    // credential). Inference tokens are minted separately at
    // experiments.hetzner.com/inference ("Create API Token"); a Cloud token is
    // rejected here, and an inference token cannot manage servers. Two
    // credentials → two env keys — the io.net split, not the Baseten alias.
    keyUrl: "https://experiments.hetzner.com/inference",
    label: "Hetzner Inference",
    envKey: "HETZNER_INFERENCE_API_KEY",
    chatBaseUrl: "https://inference.hetzner.com/api/v1",
    // MEASURED 2026-08-18: /api/v1/models answers 401 `{"error":"unauthorized"}`
    // both with no token and with a bogus bearer, so a bad key reports
    // `auth_failed` cleanly and never HEALTHY.
    probe: { kind: "openai-models", url: "https://inference.hetzner.com/api/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "ovhcloud",
    contextWindow: 32_000,
    keyUrl: "https://endpoints.ai.cloud.ovh.net/",
    label: "OVHcloud AI Endpoints",
    envKey: "OVH_AI_ENDPOINTS_API_KEY",
    chatBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    // ANONYMOUS ACCESS IS REAL HERE, which is why credentialOptional is set.
    // MEASURED: /v1/models answers 200 with NO token, and a keyless POST to
    // /v1/chat/completions is not rejected as unauthenticated — it answers 429
    // `{"message":"API rate limit exceeded"}`, i.e. the request was ACCEPTED and
    // then throttled against OVH's documented 2 req/min-per-IP anonymous bucket
    // (shared with everyone else on the egress IP, so 429 is the normal keyless
    // outcome from a datacenter address). A key raises the limit; it is not
    // required to be admitted.
    //
    // The catalog is public and rich: {data:[{id, pricing:{prompt,completion},
    // context_length, max_completion_tokens}]} — context_length observed 8,192 →
    // 262,144 across the 20 listed models, and deriveContextWindow reads it, so
    // the 32K row floor only applies to the 3 entries that omit it.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models",
    },
    openAiCompatible: true,
    credentialOptional: true,
  },
  {
    id: "publicai",
    // Real, hard-gated free tier: Public AI is a nonprofit serving
    // publicly-funded open models at no charge, rate-limited (20 RPM) rather
    // than credit-limited — there is no paid plan for it to silently escalate
    // into, which is the property that makes free-tier safe to declare.
    apiKeyAccessClass: "free-tier",
    contextWindow: 32_000,
    keyUrl: "https://platform.publicai.co/",
    label: "Public AI",
    envKey: "PUBLICAI_API_KEY",
    chatBaseUrl: "https://api.publicai.co/v1",
    // REAL credential probe — MEASURED: bogus bearer → 401, RFC 7807 body
    // (`{"type":"https://httpproblems.com/http-status/401","title":
    // "Unauthorized",…}`). The catalog is NOT public here.
    probe: { kind: "openai-models", url: "https://api.publicai.co/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "opencode-zen",
    contextWindow: 32_000,
    keyUrl: "https://opencode.ai/auth",
    label: "OpenCode Zen",
    envKey: "OPENCODE_ZEN_API_KEY",
    chatBaseUrl: "https://opencode.ai/zen/v1",
    // KEYLESS WORKS FOR THE ZERO-COST SUBSET, measured not assumed: a POST to
    // /zen/v1/chat/completions with NO Authorization header and model
    // `nemotron-3.5-lightning-free` returned 200 and a real completion, while the
    // same call for a paid id (`grok-code`) returned 401. Hence credentialOptional.
    //
    // The catalog is public (61 models, id-only shape) and cannot authenticate —
    // catalogUrl only.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://opencode.ai/zen/v1/models",
    },
    openAiCompatible: true,
    credentialOptional: true,
    // apiKeyAccessClass DELIBERATELY NOT free-tier, even though free models
    // exist. The free set is PER MODEL (the `-free` suffixed ids), and this row
    // also serves claude-opus-5 / gpt-5.6 / gemini-3.x at full metered cost. A
    // provider-level free-tier declaration would price the whole catalog at zero
    // and let a routing lane with allowMetered=false spend real money on a
    // frontier model. Per-model zero pricing has no registry expression (see the
    // zai note in ai-zai-pricing.ts, which reaches the same conclusion), and
    // inventing one for a single provider is not a fix.
    //
    // RE-MEASURED 2026-08-20, and both known gaps on this row were re-confirmed rather than fixed:
    //
    // 1. NO AUTHENTICATED PROBE EXISTS. Swept the obvious candidates — /zen/v1/{key,usage,me,
    //    account,credits,balance} all 404, and /zen/v1/models answers 200 WITH A BOGUS BEARER, so
    //    the catalog cannot discriminate a live key from a dead one. The only auth-sensitive
    //    surface is POST /chat/completions, which does return 401 for a bad or absent key — but
    //    with a MISLEADING body: `{"type":"error","error":{"type":"ModelError","message":"Model
    //    grok-code is not supported"}}`, i.e. it reports a model problem while the status reports
    //    an auth one. A POST probe would also cost a real request. It is not wired because the
    //    HEALTHY path has never been observed here (no key), and a probe whose success case is
    //    unexercised is the defect this registry exists to prevent. UNBLOCK: run one POST with a
    //    real key; if it answers non-401, `probe.kind` can become a POST-based credential check.
    //    Until then this row's health is a KNOWN false green — a dead key reports healthy.
    //
    // 2. THE FREE TIER IS REAL BUT UNREACHABLE FROM HERE. Verified live: a keyless POST to
    //    `nemotron-3.5-lightning-free` returned a 200 completion, and 7 of the 63 catalog ids carry
    //    the `-free` suffix. We still cannot route to them: `credentialOptional` only admits a
    //    credential-less row when it ALSO has a `baseUrlEnvKey` (resolve-credential.ts — that
    //    escape is for self-hosted/custom endpoints), and this row has none, so with no key the
    //    provider never enters the candidate pool. Closing that needs per-model access data, and
    //    the catalog cannot supply it: every row is `{id, object, created, owned_by}` — no pricing,
    //    no context window. The only free/paid signal is the SUFFIX ON THE ID STRING, and deciding
    //    what is free by sniffing a model name is exactly the guess the paragraph above refuses.
  },
  {
    id: "tencent",
    contextWindow: 32_000,
    // URL taken verbatim from the vendor's own 401 body, which links it.
    keyUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
    label: "Tencent TokenHub",
    envKey: "TENCENT_TOKENHUB_API_KEY",
    // International endpoint (the mainland host is a different origin).
    chatBaseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    // REAL credential probe — MEASURED: bogus bearer → 401 `{"error":
    // {"type":"gateway_error","code":"401002","message":"The API Key does not
    // exist or signature verification failed…"}}`.
    probe: {
      kind: "openai-models",
      url: "https://tokenhub-intl.tencentcloudmaas.com/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "modelscope",
    // Real, hard-gated free tier: ModelScope's inference API grants 2,000
    // requests/day to a bound account, rate-limited rather than credit-limited.
    apiKeyAccessClass: "free-tier",
    contextWindow: 32_000,
    keyUrl: "https://modelscope.cn/my/myaccesstoken",
    label: "ModelScope",
    envKey: "MODELSCOPE_API_KEY",
    chatBaseUrl: "https://api-inference.modelscope.cn/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token, 43 models,
    // id-only shape with no pricing and no context field) — cannot serve as a
    // credential probe, so it is catalog-only and the row floor is what applies.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api-inference.modelscope.cn/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "upstage",
    contextWindow: 32_000,
    // URL taken verbatim from the vendor's own 401 body, which links it.
    keyUrl: "https://console.upstage.ai/api-keys",
    label: "Upstage Solar",
    envKey: "UPSTAGE_API_KEY",
    chatBaseUrl: "https://api.upstage.ai/v1",
    // REAL credential probe — MEASURED: bogus bearer → 401
    // `{"error":{…,"code":"invalid_api_key"}}`.
    probe: { kind: "openai-models", url: "https://api.upstage.ai/v1/models" },
    openAiCompatible: true,
  },
  // NOTE: the `chutes` row lives further down, in the subscription-lane block —
  // it carries `oauth`/`subscriptionTransport` on top of this api-key shape, so
  // the two 2026-08-13 additions were collapsed onto that richer single row.
  {
    id: "venice",
    contextWindow: 32_000,
    keyUrl: "https://venice.ai/settings/api",
    label: "Venice AI",
    envKey: "VENICE_API_KEY",
    // The doubled `/api` is correct, not a typo: Venice's OpenAI-compatible
    // surface is served at /api/v1 (live-verified).
    chatBaseUrl: "https://api.venice.ai/api/v1",
    // /api/v1/models is live-verified UNAUTHENTICATED (200 with no token, 110
    // models) — catalog only. It carries `context_length` (observed 32,000 →
    // 2,000,000), which deriveContextWindow reads per model; its prices live
    // under a vendor-specific `model_spec.pricing` object that
    // parseModelsListBody does not read, so pricing stays empty rather than wrong.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.venice.ai/api/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "featherless",
    contextWindow: 32_000,
    keyUrl: "https://featherless.ai/account/api-keys",
    label: "Featherless",
    envKey: "FEATHERLESS_API_KEY",
    chatBaseUrl: "https://api.featherless.ai/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token) — catalog
    // only. It is by far the largest catalog wired here: 21,702 community models,
    // each with `context_length` and a generic `pricing:{prompt,completion}`.
    //
    // THE 32K FLOOR IS NOT A HARD FLOOR ON THIS ROW, uniquely — observed
    // context_length spans 2,048 → 262,144. It does not need to be: 21,693 of the
    // 21,702 entries carry the field, so deriveContextWindow supplies per-model
    // truth for all but nine, and pinning the row to the catalog's 2,048 minimum
    // would shrink every prompt to fit the smallest RWKV model in the index.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.featherless.ai/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "redpill",
    contextWindow: 32_000,
    keyUrl: "https://redpill.ai/dashboard",
    label: "RedPill",
    envKey: "REDPILL_API_KEY",
    chatBaseUrl: "https://api.redpill.ai/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token, 66 models)
    // — catalog only. OpenRouter-shaped: `pricing:{prompt,completion,
    // input_cache_read}` as USD-per-single-token strings plus `context_length`
    // (observed 8,191 → 2,000,000), both read by the generic parser.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.redpill.ai/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "ionet",
    contextWindow: 32_000,
    keyUrl: "https://ai.io.net/ai/api-keys",
    label: "io.net Intelligence",
    // NOT `IONET_API_KEY` — that name is already taken, by io.net's COMPUTE
    // integration (packages/compute/src/providers/ionet-provider.ts, which reads
    // it for api.io.net/v1 GPU jobs and has a compute-gpu manifest row). These
    // are two different io.net products with two different API hosts and two
    // different key consoles (cloud.io.net for compute, ai.io.net for
    // Intelligence), so collapsing them onto one env var would assert that one
    // pasted secret authenticates both — an assumption nothing here can verify.
    // This is the Hugging Face situation (two credentials that look like one),
    // not the fal/Baseten one (one credential that grew two names): when the
    // vendor really does issue a single key for both surfaces, the fix is to
    // DELETE this row's key and read the shared one, not to keep both.
    envKey: "IONET_INTELLIGENCE_API_KEY",
    chatBaseUrl: "https://api.intelligence.io.solutions/api/v1",
    // /api/v1/models is live-verified UNAUTHENTICATED (200 with no token, 31
    // models) — catalog only. NOTE the row floor genuinely carries weight here:
    // io.net names its window field `context_window` and its prices
    // `input_token_price`/`output_token_price`, none of which deriveContextWindow
    // or parseModelsListBody read, so nothing is discovered per-model. The
    // observed range is 32,768 → 1,048,576, so 32K is a true floor for every
    // model currently listed.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.intelligence.io.solutions/api/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "akashml",
    contextWindow: 32_000,
    keyUrl: "https://akashml.com/",
    label: "AkashML",
    envKey: "AKASHML_API_KEY",
    chatBaseUrl: "https://api.akashml.com/v1",
    // REAL credential probe — MEASURED: bogus bearer → 401 `{"error":
    // "Unauthorized","message":"Invalid token format. API keys should start with
    // 'akml-'…"}`. The catalog is NOT public here.
    probe: { kind: "openai-models", url: "https://api.akashml.com/v1/models" },
    openAiCompatible: true,
  },
  {
    id: "prime-intellect",
    contextWindow: 32_000,
    keyUrl: "https://app.primeintellect.ai/dashboard/tokens",
    label: "Prime Intellect",
    envKey: "PRIME_INTELLECT_API_KEY",
    chatBaseUrl: "https://api.pinference.ai/api/v1",
    // /api/v1/models is live-verified UNAUTHENTICATED (200 with no token, 116
    // models) — catalog only. Its prices are per-MILLION-token under vendor names
    // (`pricing.input_usd_per_mtok`/`output_usd_per_mtok`), which the generic
    // per-single-token pricing.prompt/completion path does NOT read, so pricing
    // stays empty rather than wrong by a factor of a million. Adding an extractor
    // for it belongs in PROVIDER_PRICING_EXTRACTORS, not in this row.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.pinference.ai/api/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "vercel-gateway",
    contextWindow: 32_000,
    keyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys",
    label: "Vercel AI Gateway",
    envKey: "VERCEL_AI_GATEWAY_API_KEY",
    chatBaseUrl: "https://ai-gateway.vercel.sh/v1",
    // /v1/models is live-verified UNAUTHENTICATED (200 with no token, 328 models)
    // — cannot serve as a credential probe, but it is the richest catalog of the
    // set: name, description, `pricing`, `context_window`, `max_tokens`,
    // `modalities`, `supported_parameters` and reasoning options per model. As
    // with io.net, the window field is `context_window`, which deriveContextWindow
    // does not read (it reads `context_length`), so the row floor is what applies
    // per model today; observed `context_window` spans 480 → 2,000,000 across the
    // 238 entries that declare one, so 32K is a floor for the chat models and
    // deliberately over-states the handful of tiny embedding rows — which are not
    // text-routable candidates anyway.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://ai-gateway.vercel.sh/v1/models",
    },
    openAiCompatible: true,
  },
  {
    id: "router",
    // Ramp Router (router.com) — a ROUTING GATEWAY, not an inference host: it holds the provider
    // credentials and forwards each call to the cheapest approved model clearing a quality bar,
    // across OpenAI, Anthropic, Google Vertex, Fireworks and xAI. Launched 2026-08-19.
    //
    // NOT openAiCompatible, and that is the whole point of this row: Router documents
    // `POST /v1/chat/completions` as UNSUPPORTED — "pointing a Chat Completions client at this
    // base URL will 404". It serves exactly two routes, `GET /v1/models` and `POST /v1/responses`,
    // so it takes `chatDialect: "openai-responses"` and every call — tools or not — is built in the
    // Responses schema. Declaring openAiCompatible here would send both dispatch lanes at a route
    // that does not exist.
    //
    // 1.05M is the top of the published range (models span 131K → 1,048,576); the row value is the
    // usual floor for entries whose catalog omits a window.
    contextWindow: 1_048_576,
    keyUrl: "https://app.router.com/keys",
    label: "Ramp Router",
    envKey: "ROUTER_API_KEY",
    chatBaseUrl: "https://api.router.com/v1",
    chatDialect: "openai-responses",
    // MEASURED 2026-08-20: /v1/models answers 401 `{"error":{"message":"Invalid API key.",
    // "type":"authentication_error","code":"invalid_api_key"}}` — the OpenAI error envelope — both
    // unauthenticated and to a bogus bearer, so a bad key reports auth_failed and never HEALTHY.
    // CAVEAT worth knowing before debugging a 401 here: Router checks auth BEFORE routing, so every
    // path on this host 401s, including nonexistent ones (measured). A 401 is therefore evidence
    // about the KEY only, never about whether a route exists.
    probe: { kind: "openai-models", url: "https://api.router.com/v1/models" },
    // Model ids are ACCOUNT-SCOPED — "each key sees its own set of models" — and Router's docs are
    // explicit that a provider's public model name must never be reused as one. So there is no
    // honest `defaultModel` to pin: the discovered `/v1/models` catalogue for the pasted key is the
    // only valid source, which is the same position the other aggregator rows take.
  },
  {
    id: "reka",
    contextWindow: 32_000,
    keyUrl: "https://app.reka.ai/",
    label: "Reka",
    envKey: "REKA_API_KEY",
    chatBaseUrl: "https://api.reka.ai/v1",
    // REAL credential probe — MEASURED: bogus bearer → 401 `{"detail":"Could not
    // authorize access"}`. (With NO header at all the same route answers 400 and
    // an empty body, which is why the bogus-token measurement is the one that
    // decides this: 400-on-absent is not an auth verdict, 401-on-bogus is.)
    //
    // The OpenAI dialect is CONFIRMED by route existence, not assumed: POST
    // /v1/chat/completions with a bogus bearer answers 401, while
    // /v1/nonexistent-path answers 404 — so this gateway does route-match before
    // authenticating, and the chat-completions route is really there. That same
    // test is what disqualified Writer (see the SKIPPED note at the top of this
    // block), where every path under a known prefix answers 401 alike.
    probe: { kind: "openai-models", url: "https://api.reka.ai/v1/models" },
    openAiCompatible: true,
  },

  {
    id: "custom-openai",
    noNativeTools: true,
    contextWindow: 32_000,
    label: "Custom / private OpenAI-compatible",
    envKey: "CUSTOM_OPENAI_API_KEY",
    baseUrlEnvKey: "CUSTOM_OPENAI_BASE_URL",
    chatBaseUrl: "{baseUrl}",
    probe: { kind: "openai-models", url: "{baseUrl}/models" },
    openAiCompatible: true,
    credentialOptional: true,
  },
  {
    // Platform model deployments (packages/clikmodels + the models domain):
    // a user's own vLLM/llama.cpp/Ollama runtime served on their server or a
    // platform GPU pod, exposed as an OpenAI-compatible endpoint. This row
    // exists so those deployments have a REGISTRY-KNOWN provider id — router
    // candidates and AiInvocation attribution both join this catalog instead
    // of the pseudo-ids ('gpu-pod') that used to join nothing.
    //
    // DELIBERATELY NEVER RESOLVED FROM ENV: there is no single endpoint or
    // key — each candidate is one live ModelDeployment, and its base URL is
    // attached per-candidate at the candidates layer
    // (platform-domains ai-self-hosted-candidates.ts) and dispatched via
    // streamAiChatTurn's per-call `baseUrl` override. The envKey below is a
    // naming placeholder that keeps this row invisible to the normal
    // credential walk (never set ⇒ hasApiKeyCredential is false ⇒ the
    // AI_PROVIDERS candidate walk never emits it on its own).
    id: "self-hosted",
    // None of the serving runtimes clikmodels' runtime-matcher provisions
    // (vLLM/llama.cpp/Ollama as deployed — bare chat-completions, no
    // tool-template guarantees) is configured for native tool calling, so
    // these dispatch through the JSON-envelope protocol like ollama/custom.
    noNativeTools: true,
    contextWindow: 32_000,
    label: "Self-hosted models",
    envKey: "SELF_HOSTED_MODELS_API_KEY",
    chatBaseUrl: "{baseUrl}",
    probe: { kind: "unsupported" },
    openAiCompatible: true,
    credentialOptional: true,
    apiKeyAccessClass: "free-tier",
  },

  // ── AUDIO AND VISUAL PROVIDERS ─────────────────────────────────────────────────────────────────
  // Added so the console can offer them; NOTHING routes to them. Every agent lane selects on
  // `modalities` containing "text" (see textRoutableProviders), because a transcription endpoint
  // cannot answer a chat completion.
  //
  // MODALITIES COME FROM THE SDK'S ACTUAL SURFACE, not from what a vendor is known for — read out of
  // each installed package's own .d.ts. That check earned its keep immediately: @ai-sdk/elevenlabs
  // exposes `transcription` as well as `speech`, and @ai-sdk/luma exposes NO video model at this
  // version despite Luma being a video company, while fal and replicate both do.
  //
  // `probe: unsupported` and NO PRICING, deliberately. AiProviderModel prices in `inMTok`/`outMTok`
  // — dollars per million TOKENS — and these are billed per character (TTS), per audio minute (STT),
  // per image, or per second of video. Writing a per-character price into a per-million-token column
  // would make the console's cost math confidently wrong, which is worse than empty. Metering these
  // needs a unit dimension on that table plus a per-vendor usage reader; until then the honest state
  // is "connectable, not metered".
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    envKey: "ELEVENLABS_API_KEY",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    // REAL credential probe. MEASURED: `xi-api-key: <bogus>` → 401
    // invalid_api_key. With no key the same route answers 404
    // workspace_not_found — which is why authHeader is xi-api-key, not Bearer.
    // Live list is preferred; staticModels is the offline fallback from the
    // installed @ai-sdk/elevenlabs model-id unions.
    // https://elevenlabs.io/docs/api-reference/models/list
    probe: {
      kind: "openai-models",
      url: "https://api.elevenlabs.io/v1/models",
    },
    authHeader: "xi-api-key",
    staticModels: [
      "eleven_v3",
      "eleven_multilingual_v2",
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
      "eleven_monolingual_v1",
      "eleven_multilingual_v1",
      "scribe_v1",
      "scribe_v1_experimental",
      "scribe_v2",
      "scribe_v2_realtime",
    ],
    modalities: ["speech", "transcription"],
  },
  {
    id: "lmnt",
    label: "LMNT",
    envKey: "LMNT_API_KEY",
    keyUrl: "https://app.lmnt.com/account",
    probe: { kind: "unsupported" },
    // No model-list route (verified 404). Ids from @ai-sdk/lmnt LMNTSpeechModelId.
    // /v1/ai/voices is deliberately NOT used — voices are not models.
    staticModels: ["aurora", "blizzard"],
    modalities: ["speech"],
  },
  {
    id: "hume",
    label: "Hume",
    envKey: "HUME_API_KEY",
    keyUrl: "https://platform.hume.ai/settings/keys",
    probe: { kind: "unsupported" },
    // @ai-sdk/hume speech modelId is the empty sentinel '' — surface as default.
    staticModels: ["default"],
    modalities: ["speech"],
  },
  {
    id: "deepgram",
    label: "Deepgram",
    envKey: "DEEPGRAM_API_KEY",
    keyUrl: "https://console.deepgram.com/project",
    probe: { kind: "unsupported" },
    // From @ai-sdk/deepgram transcription + speech model-id unions.
    staticModels: [
      "nova-3",
      "nova-3-general",
      "nova-3-medical",
      "nova-2",
      "nova-2-general",
      "nova-2-meeting",
      "nova-2-phonecall",
      "nova-2-finance",
      "nova-2-conversationalai",
      "nova-2-voicemail",
      "nova-2-video",
      "nova-2-medical",
      "nova",
      "enhanced",
      "base",
      "aura-2-asteria-en",
      "aura-2-thalia-en",
      "aura-2-helena-en",
      "aura-2-orpheus-en",
      "aura-2-zeus-en",
      "aura-asteria-en",
      "aura-luna-en",
      "aura-stella-en",
    ],
    modalities: ["speech", "transcription"],
  },
  {
    id: "revai",
    label: "Rev.ai",
    envKey: "REVAI_API_KEY",
    keyUrl: "https://www.rev.ai/access_token",
    probe: { kind: "unsupported" },
    staticModels: ["machine", "low_cost", "fusion"],
    modalities: ["transcription"],
  },
  {
    id: "gladia",
    label: "Gladia",
    envKey: "GLADIA_API_KEY",
    keyUrl: "https://app.gladia.io/account",
    // Undocumented but live-verified unauthenticated (HTTP 200): an
    // OpenRouter-shaped catalog (tagged "OpenRouter integration spec" in
    // Gladia's own OpenAPI) with a `pricing: {prompt, completion, request}`
    // object per model. prompt/completion match the generic
    // pricing.prompt/completion path in parseModelsListBody; the extra
    // `request` key (Gladia's real per-audio-minute charge) is simply
    // ignored — same reasoning as the fal.ai TODO above (AiDiscoveredModel
    // has no non-token price field).
    probe: {
      kind: "unsupported",
      catalogUrl: "https://api.gladia.io/v1/models",
    },
    staticModels: ["default"],
    modalities: ["transcription"],
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    envKey: "ASSEMBLYAI_API_KEY",
    keyUrl: "https://www.assemblyai.com/app/api-keys",
    probe: { kind: "unsupported" },
    staticModels: ["universal-3-5-pro", "universal-3-pro", "universal-2"],
    modalities: ["transcription"],
  },
  {
    id: "voyage",
    docsPricingCatalog: "voyage",
    label: "Voyage AI",
    envKey: "VOYAGE_API_KEY",
    keyUrl: "https://dashboard.voyageai.com/api-keys",
    probe: { kind: "unsupported" },
    // Embeddings are token-billed but not chat-routable (see isTextRoutable).
    staticModels: [
      "voyage-4-large",
      "voyage-4",
      "voyage-4-lite",
      "voyage-4-nano",
      "voyage-code-3.5",
      "voyage-code-3",
      "voyage-3-large",
      "voyage-3.5",
      "voyage-3.5-lite",
      "voyage-3",
      "voyage-3-lite",
      "voyage-finance-2",
      "voyage-law-2",
      "voyage-multilingual-2",
      "voyage-code-2",
      "voyage-2",
    ],
    modalities: ["embedding"],
  },
  {
    id: "fal",
    unitPricingCatalog: "fal",
    label: "fal.ai",
    envKey: "FAL_API_KEY",
    keyUrl: "https://fal.ai/dashboard/keys",
    probe: { kind: "unsupported" },
    // Curated from @ai-sdk/fal image/video/speech/transcription unions —
    // full catalog is hundreds of routes; these are the ones the SDK types
    // as first-class and the console can offer without a live catalog call.
    staticModels: [
      "fal-ai/flux/dev",
      "fal-ai/flux/schnell",
      "fal-ai/flux-pro/v1.1",
      "fal-ai/flux-pro/v1.1-ultra",
      "fal-ai/flux/krea",
      "fal-ai/recraft/v3/text-to-image",
      "fal-ai/ideogram/character",
      "fal-ai/qwen-image",
      "fal-ai/luma-photon",
      "fal-ai/luma-photon/flash",
      "luma-dream-machine",
      "luma-ray-2",
      "luma-ray-2-flash",
      "minimax-video",
      "hunyuan-video",
      "whisper",
      "wizper",
      "fal-ai/minimax/speech-02-hd",
      "fal-ai/minimax/speech-02-turbo",
      "fal-ai/dia-tts",
    ],
    modalities: ["image", "video", "speech", "transcription"],
  },
  {
    id: "luma",
    label: "Luma",
    envKey: "LUMA_API_KEY",
    keyUrl: "https://lumalabs.ai/dream-machine/api/keys",
    probe: { kind: "unsupported" },
    // Image only at @ai-sdk/luma's current version — no video model exported.
    staticModels: ["photon-1", "photon-flash-1"],
    modalities: ["image"],
  },
  {
    id: "replicate",
    label: "Replicate",
    envKey: "REPLICATE_API_TOKEN",
    keyUrl: "https://replicate.com/account/api-tokens",
    probe: { kind: "unsupported" },
    // Curated from @ai-sdk/replicate image + video model-id unions.
    staticModels: [
      "black-forest-labs/flux-1.1-pro",
      "black-forest-labs/flux-1.1-pro-ultra",
      "black-forest-labs/flux-dev",
      "black-forest-labs/flux-pro",
      "black-forest-labs/flux-schnell",
      "black-forest-labs/flux-2-pro",
      "black-forest-labs/flux-2-dev",
      "ideogram-ai/ideogram-v2",
      "ideogram-ai/ideogram-v2-turbo",
      "recraft-ai/recraft-v3",
      "stability-ai/stable-diffusion-3.5-large",
      "stability-ai/stable-diffusion-3.5-medium",
      "luma/photon",
      "luma/photon-flash",
      "minimax/video-01",
    ],
    modalities: ["image", "video"],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SUBSCRIPTION LANES (added 2026-08-13). One contiguous block on purpose: a
  // parallel branch is appending plain api-key rows to this same file, and a
  // block that neither reorders nor reformats anything above it merges without
  // a conflict.
  //
  // The rule these rows were chosen by: if a subscription-derived credential
  // (OAuth token OR vendor-issued key) can be spent on a DIRECT HTTP call, it
  // is spent that way — no subprocess, real streaming, parseable usage. A
  // harness row is written ONLY where no HTTP surface exists that the
  // credential can reach. Every row below names, in one sentence, WHICH of
  // those two facts put it where it is, so a future reader never has to guess
  // whether "harness" meant "no HTTP exists" or "we did not check".
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "chutes",
    label: "Chutes",
    // Row floor = the SMALLEST real window in the live catalog
    // (Qwen/Qwen3-32B-TEE, 40 960), read from llm.chutes.ai/v1/models on
    // 2026-08-13 — not a guess, and deliberately not the largest.
    contextWindow: 40_960,
    maxOutput: 40_960,
    modelWindows: {
      // The defaultModel's own published pair from that same listing.
      "deepseek-ai/DeepSeek-V3.2-TEE": {
        contextWindow: 131_072,
        maxOutput: 65_536,
      },
    },
    keyUrl: "https://chutes.ai/app/api",
    defaultModel: "deepseek-ai/DeepSeek-V3.2-TEE",
    envKey: "CHUTES_API_KEY",
    chatBaseUrl: "https://llm.chutes.ai/v1",
    chatDialect: "openai-chat",
    authHeader: "bearer",
    openAiCompatible: true,
    // The catalog is PUBLIC — `GET https://llm.chutes.ai/v1/models` answered
    // 200 with the full model list and no Authorization header at all
    // (measured 2026-08-13). An `openai-models` probe against it would
    // therefore report a garbage credential HEALTHY, which is worse than no
    // probe. Same resolution the ollama row reached for the same reason:
    // health stays explicitly unsupported, and the public listing is used only
    // as `catalogUrl`.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://llm.chutes.ai/v1/models",
    },
    oauth: true,
    // DIRECT, and no `oauthChat` override — deliberately, on evidence.
    //
    // Chutes publishes a real OIDC discovery document at
    // https://idp.chutes.ai/.well-known/openid-configuration (fetched
    // 2026-08-13). It advertises issuer https://api.chutes.ai,
    // authorization_code + refresh_token, S256 PKCE, a
    // `token_endpoint_auth_methods_supported` that INCLUDES `none` (so a
    // public client is expressible), and — the reason this row exists — a
    // `chutes:invoke` scope, documented by the vendor as "Make AI API calls".
    //
    // The subscription surface is the SAME OpenAI-compatible host the API key
    // already uses, so there is no second endpoint to declare: `oauthChat`
    // exists for vendors whose subscription traffic goes somewhere else
    // entirely (OpenAI → the Codex backend, Google → Code Assist), and Chutes
    // is not one of them. MEASURED support for that assumption:
    // `POST https://llm.chutes.ai/v1/chat/completions` with a bogus
    // `Authorization: Bearer` answered `401 {"detail":"Invalid token."}` —
    // i.e. this endpoint authenticates a BEARER TOKEN, which is exactly the
    // shape an OIDC access token arrives in, rather than a key-only header.
    //
    // NOT OBSERVED, and stated plainly because the whole point of this comment
    // is that the gap be visible: a real Chutes OAuth access token actually
    // being ACCEPTED by llm.chutes.ai. No token could be minted here (see the
    // platform-ai.json caveat — registration needs an existing Chutes key), and
    // the vendor's own docs never state which host the issued token spends on.
    // If it turns out the token is rejected there, the fix is a `oauthChat`
    // pointing at whatever host does accept it — not a harness, because Chutes
    // publishes no CLI harness at all.
    subscriptionTransport: "direct",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    // MEASURED, not documented: OpenCode publishes no context/output table for
    // the Go plan, so this row carries a conservative floor rather than an
    // invented per-model table.
    contextWindow: 128_000,
    maxOutput: 32_000,
    keyUrl: "https://opencode.ai/auth",
    // From the live Go catalog (25 ids, read 2026-08-13). Chosen because it is
    // the id OpenCode's own Go docs lead with.
    defaultModel: "minimax-m3",
    // Distinct from any key the free/pay-as-you-go Zen row uses: Go is a
    // separate $10/mo plan on a separate base URL, and one env var cannot hold
    // two different subscriptions' keys.
    envKey: "OPENCODE_GO_API_KEY",
    chatBaseUrl: "https://opencode.ai/zen/go/v1",
    chatDialect: "openai-chat",
    authHeader: "bearer",
    openAiCompatible: true,
    // Public catalog again (200, no auth), so the same reasoning as the chutes
    // row above applies: an authenticated-looking probe here would be a
    // false green.
    probe: {
      kind: "unsupported",
      catalogUrl: "https://opencode.ai/zen/go/v1/models",
    },
    // DIRECT, and the strongest evidence of any row in this block — this one
    // needed no inference at all. `POST https://opencode.ai/zen/go/v1/chat/
    // completions` was exercised three ways on 2026-08-13:
    //   no Authorization header       → 401 {"error":{"type":"AuthError",
    //                                        "message":"Missing API key."}}
    //   Authorization: Bearer bogus   → 401 {"error":{"type":"AuthError",
    //                                        "message":"Invalid API key."}}
    //   unknown model id              → 401 ModelError "Model x is not supported"
    // So the endpoint is live, OpenAI-shaped, and reads a BEARER token — the
    // subscription is spendable over plain HTTPS and there is no reason to run
    // a CLI. `opencode run` exists and is fully documented, but a harness row
    // for it would be a subprocess wrapped around this same request.
    //
    // NOT `oauth`: OpenCode has no third-party authorization server. Both Zen
    // and Go end at "copy your API key" from the console at opencode.ai/auth,
    // and `opencode auth login` takes no `--key`/stdin flag, so nothing about
    // the credential is delegable. See this provider's verdict entry.
    //
    // DELIBERATELY SEPARATE from any `opencode-zen` row: Zen is the
    // pay-as-you-go gateway at /zen/v1 (model prefix `opencode/`), Go is the
    // subscription at /zen/go/v1 (prefix `opencode-go/`). Different hosts,
    // different catalogs, different billing — one row could not honestly
    // describe both.
    staticModels: [
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.8-max",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "hy3",
      "hy3-preview",
      "gpt-5.6-luna",
      "grok-4.5",
    ],
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    keyUrl: "https://github.com/settings/copilot",
    // NO chatBaseUrl and NO envKey, and both absences are the finding.
    //
    // RE-CHECKED specifically for an HTTP path before writing this row, because
    // direct is strongly preferred. There is none that a Copilot credential may
    // documentedly reach:
    //   * GitHub Models — the one first-party OpenAI-shaped inference surface
    //     GitHub ever shipped — WAS RETIRED on 2026-07-30, and its own retirement
    //     notice states it is "unrelated to GitHub Copilot services".
    //   * docs.github.com/en/rest/copilot covers seat/user management, usage
    //     metrics and cloud-agent management. None of those runs a model turn.
    //   * The community `api.githubcopilot.com` token exchange is deliberately
    //     NOT adopted: undocumented, and using it means impersonating GitHub's
    //     own editor client — the exact pattern the moonshot/fal verdicts in
    //     ai-provider-oauth-verdicts.ts refuse.
    // So the documented programmatic surfaces are the SDK library and the CLI,
    // and the CLI is the one this platform can drive. Harness by absence of an
    // HTTP endpoint, not by preference.
    probe: { kind: "unsupported" },
    oauth: true,
    subscriptionTransport: "harness",
    // From GitHub's own programmatic-usage examples, which show
    // `--model claude-haiku-4.5` and `--model gpt-5.3-codex` verbatim. Listed
    // rather than discovered because Copilot CLI publishes its model strings
    // only through `copilot help`, and there is no catalog endpoint to read.
    // No `defaultModel`: with none set the harness adapter omits `--model`
    // entirely and the CLI uses the account's own default, which is more
    // correct than pinning one of two examples.
    staticModels: ["claude-haiku-4.5", "gpt-5.3-codex"],
  },
  {
    id: "command-code",
    label: "Command Code",
    keyUrl: "https://commandcode.ai/studio",
    // Harness by absence of an HTTP endpoint, the github-copilot shape above — not by preference.
    // PROBED here (command-code 1.28.4, installed from npm): the package ships a terminal agent and
    // nothing else. There is no published inference base URL, no OpenAI-compatible route, and no
    // API-key env var anywhere in the shipped bundle (grepped: the only CMD_* vars are debug/test
    // and tool-gating flags). The vendor's programmatic surface IS the CLI.
    //
    // envKey is a REAL credential, not a placeholder: `cmdc login` offers "Authorize in browser, or
    // paste API key here", and the key is minted at commandcode.ai/studio. One secret does both
    // jobs — the operator pastes it into the CLI's login inside the container, and records it here
    // so the platform knows this provider is available to route to. Nothing injects it into the
    // CLI: the runner deliberately does not seed credentials (see its own header), so the CLI's own
    // login is still what authenticates it, and a missing login surfaces as the runner's
    // `not-authenticated`, which is diagnosable rather than silent.
    envKey: "COMMAND_CODE_API_KEY",
    // No probe endpoint exists to authenticate against — see above.
    probe: { kind: "unsupported" },
    subscriptionTransport: "harness",
    // NOT `oauth: true`. Command Code's sign-in is a LOOPBACK browser callback
    // (http://localhost:5959/callback?state=…, captured live under a pty), not a device code and
    // not a flow a third party can drive: there is no client registration, no authorization server
    // we hold a client for, and a loopback redirect only works on the machine running the CLI. See
    // this provider's entry in ai-provider-oauth-verdicts.ts.
    //
    // Read from `cmdc --list-models` (56 models, run unauthenticated 2026-08-20) — a sample across
    // the vendors it fronts, not the whole list, for the same reason github-copilot lists two: the
    // catalog is a CLI printout with no endpoint behind it, so a full transcription would rot.
    // No `defaultModel`: the CLI marks `deepseek/deepseek-v4-flash` as its own default, and letting
    // it choose is more correct than pinning one here.
    staticModels: [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k3",
      "zai-org/glm-5.3",
      "minimaxai/minimax-m3",
      "qwen/qwen3.8-max",
    ],
  },

] as const satisfies readonly AiProviderSpec[];

/** Union of every known provider id ('xai' | 'anthropic' | …). */
export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

/** Canonical id list (declaration order) — derived, do not hand-maintain. */
export const AI_PROVIDER_IDS = AI_PROVIDERS.map(
  (p) => p.id,
) as readonly AiProviderId[];
