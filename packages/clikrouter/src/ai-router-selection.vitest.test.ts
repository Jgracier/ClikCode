import { describe, expect, it } from 'vitest';
import {
  selectRouterCandidate,
  isLikelyChatModel,
  isFillInMiddleModel,
  resolveChatCapable,
  rankRouterCandidatesWithScores,
  type AiRouterCandidate,
} from './ai-router-selection';

describe('selectRouterCandidate', () => {
  // NOTE: capability (intelligence) is real-evidence-only now — see the
  // 'agenticIndex + trackRecordSuccessRate' describe block below. These
  // candidates therefore no longer rely on a name looking "smart"; each test
  // attaches an explicit agenticIndex wherever it needs to test a genuine
  // capability difference, exactly the way a real caller would (from
  // ai-openrouter-benchmarks.ts's live data).
  const candidates: AiRouterCandidate[] = [
    { provider: 'openrouter', model: 'openrouter/claude-sonnet-4', accessClass: 'subscription', estimatedCostPerMTok: 0.8, agenticIndex: 90 },
    { provider: 'openrouter', model: 'openrouter/gemini-flash', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, agenticIndex: 40 },
    { provider: 'openrouter', model: 'openrouter/llama-3.1-8b', accessClass: 'free-tier', estimatedCostPerMTok: 0.05, agenticIndex: 20 },
    { provider: 'openrouter', model: 'openrouter/claude-haiku-4', accessClass: 'metered', estimatedCostPerMTok: 0.2, agenticIndex: 60 },
  ];

  it('prefers lower-cost free-tier models in budget mode', () => {
    const selected = selectRouterCandidate(candidates, 'budget');
    expect(selected?.model).toBe('openrouter/llama-3.1-8b');
  });

  it('prefers stronger REAL intelligence in frontier mode', () => {
    const selected = selectRouterCandidate(candidates, 'frontier');
    expect(selected?.model).toBe('openrouter/claude-sonnet-4');
  });

  it('balances intelligence and cost in auto mode', () => {
    const selected = selectRouterCandidate(candidates, 'auto');
    expect(selected?.model).toBe('openrouter/claude-sonnet-4');
  });

  it('budget mode picks the cheapest option in the cheapest access tier, not the smartest one', () => {
    // Both free-tier: a genuinely smarter (higher agenticIndex) but pricier
    // option vs a plain cheaper one. Budget's whole point is cost — it must
    // not pick the pricier "smart" model.
    const budgetCandidates: AiRouterCandidate[] = [
      { provider: 'x', model: 'llama-3.1-70b', accessClass: 'free-tier', estimatedCostPerMTok: 0.5, agenticIndex: 80 },
      { provider: 'x', model: 'some-tiny-model', accessClass: 'free-tier', estimatedCostPerMTok: 0.05, agenticIndex: 20 },
    ];
    const selected = selectRouterCandidate(budgetCandidates, 'budget');
    expect(selected?.model).toBe('some-tiny-model');
  });

  it('does not rank an unbenchmarked model below one with a real but low capability score', () => {
    // Real negative evidence (a genuine low agentic_index) must still rank
    // below a model with NO evidence at all — "unknown" is neutral (50),
    // never favored or disfavored relative to a real low measurement.
    const unknownCandidates: AiRouterCandidate[] = [
      { provider: 'newvendor', model: 'some-brand-new-model', accessClass: 'metered', estimatedCostPerMTok: 1 },
      { provider: 'x', model: 'measured-weak-model', accessClass: 'metered', estimatedCostPerMTok: 1, agenticIndex: 15 },
    ];
    const selected = selectRouterCandidate(unknownCandidates, 'frontier');
    expect(selected?.model).toBe('some-brand-new-model');
  });

  describe('auto mode: unpriced subscription access must not be cost-penalized', () => {
    it('lets a smarter subscription flagship with no per-token price beat a weaker priced free-tier model', () => {
      // OAuth subscriptions genuinely have no per-token price — costScore's
      // 1_000_000 "no price on file" sentinel is correct as budget/frontier's
      // TIEBREAK (they sort by accessRank/intelligence first) but used to leak
      // into auto's linear blend as a flat -10,000, crushing every unpriced
      // subscription candidate regardless of intelligence. Observed live:
      // anthropic/claude-sonnet-4-5 and openai/gpt-5.6 both scored ~-9,878.
      const candidates: AiRouterCandidate[] = [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          accessClass: 'subscription',
          estimatedCostPerMTok: null,
          avgLatencyMs: 3000,
          agenticIndex: 90,
        },
        {
          provider: 'huggingface',
          model: 'Qwen/Qwen3.5-27B',
          accessClass: 'free-tier',
          estimatedCostPerMTok: 2.7,
          avgLatencyMs: 3000,
          agenticIndex: 40,
        },
      ];
      const selected = selectRouterCandidate(candidates, 'auto');
      expect(selected?.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('still prefers free-tier over subscription when intelligence is genuinely equal', () => {
      // accessRank's own -0/-10 spread should still decide equal-intelligence
      // ties — the fix removes cost as a SEPARATE penalty for subscription/
      // free-tier, it does not remove accessRank's preference for free.
      const candidates: AiRouterCandidate[] = [
        { provider: 'openai', model: 'gpt-4o', accessClass: 'subscription', estimatedCostPerMTok: null, avgLatencyMs: 3000, agenticIndex: 70 },
        {
          provider: 'huggingface',
          model: 'qwen2.5-72b',
          accessClass: 'free-tier',
          estimatedCostPerMTok: 2.7,
          avgLatencyMs: 3000,
          agenticIndex: 70,
        },
      ];
      const selected = selectRouterCandidate(candidates, 'auto');
      expect(selected?.model).toBe('qwen2.5-72b');
    });

    it('still penalizes cost normally for metered/unknown access, where it is a real per-call charge', () => {
      const candidates: AiRouterCandidate[] = [
        { provider: 'x', model: 'expensive-but-smart', accessClass: 'metered', estimatedCostPerMTok: 100, avgLatencyMs: 3000 },
        { provider: 'y', model: 'cheap-and-smart', accessClass: 'metered', estimatedCostPerMTok: 1, avgLatencyMs: 3000 },
      ];
      const selected = selectRouterCandidate(candidates, 'auto');
      expect(selected?.model).toBe('cheap-and-smart');
    });
  });

  describe('live latency', () => {
    it('prefers the observably faster candidate in auto mode when otherwise tied', () => {
      const tied: AiRouterCandidate[] = [
        { provider: 'x', model: 'gpt-5.1', accessClass: 'metered', estimatedCostPerMTok: 1, avgLatencyMs: 8_000 },
        { provider: 'y', model: 'gpt-5.1', accessClass: 'metered', estimatedCostPerMTok: 1, avgLatencyMs: 800 },
      ];
      const selected = selectRouterCandidate(tied, 'auto');
      expect(selected?.provider).toBe('y');
    });

    it('does not let a confirmed-slow candidate outrank one with no latency data yet', () => {
      // Unknown must be neutral, not "assumed fastest" — a brand-new candidate
      // should not automatically beat a proven-fast one, but a proven-SLOW one
      // (well above the neutral default) should lose to an unmeasured candidate.
      const candidates: AiRouterCandidate[] = [
        { provider: 'slow', model: 'gpt-5.1', accessClass: 'metered', estimatedCostPerMTok: 1, avgLatencyMs: 20_000 },
        { provider: 'unmeasured', model: 'gpt-5.1', accessClass: 'metered', estimatedCostPerMTok: 1 },
      ];
      const selected = selectRouterCandidate(candidates, 'auto');
      expect(selected?.provider).toBe('unmeasured');
    });

    it('never lets latency override cost as budget mode\'s primary key', () => {
      const candidates: AiRouterCandidate[] = [
        { provider: 'fast-expensive', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 5, avgLatencyMs: 100 },
        { provider: 'slow-cheap', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, avgLatencyMs: 15_000 },
      ];
      const selected = selectRouterCandidate(candidates, 'budget');
      expect(selected?.provider).toBe('slow-cheap');
    });
  });
});

describe('isLikelyChatModel', () => {
  // Real ids observed live (clikdeploy admin ai chat --explain) ranked as
  // router candidates for a plain text chat request, despite being unable to
  // answer one — the gap this function closes for MIXED-modality providers
  // (isTextRoutable already excludes an entirely non-text provider like
  // voyage or deepgram at the provider level, so those aren't repeated here).
  const nonChat = [
    'mistral/voxtral-mini-tts-2603',
    '@cf/black-forest-labs/flux-1-schnell',
    'groq/whisper-large-v3-turbo',
    '@cf/baai/bge-base-en-v1.5',
    '@cf/baai/bge-reranker-base',
    '@cf/deepgram/aura-1',
    '@cf/meta/llama-guard-3-8b',
    'openai/omni-moderation',
    'minimax/speech-02-hd',
    '@cf/microsoft/resnet-50',
    '@cf/meta/m2m100-1.2b',
    '@cf/google/embeddinggemma-300m',
    'mistral-ocr',
    // Generic "-video" naming the original image/video pattern missed —
    // it only matched "video-01"/"minimax-video", not xai's own naming.
    'grok-imagine-video',
    'grok-imagine-video-1.5',
    // MEASURED 2026-08-10: the exact ids cliknet's remediation agent routed EVERY run to,
    // for the whole 20-app fleet, while trying to propose code fixes. Mistral's `voxtral`
    // is its audio family. The list above already contained `voxtral-mini-tts-2603`, but
    // that was excluded by the `-tts-` pattern — the plain audio ids carry no `tts` marker
    // and sailed through, so the family itself was never actually recognized.
    'mistral/voxtral-small-latest',
    'voxtral-small-2507',
    'voxtral-mini-latest',
    // Other audio families with no `tts`/`whisper` marker in the name.
    'qwen2-audio-7b-instruct',
    'gpt-4o-audio-preview',
  ];
  for (const id of nonChat) {
    it(`excludes ${id}`, () => expect(isLikelyChatModel(id)).toBe(false));
  }

  // The failure mode to guard against: a real chat model whose name merely
  // CONTAINS a non-chat-looking substring must not be excluded.
  const chat = [
    'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
    'anthropic/claude-opus-5',
    'Qwen/Qwen3-VL-30B-A3B-Instruct', // "VL" (vision-language), not video/image generation
    '@cf/nvidia/nemotron-3-120b-a12b',
    'amazon.nova-pro-v1', // "nova" also names Deepgram's ASR product; this is Amazon's chat model
    // Guards the widened audio patterns against false negatives: none of these are audio
    // models, and each contains a substring the new patterns could over-match on.
    'mistral-large-2407',
    'claude-sonnet-5',
    'gpt-5-codex',
  ];
  for (const id of chat) {
    it(`keeps ${id}`, () => expect(isLikelyChatModel(id)).toBe(true));
  }
});

describe('resolveChatCapable', () => {
  it('trusts the vendor-published field over the name heuristic when present', () => {
    // A name the heuristic would exclude, but the vendor's own catalog says is text-output.
    expect(resolveChatCapable({ id: '@cf/some-vendor/new-tts-family-chat-model', chatCapable: true })).toBe(true);
    // A name the heuristic would keep, but the vendor's own catalog says is not text-output.
    expect(resolveChatCapable({ id: 'plain-looking-name', chatCapable: false })).toBe(false);
  });

  it('falls back to the name heuristic when the vendor publishes no modality field', () => {
    expect(resolveChatCapable({ id: 'grok-imagine-video' })).toBe(false);
    expect(resolveChatCapable({ id: 'anthropic/claude-opus-5' })).toBe(true);
  });

  it('vetoes a fill-in-the-middle model EVEN when the vendor explicitly claims chatCapable:true', () => {
    // MEASURED LIVE 2026-08-10: Mistral publishes chatCapable:true for
    // mistral-code-fim-latest — the one case where the vendor field does
    // NOT win, because it's answering "is this reachable via our
    // chat/completions endpoint", not "does this accept a chat-turns
    // request" (FIM models take prompt/suffix, not chat turns).
    expect(resolveChatCapable({ id: 'mistral-code-fim-latest', chatCapable: true })).toBe(false);
  });
});

describe('isFillInMiddleModel', () => {
  const fim = ['mistral-code-fim-latest', 'codestral-fim-2508', 'some-model-fim', 'fim-completion-v2'];
  for (const id of fim) {
    it(`flags ${id}`, () => expect(isFillInMiddleModel(id)).toBe(true));
  }

  const notFim = ['claude-opus-5', 'gpt-5.6-sol', 'confirmation-model', 'infimum-7b'];
  for (const id of notFim) {
    it(`does not false-positive on ${id}`, () => expect(isFillInMiddleModel(id)).toBe(false));
  }
});

describe('agenticIndex + trackRecordSuccessRate — capability is REAL EVIDENCE ONLY, never a name guess', () => {
  it('two candidates with no capability evidence at all tie on intelligence (50, neutral) regardless of name', () => {
    // This is the whole point of removing the regex heuristic: "claude-opus-5"
    // must NOT outrank "some-random-model-id" on intelligence just because one
    // name looks more impressive — with no real evidence for either, they are
    // equally unknown.
    const candidates: AiRouterCandidate[] = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'subscription', estimatedCostPerMTok: null },
      { provider: 'nobody-has-heard-of-this', model: 'some-random-model-id', accessClass: 'subscription', estimatedCostPerMTok: null },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.intelligence).toBe(50);
    expect(ranked[1]!.intelligence).toBe(50);
  });

  it('a real agentic_index is used directly, and can rank BELOW the neutral default for an unverified model', () => {
    // The exact scenario that motivated this change: a genuinely low
    // measured score (nvidia's Nemotron-3-Nano scored 2 live) must still
    // rank below a model nobody has benchmarked — a real negative signal is
    // not something the neutral default should protect a model from.
    const candidates: AiRouterCandidate[] = [
      { provider: 'nvidia', model: 'nemotron-3-nano', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 2 },
      { provider: 'unbenchmarked', model: 'whatever', accessClass: 'free-tier', estimatedCostPerMTok: 0 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.candidate.provider).toBe('unbenchmarked');
    expect(ranked[0]!.intelligence).toBe(50);
    expect(ranked[1]!.candidate.provider).toBe('nvidia');
    expect(ranked[1]!.intelligence).toBe(2);
  });

  it('a real HIGH agentic_index correctly outranks the neutral default', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'anthropic', model: 'claude-opus-5', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 59.2 },
      { provider: 'unbenchmarked', model: 'whatever', accessClass: 'subscription', estimatedCostPerMTok: null },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.candidate.provider).toBe('anthropic');
    expect(ranked[0]!.intelligence).toBe(59.2);
  });

  it('arenaScore fills intelligence when agenticIndex is absent — the SECOND real source, not a name guess', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'google', model: 'gemini-2.5-pro', accessClass: 'subscription', estimatedCostPerMTok: null, arenaScore: 96.5 },
      { provider: 'unbenchmarked', model: 'whatever', accessClass: 'subscription', estimatedCostPerMTok: null },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.candidate.provider).toBe('google');
    expect(ranked[0]!.intelligence).toBe(96.5);
    expect(ranked[1]!.intelligence).toBe(50);
  });

  it('a measured LOW arenaScore still ranks BELOW the neutral default — same contract as agenticIndex', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'weak', model: 'bottom-of-the-board', accessClass: 'free-tier', estimatedCostPerMTok: 0, arenaScore: 4.2 },
      { provider: 'unbenchmarked', model: 'whatever', accessClass: 'free-tier', estimatedCostPerMTok: 0 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.candidate.provider).toBe('unbenchmarked');
    expect(ranked[1]!.intelligence).toBe(4.2);
  });

  it('WEIGHTS the agentic measurement above arena without discarding arena', () => {
    // A model can be crowd-favorite (high arena Elo) yet measure poorly on real
    // agentic tasks — the router dispatches agent loops, so the agentic number
    // must LEAD. It used to win outright and arena was thrown away entirely;
    // both are real measurements of the same question, so both now count, 2:1.
    // See ai-evidence.ts: better evidence earns more weight, never a veto.
    const candidates: AiRouterCandidate[] = [
      { provider: 'both', model: 'm', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 41, arenaScore: 93 },
      { provider: 'arena-only', model: 'm', accessClass: 'subscription', estimatedCostPerMTok: null, arenaScore: 60 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    const both = ranked.find((s) => s.candidate.provider === 'both')!;
    const arenaOnly = ranked.find((s) => s.candidate.provider === 'arena-only')!;
    // (41*2 + 93*1) / 3 — the agentic number dominates but arena still moves it.
    expect(both.intelligence).toBeCloseTo(58.333, 2);
    expect(both.intelligence).toBeGreaterThan(41); // arena was NOT discarded
    expect(both.intelligence).toBeLessThan(93); // agentic still leads
    expect(arenaOnly.intelligence).toBe(60);
  });

  it('trackRecordSuccessRate is CENTRED on the expected rate, not a pure penalty', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'unreliable', model: 'm', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 80, trackRecordSuccessRate: 0.4 },
      { provider: 'unproven', model: 'm', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 80 },
      { provider: 'excellent', model: 'm', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 80, trackRecordSuccessRate: 0.99 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    const get = (p: string) => ranked.find((s) => s.candidate.provider === p)!;
    // Confirmed-bad is still crushed — that half of the behaviour was correct.
    expect(get('unreliable').intelligence).toBeLessThan(50);
    // No record yet is NOT confirmed-bad: unadjusted, as before.
    expect(get('unproven').intelligence).toBe(80);
    // NEW, and the point: a measured 99% now BEATS having no record. It used to
    // lose to it, because every multiplier was <= 1 and absence skipped them —
    // so the platform demoted models for the crime of having been measured.
    expect(get('excellent').intelligence).toBeGreaterThan(80);
    expect(ranked[0]!.candidate.provider).toBe('excellent');
    expect(ranked[ranked.length - 1]!.candidate.provider).toBe('unreliable');
  });

  it('composes both signals: the benchmark is the base, the record is the multiplier', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'c', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, trackRecordSuccessRate: 0.5 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    // 0.5 is well below the 0.9 expectation, so capability is discounted from 80.
    expect(ranked[0]!.intelligence).toBeLessThan(80);
    expect(ranked[0]!.intelligence).toBeGreaterThan(0);
  });

  it('applies the record against the neutral default when there is no benchmark', () => {
    const atExpectation: AiRouterCandidate[] = [
      { provider: 'as-expected', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, trackRecordSuccessRate: 0.9 },
    ];
    // Exactly the expected rate == no adjustment == the neutral 50. This is the
    // equivalence the old shape broke: "measured and normal" now scores the same
    // as "never measured", instead of strictly worse.
    expect(rankRouterCandidatesWithScores(atExpectation, 'frontier')[0]!.intelligence).toBeCloseTo(50, 6);
  });
});

