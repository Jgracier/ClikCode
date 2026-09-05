// ============================================
// AI PROVIDER HTTP (chat + auth headers)
// ============================================
// Shared request builders so every platform service (assistant, enrichment,
// task triage, health probes) hits OAuth and API-key credentials the same way.
// Server-only (no client imports).

import { randomUUID } from "node:crypto";
import { toGeminiToolParameters } from "./gemini-schema";
import {
  getAiProvider,
  subscriptionDispatchesDirect,
  type AiProviderId,
  type AiProviderSpec,
} from "./ai-provider-registry";

/**
 * The literal a row writes where ONE operator-supplied path/host segment goes
 * (spec.urlParamEnvKey supplies it: Cloudflare's account id, Bedrock's region).
 *
 * Named after the FIELD, not after one row's use of it. It read `{accountId}`
 * while cloudflare was the only row with a urlParamEnvKey, which made the next
 * row's value — an AWS region — look like it was in the wrong slot.
 */
const URL_PARAM_PLACEHOLDER = "{urlParam}";

/** Substitute `{urlParam}` in a URL template with one already-resolved value.
 *  PURE — no env access — so callers that hold the value directly (the AWS
 *  region discovery in ai-cloud-pricing-catalogs.ts, which probes every
 *  candidate region against the SAME template chat and the health probe use)
 *  cannot drift from the row that declares the template. */
export function substituteUrlParam(url: string, value: string): string {
  return url.replace(URL_PARAM_PLACEHOLDER, value);
}

/** Substitute a provider's '{urlParam}' URL placeholder (spec.urlParamEnvKey)
 *  with its env value. No-op for providers without one. Returns the raw
 *  (unsubstituted) URL when the env var isn't set — the request fails
 *  upstream and the health probe correctly reports it unconfigured. Server-only
 *  (this module is never imported by 'use client' components). */
export function resolveProviderUrl(
  spec: AiProviderSpec | undefined,
  url: string,
): string {
  if (spec?.baseUrlEnvKey) {
    const baseUrl = process.env[spec.baseUrlEnvKey]?.replace(/\/$/, "");
    if (baseUrl) url = url.replace("{baseUrl}", baseUrl);
  }
  if (!spec?.urlParamEnvKey) return url;
  const value = process.env[spec.urlParamEnvKey];
  return value ? substituteUrlParam(url, value) : url;
}

export type AiCredSource = "oauth" | "platform-secret" | "env";

export interface ResolvedAiCred {
  apiKey: string;
  credentialSource: AiCredSource;
}

/** Build Authorization / x-api-key headers for a provider + credential source. */
export function buildAiAuthHeaders(
  provider: string,
  cred: ResolvedAiCred,
  opts: { forProbe?: boolean } = {},
): Record<string, string> {
  const spec = getAiProvider(provider);
  const mode =
    spec?.authHeader ??
    (spec?.chatDialect === "anthropic-messages" ? "auto" : "bearer");
  const token = cred.apiKey;
  const isOauth = cred.credentialSource === "oauth";

  if (!token) return {};

  // `authHeader` describes how the provider takes an API KEY. An OAuth access
  // token is a different kind of credential and every OAuth 2.0 provider takes
  // it as a bearer token — RFC 6750 — so credential source outranks the
  // per-provider key dialect here.
  //
  // MEASURED CLASS OF BUG THIS CLOSES: microsoft-foundry declares
  // `authHeader: "api-key"` (correct for its Foundry API keys) AND `oauth: true`.
  // Connecting the Foundry account mints a Microsoft Entra ID token for
  // scope https://cognitiveservices.azure.com/.default, which Foundry accepts
  // ONLY as `Authorization: Bearer …` (Microsoft Learn, "Configure keyless
  // authentication with Microsoft Entra ID" — every sample there is a bearer
  // token provider, and the api-key header is documented as the key-based
  // alternative). Sent as `api-key`, the Entra token is rejected on every
  // inference call while the AI tab reports the connection healthy — the
  // authenticates-but-cannot-call failure mode.
  if (mode === "api-key" && !isOauth) return { "api-key": token };

  // ElevenLabs takes its key in a vendor-named header and rejects Bearer.
  // MEASURED: GET https://api.elevenlabs.io/v1/models with no header at all
  // answers 404 workspace_not_found (NOT 401) — the API resolves the workspace
  // FROM the key, so an unauthenticated call looks like a missing resource
  // rather than a missing credential. With `xi-api-key: <bogus>` it answers a
  // clean 401 invalid_api_key. That difference is the whole reason this mode
  // exists: sent as Bearer, the key is invisible to ElevenLabs and every probe
  // would come back 404 — classified as a provider error, never as the
  // auth_failed it actually is. Deliberately NOT folded into the `x-api-key`
  // branch below, which is Anthropic-coupled (it injects anthropic-version).
  if (mode === "xi-api-key") return { "xi-api-key": token };

  // Claude account OAuth (Claude Code/claude.ai) uses Bearer authentication
  // plus the OAuth beta capability. API keys continue to use x-api-key.
  if (provider === "anthropic" && isOauth) {
    return {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    };
  }

  if (
    mode === "x-api-key" ||
    (mode === "auto" &&
      (provider === "anthropic" || (isOauth && provider === "anthropic")))
  ) {
    // Anthropic API keys use x-api-key. OAuth account tokens are handled above.
    const headers: Record<string, string> = {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    };
    if (isOauth) {
      // OAuth tokens from claude.ai need the beta capability flag on some routes.
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    return headers;
  }

  if (mode === "auto" && provider === "anthropic") {
    return {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      ...(isOauth ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
    };
  }

  void opts;
  return { Authorization: `Bearer ${token}` };
}

/** One callable tool, dialect-agnostic — translated to each provider's native tool-calling shape. */
export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object type) describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatTurnInput {
  provider: AiProviderId | string;
  model: string;
  apiKey: string;
  credentialSource: AiCredSource;
  system?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** OpenAI response_format; ignored on anthropic-messages. */
  responseFormat?: { type: string };
  stream?: boolean;
  /**
   * Native provider tool-calling (Anthropic `tools` / OpenAI `tools`+function-calling) — the
   * correct way to get structured tool calls out of a model. Prefer this over asking a model to
   * emit JSON in prose and text-parsing the response: models (Claude Haiku included) inconsistently
   * bleed their OWN native tool-use format into a plain-text completion when tool-shaped
   * instructions appear in the prompt but no real `tools` field is set — fighting that with regex
   * is treating a symptom. Pass tools here and read them back via extractToolCalls.
   */
  tools?: AiToolSpec[];
  /**
   * Forces the model to actually invoke one of `tools` rather than legally
   * answering in prose — see AiChatTurnInput.toolChoice in
   * ai-provider-models.ts for the full reasoning. Only meaningful alongside
   * `tools`; ignored when `tools` is absent.
   */
  toolChoice?: "required";
  /**
   * Second identifier some OAuth surfaces require ALONGSIDE the bearer token.
   * Resolved once at credential-resolution time (resolve-credential.ts reads it
   * from the token's own JWT claims per `oauthAccountIdClaim`) rather than
   * re-parsed here, so every dispatch site agrees by construction.
   *
   * Codex rejects the call without it (`chatgpt-account-id`).
   */
  accountId?: string;
  /**
   * Google Code Assist's `project` — `cloudaicompanionProject` from
   * :loadCodeAssist. REQUIRED on that dialect: the endpoint 500s on every
   * request when it is missing, which is a failure mode worth naming because it
   * looks like an outage rather than a malformed request.
   */
  projectId?: string;
}

export interface BuiltChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  dialect:
    | "openai-chat"
    | "anthropic-messages"
    | "openai-responses"
    | "codex-responses"
    | "code-assist";
  /**
   * This surface answers with an SSE stream even when the caller wants one JSON
   * object, so a non-streaming caller MUST aggregate the event stream rather
   * than `await res.json()`. Declared on the built request because only the
   * builder knows the dialect; see aggregateSseResponse().
   */
  alwaysSse?: boolean;
}

