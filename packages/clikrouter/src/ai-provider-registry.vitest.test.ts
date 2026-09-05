import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  DEFAULT_CONTEXT_WINDOW,
  isTextRoutable,
  modelTokenLimits,
  subscriptionDispatchesDirect,
  subscriptionIsSpendable,
  subscriptionUnsupportedReason,
  subscriptionUsesHarness,
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
      // …unless the row's transport is the vendor's own CLI, in which case there is no HTTP base to
      // declare and demanding one would force a fabricated URL into the registry — the precise
      // defect this suite exists to prevent. Keyed on the declared transport, not on a provider id.
      // github-copilot is the first row in this state (see its registry comment: GitHub retired the
      // only inference endpoint a Copilot credential could ever have reached).
      if (isTextRoutable(provider) && !subscriptionUsesHarness(provider)) {
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

  // xAI's subscription is spent through the vendor's OWN CLI and nothing else. Its CLI proxy
  // (cli-chat-proxy.grok.com) answered every bare-client turn 426 `Grok CLI version (none) is
  // outdated` (prod, 2026-09-05) because it gates on the CLI's own version header, and api.x.ai
  // 403s the bearer on chat — so there is no `oauthChat` (spoofing the header is not a transport)
  // and the row is 'harness', with `@xai-official/grok` baked into the worker image. The
  // load-bearing negatives: no direct surface, no unsupported-reason (it IS spendable), and the
  // subscription's probe is a real CLI turn (`bySource.oauth: harness-turn`), never api.x.ai.
  it("spends xAI's subscription through its CLI harness, probed on that same transport", () => {
    const xai = providers.find((p) => p.id === "xai");
    expect(xai).toBeTruthy();
    expect(xai!.oauth).toBe(true);
    expect(xai!.subscriptionTransport).toBe("harness");
    expect(xai!.oauthChat).toBeUndefined();
    expect(xai!.subscriptionUnsupportedReason).toBeUndefined();
    expect(subscriptionIsSpendable(xai)).toBe(true);
    expect(subscriptionDispatchesDirect(xai)).toBe(false);
    expect(subscriptionUsesHarness(xai)).toBe(true);
    expect(subscriptionUnsupportedReason(xai)).toBeUndefined();
    expect(xai!.probe.bySource?.oauth?.kind).toBe("harness-turn");
    // The API key keeps its own HTTP probe on the developer API.
    expect(xai!.probe.kind).toBe("openai-models");
    expect(xai!.probe.url).toBe("https://api.x.ai/v1/models");
  });

  // The helper is silent for a spendable row and never silent for an unspendable one: a row that
  // forgets its reason still gets a sentence naming the missing datum, so no lane can skip a
  // subscription without saying why.
  it("has a reason for every unspendable subscription and none for a spendable one", () => {
    expect(subscriptionUnsupportedReason(providers.find((p) => p.id === "openai"))).toBeUndefined();
    expect(subscriptionUnsupportedReason(undefined)).toBeUndefined();
    expect(subscriptionUnsupportedReason({ id: "later", oauth: true } as AiProviderSpec)).toMatch(
      /later declares no subscription transport/,
    );
  });

  // huggingface and microsoft-foundry moved from "connectable but unspendable" (subscriptionTransport
  // undefined) to a real DIRECT dispatch: their OAuth flows request an inference-granting scope
  // (inference-api / cognitiveservices.azure.com/.default) and the token spends on the SAME inference
  // host the API key uses, so no `oauthChat` override exists — that is the load-bearing negative,
  // because adding one would wrongly claim a separate subscription surface (the OpenAI/Google case).
  it("spends huggingface and microsoft-foundry directly on their own inference host", () => {
    for (const id of ["huggingface", "microsoft-foundry"]) {
      const spec = providers.find((p) => p.id === id);
      expect(spec, id).toBeTruthy();
      expect(spec!.oauth, id).toBe(true);
      expect(spec!.subscriptionTransport, id).toBe("direct");
      expect(subscriptionIsSpendable(spec), id).toBe(true);
      expect(subscriptionDispatchesDirect(spec), id).toBe(true);
      expect(subscriptionUsesHarness(spec), id).toBe(false);
      // Same host as the API key: no separate subscription surface to declare.
      expect(spec!.oauthChat, id).toBeUndefined();
    }
  });

  // A row that offers `oauth` must either declare HOW that subscription is spent or state WHY it
  // cannot be — otherwise the AI tab ships a connect button that mints a token nothing can use, and
  // nothing anywhere says so. No row is in the second state today (xai was, for the hours between
  // losing its direct surface and its CLI being baked into the worker image — see its row); the list
  // is asserted empty so the next silent one cannot appear without being named here.
  it("leaves no oauth provider without a subscription transport or a stated reason", () => {
    const unspendable: string[] = [];
    for (const provider of providers) {
      if (!provider.oauth) continue;
      if (subscriptionIsSpendable(provider)) {
        expect(provider.subscriptionUnsupportedReason, `${provider.id} is spendable yet carries a reason`).toBeUndefined();
        continue;
      }
      expect(
        provider.subscriptionUnsupportedReason,
        `${provider.id} is oauth:true with no subscriptionTransport and no subscriptionUnsupportedReason`,
      ).toMatch(/\S/);
      unspendable.push(provider.id);
    }
    expect(unspendable).toEqual([]);
  });

  // The harness gate must be provider-agnostic — a row is harness because it DECLARES itself so, with
  // no name check anywhere. Asserted across whatever rows currently declare the harness transport
  // (anthropic today, plus github-copilot) rather than pinned to one provider.
  it("treats every harness-transport subscription identically at the gate", () => {
    const harnessRows = providers.filter((p) => p.subscriptionTransport === "harness");
    expect(harnessRows.length).toBeGreaterThan(0);
    for (const p of harnessRows) {
      expect(subscriptionUsesHarness(p), p.id).toBe(true);
      expect(subscriptionDispatchesDirect(p), p.id).toBe(false);
      expect(subscriptionIsSpendable(p), p.id).toBe(true);
    }
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