describe('capabilityRefusalCount — a NUDGE against real observed "I can\'t do that" hallucinations, never a ban', () => {
  it('a single observed refusal costs 15% of capability, not more', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'once-refused', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, capabilityRefusalCount: 1 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.intelligence).toBeCloseTo(68, 5); // 80 * 0.85
  });

  it('the penalty is FLOORED at a 60% total cut, however many refusals accumulate', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'many-refusals', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, capabilityRefusalCount: 20 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    expect(ranked[0]!.intelligence).toBeCloseTo(32, 5); // 80 * 0.4 floor, never lower
  });

  it('zero or absent refusal count leaves capability unpenalized — absence is not evidence', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'clean-explicit-zero', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, capabilityRefusalCount: 0 },
      { provider: 'clean-absent', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    for (const s of ranked) expect(s.intelligence).toBe(80);
  });

  it('composes with trackRecordSuccessRate as a second, independent multiplier', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'both-signals', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, trackRecordSuccessRate: 0.5, capabilityRefusalCount: 2 },
      { provider: 'clean-record', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0, agenticIndex: 80, trackRecordSuccessRate: 0.5 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'frontier');
    const get = (p: string) => ranked.find((s) => s.candidate.provider === p)!;
    // The refusal discount is INDEPENDENT of the record discount: with the same
    // 0.5 rate, observed refusals must cost strictly more. Asserted as a relation
    // rather than an exact product so the two factors can be tuned separately
    // without this test becoming a transcription of the arithmetic.
    expect(get('both-signals').intelligence).toBeLessThan(get('clean-record').intelligence);
    expect(ranked[0]!.candidate.provider).toBe('clean-record');
  });
});

