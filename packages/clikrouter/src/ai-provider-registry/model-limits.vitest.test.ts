import { describe, expect, it } from "vitest";
import { modelReasoningEffort, modelTokenLimits } from "./model-limits";
import { DEFAULT_CONTEXT_WINDOW } from "./types";

// ── modelReasoningEffort ──────────────────────────────────────────────────────
//
// This function is the SINGLE load-bearing seam for default reasoning effort:
// streamAiChatTurn sources it (ai-provider-models.ts) rather than inventing a
// value, and the raw-HTTP seam (ai-provider-http.ts) sends what it returns. The
// contract that makes it load-bearing is the `undefined` case — a model that is
// NOT declared reasoning-capable (no `reasoningEffort` on its matched window)
// returns `undefined`, and the caller MUST then send NO reasoning parameter at
// all, because a `reasoning_effort` on a model that does not support it is a hard
// 400 on some vendors (see the `modelWindows` doc comment in types.ts). It had no
// direct unit coverage before this suite; the cases below pin CURRENT behavior
// (real registered provider/model DATA — not fabricated providers), so a change
// to the classifier is a deliberate act with a test to update.
describe("modelReasoningEffort", () => {
  // Real catalog DATA: openai declares reasoningEffort 'low' on the gpt-5.6,
  // gpt-5, o3 and o4 prefixes today. These are the reasoning-capable rows.
  it.each([
    // A model id is the reasoning prefix exactly.
    ["openai", "gpt-5", "low"],
    ["openai", "o3", "low"],
    ["openai", "o4", "low"],
    // …or extends it — model families append dates/sizes to the id, and the
    // longest matching prefix supplies the default.
    ["openai", "gpt-5.6-luna", "low"],
    ["openai", "gpt-5-codex", "low"],
    ["openai", "o4-mini", "low"],
  ] as const)(
    "returns the declared effort for a reasoning-capable model (%s / %s)",
    (provider, model, effort) => {
      expect(modelReasoningEffort(provider, model)).toBe(effort);
    },
  );

  // LONGEST-PREFIX TIE-BREAK. gpt-5.6-luna matches BOTH the "gpt-5.6" and the
  // "gpt-5" reasoning prefixes; the longer one wins — the same convention as
  // modelTokenLimits, exercised here on the reasoning path.
  it("prefers the longest matching reasoning prefix", () => {
    // gpt-5.6-* resolves through the "gpt-5.6" window (contextWindow 1.05M),
    // and that window is the reasoning source — not the shorter "gpt-5" one.
    expect(modelTokenLimits("openai", "gpt-5.6-luna").contextWindow).toBe(1_050_000);
    expect(modelReasoningEffort("openai", "gpt-5.6-luna")).toBe("low");
  });

  // THE LOAD-BEARING NEGATIVE: a model whose matched window carries NO
  // reasoningEffort returns undefined, so the caller sends nothing.
  it.each([
    // gpt-4.1 has a modelWindows entry (1M window) but no reasoningEffort — a
    // matched-but-non-reasoning prefix must not borrow a sibling's effort.
    ["openai", "gpt-4.1"],
    ["openai", "gpt-4.1-mini"],
    // anthropic declares modelWindows but never reasoningEffort on any of them.
    ["anthropic", "claude-opus-5"],
    ["anthropic", "claude-haiku-4-5"],
    // xai has windows without reasoningEffort.
    ["xai", "grok-4.3"],
    // No prefix matches at all → still undefined (openai has no gpt-3 window).
    ["openai", "gpt-3.5-turbo"],
    // Unknown provider → undefined (no spec).
    ["nope-not-a-provider", "gpt-5"],
    // A provider with no modelWindows at all → undefined.
    ["nvidia", "meta/llama-3.1"],
  ] as const)(
    "returns undefined so the caller sends nothing (%s / %s)",
    (provider, model) => {
      expect(modelReasoningEffort(provider, model)).toBeUndefined();
    },
  );

  // String()-trim on the model id: whitespace/empty falls through to no match,
  // which for reasoning means undefined (send nothing).
  it.each([
    ["openai", ""],
    ["openai", "   "],
    ["openai", "\t\n"],
  ] as const)("treats whitespace/empty model id as no reasoning match (%s / %j)", (provider, model) => {
    expect(modelReasoningEffort(provider, model)).toBeUndefined();
  });

  // The contract is literal `undefined`, not `null`/`"none"`/`""` — the seam
  // keys "send nothing" off exactly this value.
  it("returns literal undefined for a non-reasoning model", () => {
    const effort = modelReasoningEffort("anthropic", "claude-sonnet-5");
    expect(effort).toBeUndefined();
    expect(typeof effort).toBe("undefined");
  });
});

// ── modelTokenLimits (edge cases not already pinned by the registry suite) ─────
//
// The main window/prefix behavior is covered in ai-provider-registry.vitest.test.ts;
// these pin the trim/fallback edges and, crucially, that maxOutput is OMITTED
// (property-absent) rather than present-with-undefined — a distinction toEqual
// does not enforce but callers spreading the result depend on.
describe("modelTokenLimits — omission and trim edges", () => {
  it("OMITS maxOutput (property absent) when the provider states none", () => {
    // nvidia declares a contextWindow floor and no maxOutput and no modelWindows.
    const limits = modelTokenLimits("nvidia", "meta/llama-3.1");
    expect(limits.contextWindow).toBe(128_000);
    expect(limits).not.toHaveProperty("maxOutput");
  });

  it("OMITS maxOutput for an unknown provider (default window only)", () => {
    const limits = modelTokenLimits("nope-not-a-provider", "anything");
    expect(limits).toStrictEqual({ contextWindow: DEFAULT_CONTEXT_WINDOW });
    expect(limits).not.toHaveProperty("maxOutput");
  });

  it("keeps maxOutput present when the row supplies one", () => {
    // xai's grok-4.3 window carries only a contextWindow, inheriting the row's
    // 32K maxOutput — so maxOutput IS present.
    const limits = modelTokenLimits("xai", "grok-4.3");
    expect(limits).toStrictEqual({ contextWindow: 1_000_000, maxOutput: 32_000 });
  });

  it("String()-trims the model id, falling through to the provider row", () => {
    // Whitespace ids match no prefix, so both fall back to openai's row floor.
    for (const id of ["", "   ", "\t"]) {
      expect(modelTokenLimits("openai", id)).toStrictEqual({
        contextWindow: 128_000,
        maxOutput: 16_000,
      });
    }
  });
});