/**
 * Split the caller's turn into the (system, non-system) halves every
 * non-chat/completions dialect needs — all three of them hoist system out of
 * the message list rather than carrying it as a role.
 */
function splitSystemAndTurns(input: ChatTurnInput): {
  instructions: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const instructions = [
    input.system,
    ...input.messages.filter((m) => m.role === "system").map((m) => m.content),
  ]
    .filter(Boolean)
    .join("\n\n");
  const turns = input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));
  if (turns.length === 0) turns.push({ role: "user", content: "Begin." });
  return { instructions, turns };
}

/**
 * Build a request against a vendor's SUBSCRIPTION surface (registry `oauthChat`).
 *
 * This is the whole reason an OAuth credential no longer needs the vendor's CLI
 * for these providers: the CLI's only privileged act was knowing this host, these
 * headers and this body shape.
 */
/**
 * One-shot latch for the codex-lane maxTokens drop warning below. Per process,
 * not per call: the drop is a property of the surface, not of any one request,
 * and this builder sits on the hot path of every subscription chat turn.
 */
let warnedCodexMaxTokensDropped = false;

/**
 * The OpenAI `/chat/completions` request BODY. Shared by the API-key path and
 * the `grok-chat` OAuth subscription proxy, which speaks the identical dialect
 * on a different host — factoring it out is what stops the two from drifting.
 */
