// ============================================
// AI PROVIDER REGISTRY — provider table (canonical order)
// ============================================

import type { AiProviderSpec } from "./types";

/** The model APIs an api-key account can be sent to directly, in canonical order. A
 * provider missing here (an agent CLI naming itself, an audio or image vendor) is not one. */
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
    defaultModel: "grok-4-1-fast",
    label: "Grok (xAI)",
    envKey: "GROK_API_KEY",
    chatBaseUrl: "https://api.x.ai/v1",
    chatDialect: "openai-chat",
  },
  {
    id: "typesafe",
    defaultModel: "jev-latest",
    label: "TypeSafe (Jev)",
    envKey: "TYPESAFE_API_KEY",
    chatBaseUrl: "https://api.typesafe.ai/v1",
  },
  {
    id: "anthropic",
    // Caches NOTHING unless the request carries a cache_control breakpoint, and
    // charges 1.25x to write one — so it pays off only when the marked prefix is
    // reused inside the TTL, which is why this is agent-gated rather than always on.
    promptCaching: "explicit",
    defaultModel: "claude-sonnet-5",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    // Native Messages API — not OpenAI-compatible. chatBaseUrl is the API origin
    // used by the anthropic-messages dialect (assistant + enrichment + triage).
    chatBaseUrl: "https://api.anthropic.com",
    chatDialect: "anthropic-messages",
  },
  {
    id: "openai",
    // Caches on its own for prompts over ~1024 tokens, matching the longest stable
    // PREFIX. No parameter exists to enable or disable it; the only lever is
    // prompt ordering, which is why no agent toggle is offered for it.
    promptCaching: "automatic",
    defaultModel: "gpt-5.1",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    chatBaseUrl: "https://api.openai.com/v1",
    chatDialect: "openai-chat",
  },
  {
    id: "google",
    defaultModel: "gemini-2.5-flash",
    label: "Google",
    // Gemini's OpenAI-compatible surface.
    // https://ai.google.dev/gemini-api/docs/openai
    envKey: "GOOGLE_API_KEY",
    chatBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatDialect: "openai-chat",
  },
  {
    id: "nvidia",
    // No `defaultModel`: the previous pin (nvidia/llama-3.1-nemotron-70b-instruct)
    // 404'd on every routed attempt observed live 2026-08-09 (see
    // ai-provider-models.ts's capturedStreamError comment) — NVIDIA deprecated
    // it. The field is optional, so rather than inventing a replacement id
    // without vendor evidence (the same guess that broke this one), we omit it
    // and require the caller to name one.
    label: "NVIDIA",
    envKey: "NVIDIA_API_KEY",
    chatBaseUrl: "https://integrate.api.nvidia.com/v1",
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
    defaultModel: "llama-3.3-70b-versatile",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    chatBaseUrl: "https://api.groq.com/openai/v1",
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
    defaultModel: "mistral-large-latest",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    chatBaseUrl: "https://api.mistral.ai/v1",
  },
  {
    id: "deepseek",
    // Context caching on disk, activated by the vendor with no request parameter —
    // its published cache-HIT price is the corroboration that it caches at all.
    promptCaching: "automatic",
    defaultModel: "deepseek-chat",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    chatBaseUrl: "https://api.deepseek.com",
  },
  {
    id: "together",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    chatBaseUrl: "https://api.together.xyz/v1",
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
    label: "Fireworks AI",
    envKey: "FIREWORKS_API_KEY",
    chatBaseUrl: "https://api.fireworks.ai/inference/v1",
  },
  {
    id: "deepinfra",
    label: "Deep Infra",
    envKey: "DEEPINFRA_API_KEY",
    chatBaseUrl: "https://api.deepinfra.com/v1/openai",
  },
  {
    id: "baseten",
    label: "Baseten",
    envKey: "BASETEN_API_KEY",
    chatBaseUrl: "https://inference.baseten.co/v1",
  },
  {
    id: "cerebras",
    defaultModel: "llama-3.3-70b",
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    chatBaseUrl: "https://api.cerebras.ai/v1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    chatBaseUrl: "https://openrouter.ai/api/v1",
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
  },
  {
    id: "nous",
    label: "Nous Research",
    envKey: "NOUS_API_KEY",
    chatBaseUrl: "https://inference-api.nousresearch.com/v1",
  },
  {
    id: "cohere",
    defaultModel: "command-a-03-2025",
    label: "Cohere",
    envKey: "COHERE_API_KEY",
    // Cohere's documented OpenAI-compatibility host is api.cohere.ai (not
    // .com); live-verified /models 401s without a key (endpoint exists,
    // requires auth) — free trial keys work here too.
    chatBaseUrl: "https://api.cohere.ai/compatibility/v1",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    envKey: "HUGGINGFACE_API_KEY",
    // Unified Inference Providers router — free serverless tier per model.
    chatBaseUrl: "https://router.huggingface.co/v1",
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
    label: "SambaNova",
    envKey: "SAMBANOVA_API_KEY",
    chatBaseUrl: "https://api.sambanova.ai/v1",
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    envKey: "MOONSHOT_API_KEY",
    chatBaseUrl: "https://api.moonshot.ai/v1",
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    envKey: "NEBIUS_API_KEY",
    chatBaseUrl: "https://api.studio.nebius.ai/v1",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    envKey: "HYPERBOLIC_API_KEY",
    chatBaseUrl: "https://api.hyperbolic.xyz/v1",
  },
  {
    id: "novita",
    label: "Novita AI",
    envKey: "NOVITA_API_KEY",
    chatBaseUrl: "https://api.novita.ai/v3/openai",
  },
  {
    id: "alibaba",
    label: "Alibaba Cloud Model Studio",
    envKey: "DASHSCOPE_API_KEY",
    chatBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "zai",
    label: "Z.AI (GLM)",
    envKey: "ZAI_API_KEY",
    chatBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "minimax",
    label: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    chatBaseUrl: "https://api.minimax.io/v1",
  },
  {
    id: "ai21",
    defaultModel: "jamba-mini",
    label: "AI21 Labs",
    envKey: "AI21_API_KEY",
    chatBaseUrl: "https://api.ai21.com/studio/v1",
  },
  {
    id: "perplexity",
    defaultModel: "sonar",
    label: "Perplexity Sonar",
    envKey: "PERPLEXITY_API_KEY",
    chatBaseUrl: "https://api.perplexity.ai",
    sdkCostMetadataKey: "perplexity",
  },
  {
    // Bedrock's OpenAI-compatible "mantle" endpoint: OpenAI dialect under /v1,
    // one host per region (MEASURED 2026-08-13: 18 regions answer, the rest are
    // NXDOMAIN). Only the region varies, so the row templates the whole base and
    // `urlParamEnvKey` supplies it. No first-party factory: @ai-sdk/amazon-bedrock
    // builds Bedrock-native paths ({base}/model/{id}/converse) off the same base.
    id: "aws-bedrock",
    label: "Amazon Bedrock",
    envKey: "AWS_BEDROCK_API_KEY",
    chatBaseUrl: "https://bedrock-mantle.{urlParam}.api.aws/v1",
    urlParamEnvKey: "AWS_BEDROCK_REGION",
  },
  {
    id: "microsoft-foundry",
    label: "Microsoft Foundry",
    envKey: "AZURE_AI_API_KEY",
    baseUrlEnvKey: "AZURE_AI_BASE_URL",
    chatBaseUrl: "{baseUrl}",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    envKey: "CLOUDFLARE_AI_TOKEN",
    chatBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/{urlParam}/ai/v1",
    urlParamEnvKey: "CLOUDFLARE_AI_ACCOUNT_ID",
  },
  {
    id: "ollama",
    label: "Ollama",
    envKey: "OLLAMA_API_KEY",
    // Cloud accounts use the same Ollama API on ollama.com.
    chatBaseUrl: "https://ollama.com/v1",
  },
  {
    id: "byteplus",
    label: "BytePlus ModelArk",
    envKey: "BYTEPLUS_API_KEY",
    chatBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
  },
  {
    id: "scaleway",
    label: "Scaleway Generative APIs",
    envKey: "SCALEWAY_API_KEY",
    // EU (Paris) inference. Keys are Scaleway IAM API keys, hence the IAM console.
    chatBaseUrl: "https://api.scaleway.ai/v1",
  },
  {
    id: "hetzner",
    label: "Hetzner Inference",
    envKey: "HETZNER_INFERENCE_API_KEY",
    chatBaseUrl: "https://inference.hetzner.com/api/v1",
  },
  {
    id: "ovhcloud",
    label: "OVHcloud AI Endpoints",
    envKey: "OVH_AI_ENDPOINTS_API_KEY",
    chatBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  },
  {
    id: "publicai",
    label: "Public AI",
    envKey: "PUBLICAI_API_KEY",
    chatBaseUrl: "https://api.publicai.co/v1",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    envKey: "OPENCODE_ZEN_API_KEY",
    chatBaseUrl: "https://opencode.ai/zen/v1",
  },
  {
    id: "tencent",
    label: "Tencent TokenHub",
    envKey: "TENCENT_TOKENHUB_API_KEY",
    // International endpoint (the mainland host is a different origin).
    chatBaseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
  },
  {
    id: "modelscope",
    label: "ModelScope",
    envKey: "MODELSCOPE_API_KEY",
    chatBaseUrl: "https://api-inference.modelscope.cn/v1",
  },
  {
    id: "upstage",
    label: "Upstage Solar",
    envKey: "UPSTAGE_API_KEY",
    chatBaseUrl: "https://api.upstage.ai/v1",
  },
  {
    id: "venice",
    label: "Venice AI",
    envKey: "VENICE_API_KEY",
    // The doubled `/api` is correct, not a typo: Venice's OpenAI-compatible
    // surface is served at /api/v1 (live-verified).
    chatBaseUrl: "https://api.venice.ai/api/v1",
  },
  {
    id: "featherless",
    label: "Featherless",
    envKey: "FEATHERLESS_API_KEY",
    chatBaseUrl: "https://api.featherless.ai/v1",
  },
  {
    id: "redpill",
    label: "RedPill",
    envKey: "REDPILL_API_KEY",
    chatBaseUrl: "https://api.redpill.ai/v1",
  },
  {
    id: "eigenai",
    label: "EigenAI",
    envKey: "EIGENAI_API_KEY",
    // docs.eigenai.com/products/model-api/api-reference/base-url (fetched
    // 2026-09-10) settles the base URL that was left open on 2026-07-31:
    // api-web.eigenai.com/api/v1, Bearer auth, OpenAI chat/completions shape.
    // The other host in EigenCloud's launch material (eigenai.eigencloud.xyz)
    // does not resolve.
    chatBaseUrl: "https://api-web.eigenai.com/api/v1",
  },
  {
    id: "ionet",
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
  },
  {
    id: "akashml",
    label: "AkashML",
    envKey: "AKASHML_API_KEY",
    chatBaseUrl: "https://api.akashml.com/v1",
  },
  {
    id: "prime-intellect",
    label: "Prime Intellect",
    envKey: "PRIME_INTELLECT_API_KEY",
    chatBaseUrl: "https://api.pinference.ai/api/v1",
  },
  {
    id: "vercel-gateway",
    label: "Vercel AI Gateway",
    envKey: "VERCEL_AI_GATEWAY_API_KEY",
    chatBaseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  {
    id: "cheaper-inference",
    label: "Cheaper Inference",
    envKey: "CHEAPER_INFERENCE_API_KEY",
    chatBaseUrl: "https://api.cheaperinference.com/v1",
    chatDialect: "openai-chat",
    // The successful response's billing envelope contains the settled charge
    // as a fixed-precision USD string. Preserve it so the caller's credit debit
    // uses the real marketplace bill instead of a catalog estimate.
    responseCostUsdPath: ["cheaper_inference", "billing", "billed_cost_usd"],
  },
  {
    id: "router",
    label: "Ramp Router",
    envKey: "ROUTER_API_KEY",
    chatBaseUrl: "https://api.router.com/v1",
    chatDialect: "openai-responses",
  },
  {
    id: "reka",
    label: "Reka",
    envKey: "REKA_API_KEY",
    chatBaseUrl: "https://api.reka.ai/v1",
  },
  {
    id: "custom-openai",
    label: "Custom / private OpenAI-compatible",
    envKey: "CUSTOM_OPENAI_API_KEY",
    baseUrlEnvKey: "CUSTOM_OPENAI_BASE_URL",
    chatBaseUrl: "{baseUrl}",
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
    // (the calling application's candidates layer) and dispatched via
    // streamAiChatTurn's per-call `baseUrl` override. The envKey below is a
    // naming placeholder that keeps this row invisible to the normal
    // credential walk (never set ⇒ hasApiKeyCredential is false ⇒ the
    // AI_PROVIDERS candidate walk never emits it on its own).
    id: "self-hosted",
    label: "Self-hosted models",
    envKey: "SELF_HOSTED_MODELS_API_KEY",
    chatBaseUrl: "{baseUrl}",
  },
  {
    id: "chutes",
    label: "Chutes",
    defaultModel: "deepseek-ai/DeepSeek-V3.2-TEE",
    envKey: "CHUTES_API_KEY",
    chatBaseUrl: "https://llm.chutes.ai/v1",
    chatDialect: "openai-chat",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    // From the live Go catalog (25 ids, read 2026-08-13). Chosen because it is
    // the id OpenCode's own Go docs lead with.
    defaultModel: "minimax-m3",
    // Distinct from any key the free/pay-as-you-go Zen row uses: Go is a
    // separate $10/mo plan on a separate base URL, and one env var cannot hold
    // two different subscriptions' keys.
    envKey: "OPENCODE_GO_API_KEY",
    chatBaseUrl: "https://opencode.ai/zen/go/v1",
    chatDialect: "openai-chat",
  },
] as const satisfies readonly AiProviderSpec[];