describe('external endpoint-health priors — seed the blanks, never displace first-party evidence', () => {
  it('uses externalLatencyMs in place of the neutral 3s ONLY when our own EWMA is absent', () => {
    // Identical candidates except: one has a measured external TTFT, the
    // other has nothing. With no first-party latency anywhere, the external
    // prior (200ms vs neutral 3000ms) must decide the auto-mode ranking.
    const candidates: AiRouterCandidate[] = [
      { provider: 'a', model: 'model-with-prior', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, externalLatencyMs: 200 },
      { provider: 'b', model: 'model-without', accessClass: 'free-tier', estimatedCostPerMTok: 0.1 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.candidate.model).toBe('model-with-prior');
    expect(ranked[0]!.latencyMs).toBe(200);
    // The blank candidate still scores the neutral constant, not zero.
    expect(ranked[1]!.latencyMs).toBe(3000);
  });

  it('our own EWMA LEADS the external prior without silencing it', () => {
    // Was: "always wins ... the prior must be ignored entirely". A single
    // first-party sample used to veto a feed built from thousands of
    // observations. It now leads by weight (2:1) — the genuinely
    // first-party-faster sibling still ranks first, but the rosy 100ms prior
    // does move the slow pair's score instead of being discarded.
    const candidates: AiRouterCandidate[] = [
      { provider: 'a', model: 'own-slow-ext-fast', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, avgLatencyMs: 2500, externalLatencyMs: 100 },
      { provider: 'b', model: 'own-fast', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, avgLatencyMs: 800 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.candidate.model).toBe('own-fast');
    const slow = ranked.find((s) => s.candidate.model === 'own-slow-ext-fast')!;
    // (2500*2 + 100*1) / 3 — between the two readings, nearer ours.
    expect(slow.latencyMs).toBeCloseTo(1700, 0);
    expect(slow.latencyMs).toBeLessThan(2500); // the feed was heard
    expect(slow.latencyMs).toBeGreaterThan(100); // but did not take over
  });

  it('low external uptime deprioritizes a pair we have NO track record for', () => {
    // 44% measured uptime_last_1d (a real value observed live on the feed)
    // vs an identical sibling with no uptime data: the flapping endpoint
    // must rank below it in auto mode.
    const candidates: AiRouterCandidate[] = [
      { provider: 'flapping', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, externalUptime: 44 },
      { provider: 'unknown-health', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.candidate.provider).toBe('unknown-health');
    expect(ranked[0]!.intelligence).toBeGreaterThan(ranked[1]!.intelligence);
  });

  it('uptime at/above the 90% threshold changes nothing — healthy variance is not a signal', () => {
    const candidates: AiRouterCandidate[] = [
      { provider: 'a', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, externalUptime: 97 },
      { provider: 'b', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.intelligence).toBe(ranked[1]!.intelligence);
  });

  it('external uptime still counts for a pair we DO have a track record for', () => {
    // Was: "supersedes the prior entirely", asserting the two tie. That gate
    // (`trackRecordSuccessRate == null`) meant a vendor endpoint flapping at 44%
    // could not lower a model whose handful of first-party calls happened to
    // land. Both are real measurements of reliability, so both count.
    const candidates: AiRouterCandidate[] = [
      { provider: 'proven', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, trackRecordSuccessRate: 1, externalUptime: 44 },
      { provider: 'also-proven', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, trackRecordSuccessRate: 1 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.candidate.provider).toBe('also-proven');
    expect(ranked[0]!.intelligence).toBeGreaterThan(ranked[1]!.intelligence);
  });

  it('the uptime discount is floored — a deprioritization, never a ban', () => {
    // 0% uptime must still leave half the capability score standing (the
    // 0.5 floor), not zero the candidate out of existence.
    const candidates: AiRouterCandidate[] = [
      { provider: 'dead-at-aggregator', model: 'm', accessClass: 'free-tier', estimatedCostPerMTok: 0.1, agenticIndex: 60, externalUptime: 0 },
    ];
    const ranked = rankRouterCandidatesWithScores(candidates, 'auto');
    expect(ranked[0]!.intelligence).toBe(30); // 60 × 0.5 floor
  });
});
