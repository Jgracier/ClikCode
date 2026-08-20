// Guard for `promptCaching` — the catalog fact that decides whether the
// dispatch layer is allowed to ATTACH a cache breakpoint to a request.
//
// Two vendor mechanisms wear one name and only one of them is ours to drive:
//
//   explicit  (Anthropic) — the caller marks a breakpoint and pays ~1.25x to
//                           write it. Opt-in, and a real cost decision.
//   automatic (OpenAI, DeepSeek) — the vendor caches a >=1024-token stable
//                           prefix on its own side. No parameter, no opt-out,
//                           no write premium.
//
// If an `automatic` provider were ever marked `explicit`, dispatch would send
// a providerOptions block that vendor does not accept — so this distinction is
// load-bearing, not documentation.

import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, getAiProvider, type AiProviderSpec } from './ai-provider-registry';

describe('promptCaching', () => {
  it('marks Anthropic explicit — the only kind this platform can ask for', () => {
    expect(getAiProvider('anthropic')?.promptCaching).toBe('explicit');
  });

  it('marks OpenAI and DeepSeek automatic, so no toggle may claim to drive them', () => {
    expect(getAiProvider('openai')?.promptCaching).toBe('automatic');
    expect(getAiProvider('deepseek')?.promptCaching).toBe('automatic');
  });

  it('leaves the mechanism ABSENT for providers whose docs state none', () => {
    // Absent is a fact, same as everywhere else in this catalog: it means
    // nobody has read that vendor's caching documentation, which is a
    // different claim from having read it and found no caching. Guessing
    // 'automatic' would assert a discount on the operator's behalf; guessing
    // 'explicit' would send a parameter the vendor rejects.
    const unstated = (AI_PROVIDERS as readonly AiProviderSpec[]).filter(
      (s) => s.promptCaching === undefined,
    );
    expect(unstated.length).toBeGreaterThan(0);
  });

  it('never declares a value outside the two mechanisms that exist', () => {
    for (const spec of AI_PROVIDERS as readonly AiProviderSpec[]) {
      if (spec.promptCaching === undefined) continue;
      expect(['explicit', 'automatic']).toContain(spec.promptCaching);
    }
  });
});
