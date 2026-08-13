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
  },
  {
    id: "anthropic",
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
    // KNOWN STALE: this id 404'd on every routed attempt observed live
    // 2026-08-09 (see ai-provider-models.ts's capturedStreamError comment) —
    // NVIDIA deprecated it. Left in place because no registry/catalog data
    // here names a successor: the live catalogUrl feed is the real model
    // source (the candidate builder routes across every discovered model,
    // this default only pins ordering), and inventing a replacement id
    // without vendor evidence is the same guess that broke this one.
    defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
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
    // Real, hard-gated free tier: 1,000,000 tokens/day, resets daily, no
    // credit card (inference-docs.cerebras.ai/support/pricing, verified
    // 2026-08-08). Past the limit the request 429s — no paid escalation
    // without adding a card, so safe to declare unconditionally free.
    apiKeyAccessClass: "free-tier",
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
    // apiKeyAccessClass DELIBERATELY NOT declared, pending a fix — see below.
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
    // Permanent $0/mo developer tier, 600 RPM, no credit card
    // (sambanova.ai/blog/sambanova-cloud-developer-tier-is-live, verified
    // 2026-08-08) — rate-limit-gated, not credit-gated, so there is no paid
    // plan it silently escalates to. (Separately: a one-time $5/3-month
    // credit also exists on top of this, unrelated to the free tier itself.)
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
    id: "aws-bedrock",
    cloudPricingLookup: "aws-bedrock",
    contextWindow: 200_000,
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    label: "Amazon Bedrock",
    envKey: "AWS_BEDROCK_API_KEY",
    baseUrlEnvKey: "AWS_BEDROCK_BASE_URL",
    chatBaseUrl: "{baseUrl}",
    probe: { kind: "openai-models", url: "{baseUrl}/models" },
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
    envKey: "CLOUDFLARE_OAUTH_TOKEN",
    // Account id is baked into the path, not sent as a header — resolved at
    // request time from CLOUDFLARE_ACCOUNT_ID via urlParamEnvKey (see
    // resolveProviderUrl in ai-provider-http.ts).
    urlParamEnvKey: "CLOUDFLARE_ACCOUNT_ID",
    chatBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
    // Account-scoped model search is authenticated and returns the models
    // available to this Workers AI account. It carries no pricing — vendor
    // pricing is merged in separately from an UNOFFICIAL docs-site feed (see
    // fetchCloudflarePricingFeed in ai-credential-health.ts).
    probe: {
      kind: "cloudflare-models",
      url: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search",
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
] as const satisfies readonly AiProviderSpec[];

/** Union of every known provider id ('xai' | 'anthropic' | …). */
export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

/** Canonical id list (declaration order) — derived, do not hand-maintain. */
export const AI_PROVIDER_IDS = AI_PROVIDERS.map(
  (p) => p.id,
) as readonly AiProviderId[];