function openAiChatCompletionsBody(
  input: ChatTurnInput,
  spec: ReturnType<typeof getAiProvider>,
): Record<string, unknown> {
  const messages = [
    ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
    ...input.messages,
  ];
  return {
    model: input.model,
    // Only sent when the caller explicitly wants one — reasoning models reject a
    // non-default temperature; omitting it is safe on every model.
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    // Same cap, provider's own parameter name — see `usesMaxCompletionTokens`.
    ...(spec?.usesMaxCompletionTokens
      ? { max_completion_tokens: input.maxTokens ?? 700 }
      : { max_tokens: input.maxTokens ?? 700 }),
    ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((t) => ({
            type: "function",
            // Google's OpenAI-compatible endpoint validates `parameters` as
            // its own Schema subset too — same projection as the OAuth dialect.
            function:
              spec?.id === "google"
                ? geminiFunctionDeclaration(t)
                : { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(input.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    messages,
  };
}

/** One tool as Gemini declares it: `parameters` omitted for an argument-less tool. */
function geminiFunctionDeclaration(t: AiToolSpec): { name: string; description: string; parameters?: Record<string, unknown> } {
  const parameters = toGeminiToolParameters(t.parameters);
  return { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) };
}

function buildOauthSurfaceRequest(
  input: ChatTurnInput,
  spec: NonNullable<ReturnType<typeof getAiProvider>>,
  auth: Record<string, string>,
): BuiltChatRequest {
  const surface = spec.oauthChat!;
  const base = resolveProviderUrl(spec, surface.baseUrl).replace(/\/$/, "");
  const { instructions, turns } = splitSystemAndTurns(input);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...auth,
    ...(surface.headers ?? {}),
  };

  if (surface.dialect === "grok-chat") {
    // A plain OpenAI `/v1/chat/completions` subscription proxy
    // (xAI's cli-chat-proxy.grok.com): the SAME body the API-key path builds, on
    // a different host, with the pinned headers already merged above
    // (`X-XAI-Token-Auth: xai-grok-cli`) plus the Bearer OAuth token. The one
    // per-request header is `x-grok-model-override`: this proxy routes on the
    // header, NOT the body's `model` field (from the CLI's own shipped docs).
    // Omitted when no model is known — the proxy's default route (grok-build)
    // needs no override. The Bearer token is already proven against this host by
    // the billing adapter in ai-adapters/xai.ts; NOT OBSERVED is a live chat
    // turn, so the response is parsed as the plain openai-chat shape it advertises.
    return {
      url: `${base}${surface.path ?? "/chat/completions"}`,
      headers: {
        ...headers,
        ...(input.model ? { "x-grok-model-override": input.model } : {}),
      },
      body: openAiChatCompletionsBody(input, spec),
      dialect: "openai-chat",
    };
  }

  if (surface.dialect === "code-assist") {
    // The method is a ':'-suffix on the version root, not a path segment.
    // `project` is mandatory — see the registry row and ChatTurnInput.projectId.
    return {
      url: `${base}:generateContent`,
      headers,
      body: {
        model: input.model,
        ...(input.projectId ? { project: input.projectId } : {}),
        // Per-turn identifier the Gemini CLI's own converter.js generates
        // (verified: @google/gemini-cli-core@0.54.4's toGenerateContentRequest
        // wraps every call with one) — a fresh id each turn since it labels
        // THIS prompt, not a stable per-account/per-session value like
        // accountId/projectId above.
        user_prompt_id: randomUUID(),
        request: {
          contents: turns.map((t) => ({
            // Code Assist speaks Vertex roles: the assistant is 'model'.
            role: t.role === "assistant" ? "model" : "user",
            parts: [{ text: t.content }],
          })),
          ...(instructions
            ? { systemInstruction: { role: "user", parts: [{ text: instructions }] } }
            : {}),
          ...(input.tools?.length
            ? {
                tools: [
                  {
                    // Google's Schema subset — see gemini-schema.ts. The raw
                    // zod-produced JSON Schema (`$schema`, additionalProperties,
                    // …) is rejected with HTTP 400 before any model runs.
                    functionDeclarations: input.tools.map((t) => geminiFunctionDeclaration(t)),
                  },
                ],
              }
            : {}),
          ...(input.tools?.length && input.toolChoice === "required"
            ? { toolConfig: { functionCallingConfig: { mode: "ANY" } } }
            : {}),
          generationConfig: {
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            maxOutputTokens: input.maxTokens ?? 700,
          },
        },
      },
      dialect: "code-assist",
    };
  }

  // codex-responses. See the max_output_tokens comment below: a caller-supplied
  // cap cannot be enforced on this surface, and silently eating it would let a
  // caller believe a budget guard exists when it does not. Say the drop out
  // loud (same idiom as the northflank spec.image warn), once per process so a
  // chatty lane does not flood the logs.
  if (input.maxTokens !== undefined && !warnedCodexMaxTokensDropped) {
    warnedCodexMaxTokensDropped = true;
    console.warn(
      `[clikrouter] maxTokens (${input.maxTokens}) cannot be enforced on the ChatGPT-subscription ` +
        `Codex surface and is being dropped: this internal backend rejects the public Responses ` +
        `API's max_output_tokens param (400, verified live 2026-08-10) and no replacement name is ` +
        `documented. The request is sent uncapped. Use an API-key credential if a hard output cap ` +
        `is required.`,
    );
  }

  // codex-responses. Three body fields are NOT optional here, each for its own
  // reason (all three verified against the Codex CLI's own wire format):
  //   store:false   — the backend rejects a stored request outright, so every
  //                   turn must carry the full history (it is stateless).
  //   stream:true   — this surface only streams; see `alwaysSse` below.
  //   instructions  — a system prompt is required, not merely accepted.
  // Content parts must be typed `input_text`; the plain `text` type is rejected.
  return {
    url: `${base}${surface.path ?? "/responses"}`,
    headers: {
      ...headers,
      ...(input.accountId ? { "chatgpt-account-id": input.accountId } : {}),
      // Always SSE, even when the caller wants a single JSON object.
      accept: "text/event-stream",
    },
    body: {
      model: input.model,
      instructions: instructions || "You are a helpful assistant.",
      input: turns.map((t) => ({
        role: t.role,
        content: [
          {
            type: t.role === "assistant" ? "output_text" : "input_text",
            text: t.content,
          },
        ],
      })),
      store: false,
      stream: true,
      // Required for stateless operation with store:false — without it the
      // model's own reasoning cannot be carried across turns.
      include: ["reasoning.encrypted_content"],
      // NOT `max_output_tokens` — that name is the PUBLIC Responses API's
      // param (see the api-key-only branch above, where it's correct). This
      // internal ChatGPT-backend surface rejects it outright: confirmed live
      // 2026-08-10, `400 Unsupported parameter: max_output_tokens`, on the
      // very first real dispatch this surface ever received. No verified
      // replacement name exists yet (this endpoint is undocumented — see the
      // PR's own reviewer note), so omitted rather than guessed. The drop is
      // announced via the one-shot console.warn above rather than swallowed.
      // Before EVER adding a cap back here, re-test against a live ChatGPT
      // OAuth token (not an API key — the api-key branch is a different
      // surface with different rules): (1) send `max_output_tokens` and
      // confirm whether the 400 still reproduces; (2) if it does, try the
      // candidate spelling against a real dispatch and confirm both that the
      // request is accepted AND that the stream actually truncates at the
      // cap — an accepted-but-ignored param is worse than the omission,
      // because it would silence the warn while enforcing nothing.
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(input.tools?.length && input.toolChoice === "required" ? { tool_choice: "required" } : {}),
    },
    dialect: "codex-responses",
    alwaysSse: true,
  };
}

/** Build a chat request for the provider's dialect (OpenAI chat or Anthropic Messages). */
/**
 * Build one request in the OpenAI **Responses** schema.
 *
 * Shared by the two lanes that need that shape — the tools-only detour off
 * `/chat/completions` (`responsesPath`) and rows that speak Responses and nothing else
 * (`chatDialect: "openai-responses"`) — so the body shape has exactly one definition.
 *
 * The field names are the trap this centralizes: Responses takes `input` rather than `messages`,
 * hoists the system prompt to `instructions`, caps output with `max_output_tokens` (a third
 * spelling after `max_tokens` and `max_completion_tokens`), and takes tools FLAT instead of nested
 * under a `function` key.
 */
function buildResponsesRequest(
  input: ChatTurnInput,
  base: string,
  path: string,
  auth: Record<string, string>,
): BuiltChatRequest {
  const inputItems = input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
  // Responses rejects an empty `input`, and a turn can legitimately arrive system-only.
  if (inputItems.length === 0) inputItems.push({ role: "user", content: "Begin." });
  const instructions = [
    input.system,
    ...input.messages.filter((m) => m.role === "system").map((m) => m.content),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    url: `${base}${path}`,
    headers: { "Content-Type": "application/json", ...auth },
    body: {
      model: input.model,
      ...(instructions ? { instructions } : {}),
      input: inputItems,
      // Responses names the output cap differently again from both chat variants.
      max_output_tokens: input.maxTokens ?? 700,
      // Same rule as the other dialects: only sent when the caller asked for one, because
      // reasoning models reject a non-default temperature outright.
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      // Tools are FLAT here (name/description/parameters at the top level), not nested under a
      // `function` key the way chat/completions requires.
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(input.stream ? { stream: true } : {}),
    },
    dialect: "openai-responses",
    // A streamed Responses call answers SSE, and `JSON.parse` on that yields {} — a body that
    // reads as an empty completion rather than a parse failure. Pairing the flag with the reader
    // here is what keeps a streamed turn from silently returning nothing.
    ...(input.stream ? { alwaysSse: true } : {}),
  };
}

export function buildAiChatRequest(input: ChatTurnInput): BuiltChatRequest {
  const spec = getAiProvider(input.provider);
  const cred: ResolvedAiCred = {
    apiKey: input.apiKey,
    credentialSource: input.credentialSource,
  };
  const auth = buildAiAuthHeaders(input.provider, cred);

  // A subscription token may belong on an entirely different surface than the
  // provider's public API — see `oauthChat` in the registry. Checked BEFORE the
  // normal dialect so the override cannot be silently outranked; API-key
  // traffic for the same provider is untouched and still takes the path below.
  if (input.credentialSource === "oauth" && spec?.oauthChat) {
    return buildOauthSurfaceRequest(input, spec, auth);
  }

  // A harness-transport subscription has NO HTTP request to build — the vendor's
  // CLI is its transport. Reaching here with one means a calling lane forgot to
  // route it (see subscriptionUsesHarness's callers), and the cost of continuing
  // is silent: Anthropic's API does answer a Claude subscription token, so this
  // would quietly spend it on an unsupported surface that additionally needs
  // client-spoofing headers to avoid a rate-limited bucket, and nothing would
  // look broken until the 429s started.
  //
  // Throwing makes that a loud failure at the one chokepoint every HTTP dispatch
  // passes through, instead of a safety property five separate call sites each
  // have to remember. The same throw covers a provider with no subscription
  // transport at all, for the same reason: there is no surface to build for.
  //
  // xAI is now a harness row, not a transport-less one, and it is the sharpest
  // case for throwing rather than trying: api.x.ai is MEASURED to answer an xAI
  // OAuth bearer with 403, so an HTTP attempt here cannot succeed — it can only
  // burn the request and mask the fact that the CLI is where that credential is
  // spent.
  if (input.credentialSource === "oauth" && !subscriptionDispatchesDirect(spec)) {
    const transport = spec?.subscriptionTransport ?? "none";
    throw new Error(
      `${input.provider}: a subscription credential cannot be dispatched over HTTP ` +
        `(subscriptionTransport: ${transport}). ` +
        (transport === "harness"
          ? "Route it through the vendor's CLI (runHarnessChat) instead."
          : "This provider has no working subscription dispatch; use an API key."),
    );
  }

  // openai-chat is the DEFAULT dialect, full stop: a row opts out by declaring `chatDialect`.
  // This used to be a ternary on `openAiCompatible || chatBaseUrl` whose two branches were both
  // "openai-chat" — a conditional that could not branch, reading as if those fields selected the
  // dialect when they never did. Keeping the default here (rather than per-row) is what lets the
  // ~30 openai-compatible rows in the registry carry no dialect field at all.
  const dialect = spec?.chatDialect ?? "openai-chat";

  if (dialect === "anthropic-messages") {
    const base = resolveProviderUrl(
      spec,
      spec?.chatBaseUrl || "https://api.anthropic.com",
    ).replace(/\/$/, "");
    // Anthropic: system is a top-level field; messages are user/assistant only.
    const systemParts = [
      input.system,
      ...input.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content),
    ].filter(Boolean);
    const messages = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));
    // Anthropic requires alternating roles starting with user — merge consecutive.
    const merged: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    if (merged.length === 0) merged.push({ role: "user", content: "(empty)" });
    if (merged[0].role !== "user")
      merged.unshift({ role: "user", content: "Continue." });

    return {
      url: `${base}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        ...auth,
      },
      body: {
        model: input.model,
        max_tokens: input.maxTokens ?? 1024,
        // Only sent when the CALLER explicitly wants one. This used to
        // default to 0.2 unconditionally — every caller in the codebase
        // leaves `temperature` unset, so that default was never a deliberate
        // choice anyone made, and some Claude models now reject the param
        // entirely ("temperature is deprecated for this model"), which
        // turned "no opinion" into a hard failure on every call. Omitting it
        // lets the model use its own default, which is strictly safer than
        // guessing a value nobody asked for.
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
        ...(input.tools?.length
          ? {
              tools: input.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
        messages: merged,
      },
      dialect: "anthropic-messages",
    };
  }

  const base = resolveProviderUrl(
    spec,
    spec?.chatBaseUrl || "https://api.openai.com/v1",
  ).replace(/\/$/, "");

  // RESPONSES-ONLY providers: every call takes this surface, tools or not, because there is no
  // `/chat/completions` behind this base URL to fall back to — addressing one 404s. Checked before
  // the tools detour below so the dialect cannot be outranked by a row that also sets
  // `responsesPath`; both end at the same builder, and the dialect is the broader claim.
  if (dialect === "openai-responses") {
    return buildResponsesRequest(input, base, spec?.responsesPath ?? "/responses", auth);
  }

  // TOOLS + Responses surface: `/chat/completions` cannot combine function tools with reasoning on
  // newer models (see `responsesPath`). Same credential and auth headers — only the endpoint and the
  // request/response shape differ.
  //
  // Two DIFFERENT reasons reach the same builder, which is why it is shared rather than inlined:
  // this one moves only tool-carrying calls off a working `/chat/completions`, while a
  // `chatDialect: "openai-responses"` row has no chat-completions route at all. A second copy of
  // the Responses body shape is how the two would drift.
  if (input.tools?.length && spec?.responsesPath) {
    return buildResponsesRequest(input, base, spec.responsesPath, auth);
  }
  return {
    url: `${base}${spec?.chatPath ?? "/chat/completions"}`,
    headers: {
      "Content-Type": "application/json",
      ...auth,
    },
    body: openAiChatCompletionsBody(input, spec),
    dialect: "openai-chat",
  };
}

/**
 * Collapse a Responses-API SSE stream into the single JSON object the
 * non-streaming callers expect.
 *
 * Needed because the Codex subscription surface answers `text/event-stream`
 * unconditionally — `await res.json()` on it yields a parse error, not a body,
 * which reads as a broken provider rather than a streaming one. Returning the
 * stream's own terminal `response` object (rather than a hand-rolled shape) is
 * what lets `codex-responses` reuse every `openai-responses` extractor below
 * without a second parser to keep in sync.
 *
 * Takes the decoded stream TEXT, not a Response, so it is directly testable and
 * has no opinion about how the caller read the body.
 */
export function aggregateResponsesSse(sseText: string): Record<string, unknown> {
  const deltas: string[] = [];
  let completed: Record<string, unknown> | undefined;
  let failed: Record<string, unknown> | undefined;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      // A partial frame at the tail of a truncated stream is not fatal — the
      // deltas collected so far are still a real (if short) answer.
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.completed" || type === "response.incomplete") {
      completed = event.response as Record<string, unknown> | undefined;
    } else if (type === "response.failed" || type === "error") {
      failed = (event.response as Record<string, unknown> | undefined) ?? event;
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    }
  }

  if (completed) return completed;
  // A failed stream must surface as an error body, never as empty prose that
  // the caller would report as a successful blank completion.
  if (failed) return failed;
  // Terminal event missing (truncated stream): synthesize the same Responses
  // shape from the deltas so the extractors still find the text.
  return {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: deltas.join("") }],
      },
    ],
  };
}

/**
 * Read a built request's response body into the JSON object the extractors take,
 * honouring `alwaysSse`. One place decides how to read a body, so a caller can
 * never pick the wrong reader for a dialect.
 */
export async function readAiChatResponseBody(
  built: BuiltChatRequest,
  response: { text: () => Promise<string> },
): Promise<unknown> {
  const raw = await response.text();
  if (built.alwaysSse) return aggregateResponsesSse(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/**
 * Dialects that answer in the Responses-API shape. `codex-responses` is the same
 * wire format on a different host, and aggregateResponsesSse() hands back that
 * exact object — so every extractor treats them as one rather than duplicating
 * the walk over `output[]`.
 */
function isResponsesShaped(dialect: BuiltChatRequest["dialect"]): boolean {
  return dialect === "openai-responses" || dialect === "codex-responses";
}

/** Unwrap Code Assist's envelope: the real Gemini payload sits under `response`. */
function codeAssistPayload(d: Record<string, unknown>): Record<string, unknown> {
  const inner = d.response;
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>)
    : d;
}

/** Parse chat response text from either OpenAI or Anthropic JSON body. */
export function extractChatText(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): string {
  const d = data as Record<string, unknown>;
  if (dialect === "anthropic-messages") {
    const content = d.content as
      | Array<{ type?: string; text?: string }>
      | undefined;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c && (c.type === "text" || c.text))
        .map((c) => c.text || "")
        .join("");
    }
    return "";
  }
  if (dialect === "code-assist") {
    // Vertex/Gemini shape, one envelope deep.
    const candidates = codeAssistPayload(d).candidates as
      | Array<{ content?: { parts?: Array<{ text?: string }> } }>
      | undefined;
    if (!Array.isArray(candidates)) return "";
    return (candidates[0]?.content?.parts ?? [])
      .filter((p) => typeof p?.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  if (isResponsesShaped(dialect)) {
    // Responses returns an `output` ARRAY; assistant prose lives in `message` items as
    // `output_text` parts, interleaved with reasoning and function_call items we ignore here.
    const output = d.output as
      | Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
      | undefined;
    if (!Array.isArray(output)) return "";
    return output
      .filter((item) => item?.type === "message" && Array.isArray(item.content))
      .flatMap((item) => item.content ?? [])
      .filter((part) => part?.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }
  const choices = d.choices as
    | Array<{ message?: { content?: string | Array<unknown> } }>
    | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((item) => extractOpenAiContentText(item))
      .join("");
  }
  return "";
}

/** Parse the raw stop/finish reason from either dialect's response body, when present. */
export function extractStopReason(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): string | undefined {
  const d = data as Record<string, unknown>;
  if (dialect === "anthropic-messages") {
    return typeof d.stop_reason === "string" ? d.stop_reason : undefined;
  }
  if (isResponsesShaped(dialect)) {
    // The terminal `response` object DOES carry a turn-level outcome: `status`
    // ('completed' | 'incomplete' | 'failed' | ...) plus `incomplete_details.reason`
    // when truncated. Mapped exactly the way @ai-sdk/openai's own
    // mapOpenAIResponseFinishReason does (verified against the installed
    // package's dist source): reason 'max_output_tokens' → 'length',
    // 'content_filter' → 'content-filter', no reason on a completed turn →
    // 'tool-calls' when the output contains a function_call, else 'stop'.
    // A body with no `status` at all (e.g. the synthesized fallback
    // aggregateResponsesSse builds from a truncated stream) yields undefined —
    // absent, not invented.
    if (typeof d.status !== "string") return undefined;
    const reason = (d.incomplete_details as { reason?: unknown } | undefined)
      ?.reason;
    if (typeof reason === "string") {
      if (reason === "max_output_tokens") return "length";
      if (reason === "content_filter") return "content-filter";
      return reason;
    }
    if (d.status === "completed") {
      const output = d.output as Array<{ type?: string }> | undefined;
      const hasFunctionCall =
        Array.isArray(output) && output.some((item) => item?.type === "function_call");
      return hasFunctionCall ? "tool-calls" : "stop";
    }
    // 'failed', 'cancelled', 'in_progress', … — the raw status is the truest
    // single word available for the turn.
    return d.status;
  }
  if (dialect === "code-assist") {
    const candidates = codeAssistPayload(d).candidates as
      | Array<{ finishReason?: string }>
      | undefined;
    return candidates?.[0]?.finishReason;
  }
  const choices = d.choices as Array<{ finish_reason?: string }> | undefined;
  return choices?.[0]?.finish_reason;
}

/**
 * The model that ACTUALLY served the call, as the vendor named it in its own response.
 *
 * Not the same question as "which model did we ask for", and the gap between the two is real
 * money. Three ways they diverge, all of them already live in this registry:
 *   - A ROUTING GATEWAY picks the model for you. That is Ramp Router's entire product: you send a
 *     catalogue id and it serves whichever approved model is cheapest right now. Pricing and
 *     per-model stats keyed on the REQUESTED id describe a call that never happened.
 *   - An ALIAS resolves to a dated snapshot — `gpt-5` answering as `gpt-5-2026-…`, which is what
 *     you need when reconciling a bill line against a catalogue row.
 *   - A FALLBACK list (Router's `models:` candidates) silently moves to candidate 2 or 3 after an
 *     upstream 429/502. Without this field, that failover is invisible after the fact.
 *
 * Returned VERBATIM, never normalized or matched against our catalogue — same rule as
 * `stopReason`. It is evidence about what the vendor did, and a cleaned-up version of that is no
 * longer evidence. Undefined when a dialect does not name one, which is not an error.
 */
export function extractServedModel(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): string | undefined {
  // Guarded rather than blind-cast: this reads a body that may be a failed parse ({} from
  // readAiChatResponseBody), a non-object, or — on the SDK lane, where `response.body` is only
  // populated for HTTP transports — undefined. A missing served model is a normal outcome here,
  // never a reason to throw inside result assembly.
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (dialect === "code-assist") {
    // Gemini names it `modelVersion`, one envelope deep — and only sometimes.
    const version = codeAssistPayload(d).modelVersion;
    return typeof version === "string" && version ? version : undefined;
  }
  // Every other dialect here — openai-chat, both Responses surfaces, and anthropic-messages —
  // spells it `model` at the top level of the response body.
  const model = d.model;
  return typeof model === "string" && model ? model : undefined;
}

/**
 * The vendor's service/capacity tier for THIS call, when it names one.
 *
 * Cost-relevant, not cosmetic: OpenAI's `service_tier` distinguishes `flex`/`priority`/`default`
 * capacity at DIFFERENT prices, and Ramp Router's Flex opt-in (`allow_flex_tier`) rides the same
 * field. Two calls to the same model id can bill differently and, without this, look identical in
 * our own records.
 *
 * Verbatim for the same reason as `extractServedModel`. Anthropic and Code Assist publish no
 * equivalent, so undefined there is correct rather than missing.
 */
export function extractServiceTier(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): string | undefined {
  if (dialect === "anthropic-messages" || dialect === "code-assist") return undefined;
  // Same guard as extractServedModel — see its comment.
  if (!data || typeof data !== "object") return undefined;
  const tier = (data as Record<string, unknown>).service_tier;
  return typeof tier === "string" && tier ? tier : undefined;
}

/** Token counts parsed from a response body — the same shape AiChatTurnResult.usage carries. */
export interface AiTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens billed at the FULL rate. Derived here, since both surfaces
   *  report a total that already includes the cached count. */
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  /** Cache-WRITE input tokens. Neither OAuth surface reports one (see
   *  extractUsage), so this stays absent — the field exists to keep this
   *  shape assignable to AiChatTurnResult.usage. */
  cacheWriteInputTokens?: number;
  /** Reasoning tokens, already INCLUDED in `outputTokens`. */
  reasoningTokens?: number;
}

/** A count only when the body actually carries a finite non-negative number — absent otherwise. */
function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Parse token usage from the response bodies the HAND-ROLLED dialects produce.
 * This is what makes an OAuth direct-transport turn (Codex, Code Assist)
 * billable-visible at all: both surfaces report usage on their terminal
 * payload, and until this existed every subscription call recorded zero tokens.
 *
 * - Responses-shaped (`openai-responses` and `codex-responses`, the latter via
 *   aggregateResponsesSse handing back the `response.completed` event's own
 *   `response` object): `usage.input_tokens` / `usage.output_tokens` /
 *   `usage.input_tokens_details.cached_tokens`. `output_tokens` already
 *   INCLUDES `output_tokens_details.reasoning_tokens` (OpenAI's documented
 *   accounting, and how @ai-sdk/openai's own converter treats it), so reasoning
 *   is not re-added to the total — it is now ALSO reported on its own, because
 *   a turn that spends its whole budget on hidden reasoning and returns nothing
 *   is invisible in the combined number.
 *   `uncachedInputTokens` is derived as `input_tokens - cached_tokens`: this
 *   surface bills auto-cached reads at a discount and has no cache-WRITE
 *   charge at all, so there is no third counter to subtract.
 * - `code-assist`: `usageMetadata` one envelope deep —
 *   `promptTokenCount` → input (cache included, per @ai-sdk/google's
 *   convertGoogleUsage, verified in the installed package's dist source),
 *   `candidatesTokenCount + thoughtsTokenCount` → output (thoughts are billed
 *   as output and the AI SDK sums them the same way),
 *   `cachedContentTokenCount` → cachedInput.
 *
 * Every field is mapped only when the body carries it — absent, not invented.
 * Other dialects return {} here: their real dispatch runs through the AI SDK
 * (which reports usage itself), and the remaining hand-rolled chat callers
 * already parse usage via parseAiProviderTokenUsage in platform-domains.
 */
export function extractUsage(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): AiTokenUsage {
  const d = data as Record<string, unknown>;
  if (isResponsesShaped(dialect)) {
    const usage = d.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") return {};
    const details = usage.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    const outDetails = usage.output_tokens_details as
      | Record<string, unknown>
      | undefined;
    const inputTokens = usageCount(usage.input_tokens);
    const outputTokens = usageCount(usage.output_tokens);
    const cachedInputTokens = usageCount(details?.cached_tokens);
    const reasoningTokens = usageCount(outDetails?.reasoning_tokens);
    const uncachedInputTokens =
      inputTokens !== undefined && cachedInputTokens !== undefined
        ? Math.max(0, inputTokens - cachedInputTokens)
        : inputTokens;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(uncachedInputTokens !== undefined ? { uncachedInputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
  }
  if (dialect === "code-assist") {
    const meta = codeAssistPayload(d).usageMetadata as
      | Record<string, unknown>
      | undefined;
    if (!meta || typeof meta !== "object") return {};
    const inputTokens = usageCount(meta.promptTokenCount);
    const candidateTokens = usageCount(meta.candidatesTokenCount);
    const thoughtTokens = usageCount(meta.thoughtsTokenCount);
    const outputTokens =
      candidateTokens !== undefined || thoughtTokens !== undefined
        ? (candidateTokens ?? 0) + (thoughtTokens ?? 0)
        : undefined;
    const cachedInputTokens = usageCount(meta.cachedContentTokenCount);
    const uncachedInputTokens =
      inputTokens !== undefined && cachedInputTokens !== undefined
        ? Math.max(0, inputTokens - cachedInputTokens)
        : inputTokens;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(uncachedInputTokens !== undefined ? { uncachedInputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      // `thoughtsTokenCount` is Google's reasoning counter and is already
      // summed into `outputTokens` above — reported separately for the same
      // reason the Responses surface does.
      ...(thoughtTokens !== undefined ? { reasoningTokens: thoughtTokens } : {}),
    };
  }
  return {};
}

/**
 * Perplexity's chat-completions response (openai-chat dialect, since Perplexity is OpenAI-compatible)
 * carries a nested `usage.cost` object with the EXACT USD Perplexity billed for THIS call —
 * `input_tokens_cost` / `output_tokens_cost` / `reasoning_tokens_cost` / `citation_tokens_cost` /
 * `search_queries_cost` / `request_cost` / `total_cost`, confirmed against
 * docs.perplexity.ai/api-reference/chat-completions-post. `total_cost` is ground truth for the whole
 * call, so it is used as-is rather than summing the components ourselves.
 *
 * USD × 1,000,000 = micro-USD, matching `AiInvocation.costMicroUsd`'s unit (see
 * `estimateAiCostMicroUsd` in ai-routing.ts, whose own comment establishes the same conversion for
 * the token-rate ESTIMATE this is meant to override with a vendor-reported EXACT figure).
 *
 * Returns undefined for every provider/dialect that doesn't carry this field — the caller then falls
 * back to `attributeAiInvocation`'s internal token-count × cached-rate estimate.
 */
export function extractProviderCostMicroUsd(
  provider: string,
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): number | undefined {
  if (provider !== "perplexity" || dialect !== "openai-chat") return undefined;
  const d = data as Record<string, unknown>;
  const usage = d.usage as Record<string, unknown> | undefined;
  const cost = usage?.cost as Record<string, unknown> | undefined;
  const totalCost = cost?.total_cost;
  if (typeof totalCost !== "number" || !Number.isFinite(totalCost)) return undefined;
  return Math.max(0, Math.round(totalCost * 1_000_000));
}

function extractOpenAiContentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (content && typeof content === "object") {
    const value = content as Record<string, unknown>;
    if (typeof value.text === "string") return [value.text];
    const nested = value.content as Array<unknown> | undefined;
    if (Array.isArray(nested)) {
      return nested.flatMap((item) => extractOpenAiContentText(item));
    }
  }
  return [];
}

export interface AiToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Parse native tool calls the model made (see ChatTurnInput.tools) from either dialect's
 *  response shape. Returns [] when the model made none (a plain-text answer). Malformed
 *  argument JSON (OpenAI ships arguments as a string) is skipped rather than thrown. */
export function extractToolCalls(
  dialect: BuiltChatRequest["dialect"],
  data: unknown,
): AiToolCall[] {
  const d = data as Record<string, unknown>;
  if (dialect === "anthropic-messages") {
    const content = d.content as
      | Array<{ type?: string; name?: string; input?: unknown }>
      | undefined;
    if (!Array.isArray(content)) return [];
    return content
      .filter((c) => c?.type === "tool_use" && typeof c.name === "string")
      .map((c) => ({
        name: c.name as string,
        args: c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {},
      }));
  }
  if (dialect === "code-assist") {
    // Gemini returns calls as `functionCall` PARTS, and `args` is already an
    // object — no JSON string to parse, unlike both OpenAI shapes.
    const candidates = codeAssistPayload(d).candidates as
      | Array<{
          content?: {
            parts?: Array<{ functionCall?: { name?: string; args?: unknown } }>;
          };
        }>
      | undefined;
    if (!Array.isArray(candidates)) return [];
    return (candidates[0]?.content?.parts ?? []).flatMap((p) => {
      const call = p?.functionCall;
      if (!call || typeof call.name !== "string") return [];
      return [
        {
          name: call.name,
          args:
            call.args && typeof call.args === "object"
              ? (call.args as Record<string, unknown>)
              : {},
        },
      ];
    });
  }
  if (isResponsesShaped(dialect)) {
    // Each call is a top-level `function_call` item; `arguments` is a JSON STRING as in chat.
    const output = d.output as
      | Array<{ type?: string; name?: string; arguments?: string }>
      | undefined;
    if (!Array.isArray(output)) return [];
    return output.flatMap((item) => {
      if (item?.type !== "function_call" || typeof item.name !== "string") return [];
      try {
        const parsed = JSON.parse(item.arguments || "{}");
        return [{
          name: item.name,
          args: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
        }];
      } catch {
        // Malformed argument JSON — skip this call rather than throw away the whole turn.
        return [];
      }
    });
  }
  const toolCalls = d.choices as
    | Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>
    | undefined;
  const calls = toolCalls?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((c) => {
    const name = c.function?.name;
    if (!name) return [];
    try {
      const args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      return [{ name, args }];
    } catch {
      return [];
    }
  });
}
