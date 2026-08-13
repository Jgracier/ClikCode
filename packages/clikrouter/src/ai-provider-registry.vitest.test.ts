import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  DEFAULT_CONTEXT_WINDOW,
  isTextRoutable,
  modelTokenLimits,
  type AiProviderSpec,
} from "./ai-provider-registry";

const providers = AI_PROVIDERS as readonly AiProviderSpec[];

describe("AI provider registry", () => {
  it("keeps provider ids and API-key settings unique", () => {
    const ids = providers.map((provider) => provider.id);
    const keys = providers.flatMap((provider) =>
      provider.envKey ? [provider.envKey] : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every provider a model-discovery source", () => {
    for (const provider of providers) {
      // self-hosted's "models" are live ModelDeployment rows enumerated
      // per-candidate (ai-self-hosted-candidates.ts in platform-domains) —
      // there is no static catalog or probeable endpoint to declare here.
      if (provider.id === "self-hosted") continue;
      // Text-routable rows need a chat endpoint (or a configurable base URL).
      // Audio/visual/embedding rows do not — they speak non-chat dialects and
      // are reached through first-party AI SDK packages instead.
      if (isTextRoutable(provider)) {
        expect(
          Boolean(provider.chatBaseUrl || provider.baseUrlEnvKey),
          `${provider.id} is text-routable but has no chat base`,
        ).toBe(true);
      }
      expect(
        Boolean(
          provider.probe.url ||
            provider.probe.catalogUrl ||
            provider.staticModels?.length,
        ),
        `${provider.id} has no model discovery source`,
      ).toBe(true);
    }
  });

  it("includes the expanded direct providers and a future-proof compatible endpoint", () => {
    const ids = new Set(providers.map((provider) => provider.id));
    for (const id of [
      "moonshot",
      "nebius",
      "hyperbolic",
      "novita",
      "alibaba",
      "zai",
      "minimax",
      "ai21",
      "perplexity",
      "aws-bedrock",
      "microsoft-foundry",
      "custom-openai",
      "elevenlabs",
      "deepgram",
      "voyage",
      "fal",
      "luma",
      "replicate",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("keeps Cohere off the native-tools path while /compatibility/v1 rejects tools", () => {
    // TEMPORARY VETO (2026-08-13): every dispatch WITH tools attached to
    // Cohere's /compatibility/v1 endpoint fails with a bare "Not Found"
    // (measured live 2026-08-09 across multiple models), while bare
    // completions work. `noNativeTools: true` keeps the tools payload off
    // that endpoint (tool calls go through the JSON-envelope protocol
    // instead). This pin exists so removing the flag is a deliberate act
    // that comes WITH live verification the endpoint accepts tools — see the
    // cohere row's own comment in providers.ts.
    const cohere = providers.find((p) => p.id === "cohere");
    expect(cohere?.noNativeTools).toBe(true);
  });
});

// ── Per-model token windows ────────────────────────────────────────────────
//
// These numbers decide how much prompt the assistant is allowed to build.
// Under-estimating is silent: the caller just gets a smaller budget than the
// model would have accepted, with nothing anywhere reporting it. So the values
// are pinned, and so is the resolution rule that stopped a context-only
// override from erasing an output cap.
describe("modelTokenLimits", () => {
  it("resolves contextWindow and maxOutput independently", () => {
    // xAI publishes a window for grok-4.3 but no output cap, so the entry
    // carries only contextWindow. maxOutput must still come from the row.
    expect(modelTokenLimits("xai", "grok-4.3")).toEqual({
      contextWindow: 1_000_000,
      maxOutput: 32_000,
    });
  });

  it("falls back to the provider row for an unlisted model", () => {
    expect(modelTokenLimits("xai", "grok-build-0.1")).toEqual({
      contextWindow: 256_000,
      maxOutput: 32_000,
    });
  });

  it("falls back to the default window for an unknown provider", () => {
    expect(modelTokenLimits("nope-not-a-provider", "anything")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
  });

  it("prefers the LONGEST matching prefix, not the first", () => {
    expect(modelTokenLimits("openai", "gpt-5.6-sol").contextWindow).toBe(1_050_000);
    expect(modelTokenLimits("openai", "gpt-5.2").contextWindow).toBe(400_000);
  });

  it("gives every current Anthropic model its real 1M window, including the default", () => {
    for (const model of [
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ]) {
      expect(modelTokenLimits("anthropic", model), model).toEqual({
        contextWindow: 1_000_000,
        maxOutput: 128_000,
      });
    }
    // The 1M window is the DEFAULT now — an id with no `[1m]` suffix gets it.
    expect(modelTokenLimits("anthropic", "claude-opus-5[1m]").contextWindow).toBe(1_000_000);
    // Haiku is genuinely smaller; a real value, not a floor.
    expect(modelTokenLimits("anthropic", "claude-haiku-4-5")).toEqual({
      contextWindow: 200_000,
      maxOutput: 64_000,
    });
  });

  it("keeps the conservative floor where no window is established", () => {
    expect(modelTokenLimits("anthropic", "claude-opus-4-1")).toEqual({
      contextWindow: 200_000,
      maxOutput: 32_000,
    });
  });

  it("never returns a maxOutput larger than its own contextWindow", () => {
    for (const provider of providers) {
      const models = [provider.defaultModel, ...(provider.staticModels ?? [])];
      for (const model of models) {
        if (!model) continue;
        const limits = modelTokenLimits(provider.id, model);
        expect(limits.contextWindow, `${provider.id}/${model}`).toBeGreaterThan(0);
        if (limits.maxOutput !== undefined) {
          expect(limits.maxOutput, `${provider.id}/${model}`).toBeLessThanOrEqual(
            limits.contextWindow
          );
        }
      }
    }
  });
});
