// ============================================
// AI PROVIDER HTTP (chat + auth headers)
// ============================================
// Shared request builders so every platform service (assistant, enrichment,
// task triage, health probes) hits OAuth and API-key credentials the same way.
// Server-only (no client imports).

import {
  getAiProvider,
  type AiProviderId,
  type AiProviderSpec,
} from "./ai-provider-registry";

/** Substitute a provider's '{accountId}'-style URL placeholder (spec.urlParamEnvKey)
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
  return value ? url.replace("{accountId}", value) : url;
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
}

export interface BuiltChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  dialect: "openai-chat" | "anthropic-messages" | "openai-responses";
}

/** Build a chat request for the provider's dialect (OpenAI chat or Anthropic Messages). */
export function buildAiChatRequest(input: ChatTurnInput): BuiltChatRequest {
  const spec = getAiProvider(input.provider);
  // openai-chat is the DEFAULT dialect, full stop: a row opts out by declaring `chatDialect`.
  // This used to be a ternary on `openAiCompatible || chatBaseUrl` whose two branches were both
  // "openai-chat" — a conditional that could not branch, reading as if those fields selected the
  // dialect when they never did. Keeping the default here (rather than per-row) is what lets the
  // ~30 openai-compatible rows in the registry carry no dialect field at all.
  const dialect = spec?.chatDialect ?? "openai-chat";
  const cred: ResolvedAiCred = {
    apiKey: input.apiKey,
    credentialSource: input.credentialSource,
  };
  const auth = buildAiAuthHeaders(input.provider, cred);

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

  // TOOLS + Responses surface: `/chat/completions` cannot combine function tools with reasoning on
  // newer models (see `responsesPath`). Same credential and auth headers — only the endpoint and the
  // request/response shape differ.
  if (input.tools?.length && spec?.responsesPath) {
    const inputItems = [
      ...input.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
    ];
    if (inputItems.length === 0) inputItems.push({ role: "user", content: "Begin." });
    const instructions = [
      input.system,
      ...input.messages.filter((m) => m.role === "system").map((m) => m.content),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      url: `${base}${spec.responsesPath}`,
      headers: { "Content-Type": "application/json", ...auth },
      body: {
        model: input.model,
        ...(instructions ? { instructions } : {}),
        input: inputItems,
        // Responses names the output cap differently again from both chat variants.
        max_output_tokens: input.maxTokens ?? 700,
        // Tools are FLAT here (name/description/parameters at the top level), not nested under a
        // `function` key the way chat/completions requires.
        tools: input.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
      dialect: "openai-responses",
    };
  }
  const messages = [
    ...(input.system
      ? [{ role: "system" as const, content: input.system }]
      : []),
    ...input.messages,
  ];
  return {
    url: `${base}${spec?.chatPath ?? "/chat/completions"}`,
    headers: {
      "Content-Type": "application/json",
      ...auth,
    },
    body: {
      model: input.model,
      // Only sent when the caller explicitly wants one — see the identical
      // comment on the anthropic-messages branch above. OpenAI's own o3/o4
      // reasoning models reject a non-default temperature the same way some
      // Claude models now reject the param outright; omitting it by default
      // is the one behavior that is safe for every model on every dialect.
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      // Same cap, provider's own parameter name — see `usesMaxCompletionTokens` in the registry.
      ...(spec?.usesMaxCompletionTokens
        ? { max_completion_tokens: input.maxTokens ?? 700 }
        : { max_tokens: input.maxTokens ?? 700 }),
      ...(input.responseFormat
        ? { response_format: input.responseFormat }
        : {}),
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(input.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      messages,
    },
    dialect: "openai-chat",
  };
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
  if (dialect === "openai-responses") {
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
  if (dialect === "openai-responses") {
    // Responses bundles per-item statuses rather than one top-level finish reason; extracting a
    // single value here would mean guessing which item's status represents the turn. Deliberately
    // lossy per-turn rather than guessed.
    return undefined;
  }
  const choices = d.choices as Array<{ finish_reason?: string }> | undefined;
  return choices?.[0]?.finish_reason;
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
  if (dialect === "openai-responses") {
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
